import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import type { AiProvider, AiGenerateRequest, AiGenerateResponse } from './ai-provider.interface';
import { MediaFetcher } from './media-fetcher';
import { TikaExtractor } from './tika-extractor.service';
import { GenerateMetrics } from '../generate.metrics';

const BREAKER_STATE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

// USD per 1,000,000 tokens. List prices for direct OpenAI.
// NOTE: on the Azure path `costUsd` is an *estimate* using these OpenAI list prices —
// Azure bills under its own/enterprise pricing, so the reported cost will not match the
// Azure invoice. Unknown models report cost 0 (see callApi).
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string | null; refusal?: string | null };
    finish_reason: string;
  }>;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * OpenAI / Azure OpenAI generation provider (Chat Completions API).
 *
 * Azure OpenAI is the PRIMARY path (api-key header + deployment routing); direct OpenAI is
 * the secondary path (Bearer + model-in-body). Both share one request/response shape.
 * Chat Completions is used (not the Responses API) because it is GA on Azure, while Azure's
 * `/responses` is preview/region-gated. Media is Tika-extracted and inlined as text (mirrors
 * `SdkProvider`), so no native multimodal blocks are needed.
 */
@Injectable()
export class OpenAiGenerationProvider implements AiProvider {
  readonly name = 'openai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly isAzure: boolean;
  private readonly azureDeployment: string;
  private readonly azureApiVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly structuredStrict: boolean;
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(OpenAiGenerationProvider.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
    private readonly mediaFetcher: MediaFetcher,
    private readonly tika: TikaExtractor,
  ) {
    this.apiKey = this.config.get('OPENAI_API_KEY', '');
    // Trailing slash trimmed so URL joins are predictable for both dialects.
    this.baseUrl = this.config
      .get('OPENAI_BASE_URL', 'https://api.openai.com/v1')
      .replace(/\/+$/, '');
    this.defaultModel = this.config.get('OPENAI_GENERATION_MODEL', 'gpt-4.1');

    // Azure speaks a different dialect: api-key header + /openai/deployments/{name}
    // /chat/completions?api-version=... Auto-detected from the host, overridable via OPENAI_API_TYPE.
    const apiType = this.config.get('OPENAI_API_TYPE', '');
    this.isAzure = apiType === 'azure' || /\.azure\.com/i.test(this.baseUrl);
    // Azure routes by deployment name, which often (but not always) matches the model name.
    this.azureDeployment = this.config.get('AZURE_OPENAI_GEN_DEPLOYMENT', this.defaultModel);
    // GA 2024-10-21 supports Chat Completions response_format: json_schema structured outputs.
    this.azureApiVersion = this.config.get('AZURE_OPENAI_API_VERSION', '2024-10-21');

    this.requestTimeoutMs = Number(this.config.get('OPENAI_REQUEST_TIMEOUT_MS', 600_000));
    this.structuredStrict =
      String(this.config.get('OPENAI_STRUCTURED_STRICT', 'true')) !== 'false';

    if (!this.apiKey) {
      this.logger.warn('OPENAI_API_KEY not set — OpenAiGenerationProvider will fail on generate calls');
    }

    this.breaker = createCircuitBreaker({
      maxRetries: 2,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) =>
        this.metrics.circuitBreakerState.set({ provider: 'openai' }, BREAKER_STATE[state] ?? 0),
    });
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    if (this.isAzure && !this.azureDeployment) {
      throw new Error('AZURE_OPENAI_GEN_DEPLOYMENT is required for the Azure generation path');
    }

    const model = request.model ?? this.defaultModel;
    const maxTokens = request.maxTokens || 8192;
    const startTime = Date.now();

    const fetched = request.media?.length ? await this.mediaFetcher.fetchAll(request.media) : [];

    this.logger.info(
      {
        promptLength: request.userPrompt.length,
        model,
        hasSchema: !!request.jsonSchema,
        mediaCount: fetched.length,
      },
      'Starting OpenAI generation',
    );

    // Tika-extract each fetched file and inline its text — identical to SdkProvider. Images
    // yield no text and are skipped. (No native multimodal blocks; text-only prompt path.)
    let userPrompt = request.userPrompt;
    if (fetched.length) {
      const extracted = await Promise.all(
        fetched.map(async (m) => ({ media: m, text: await this.tika.extract(m) })),
      );
      const attachments = extracted
        .filter(({ text }) => text.length > 0)
        .map(({ media, text }) => {
          const name = media.fileName ?? 'attachment';
          return `\n\n<attachment name="${name}" type="${media.mediaType}">\n${text}\n</attachment>`;
        });
      userPrompt = `${userPrompt}${attachments.join('')}`;
    }

    const body: Record<string, unknown> = {
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    // Azure routes by deployment in the URL, so `model` is omitted from the body there.
    if (!this.isAzure) {
      body.model = model;
    }

    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          strict: this.structuredStrict,
          schema: request.jsonSchema,
        },
      };
    }

    const { url, headers } = this.endpoint();

    // Only network/timeout and 5xx errors propagate into the retrying breaker; 4xx responses are
    // returned and handled below WITHOUT retry (deterministic client errors must never be retried,
    // and createCircuitBreaker retries every thrown error).
    const response = await this.breaker.execute(() => this.callChat(url, headers, body));

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        { status: response.status, body: errorBody.substring(0, 300) },
        'OpenAI API call failed',
      );
      // Azure + structured output on an api-version that predates json_schema returns 400.
      if (this.isAzure && request.jsonSchema && response.status === 400) {
        throw new Error(
          `OpenAI API returned 400 — Azure structured outputs (response_format: json_schema) require ` +
            `AZURE_OPENAI_API_VERSION >= 2024-08-01-preview (GA 2024-10-21); current is ${this.azureApiVersion}`,
        );
      }
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];

    if (choice?.message?.refusal) {
      this.logger.warn({ model: data.model ?? model }, 'OpenAI returned a refusal');
      throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
    }

    const content = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'length') {
      this.logger.warn(
        { model: data.model ?? model, finishReason: choice.finish_reason, contentLength: content.length },
        'OpenAI output truncated (max_tokens hit) — document may be incomplete',
      );
    }

    const respModel = data.model ?? model;
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    const pricing = MODEL_PRICING[respModel];
    if (!pricing) {
      this.logger.debug({ model: respModel }, 'No pricing for model — reporting costUsd 0');
    }
    const costUsd = pricing
      ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
      : 0;
    const durationMs = Date.now() - startTime;

    this.logger.info(
      { model: respModel, inputTokens, outputTokens, costUsd, durationMs },
      'OpenAI generation complete',
    );

    return { content, model: respModel, inputTokens, outputTokens, costUsd, durationMs };
  }

  /**
   * Breaker-wrapped network call. Throws on network/timeout and 5xx (so the breaker retries those
   * and counts them toward opening); returns 2xx AND 4xx responses unthrown so 4xx is NOT retried.
   * Explicit timeout via AbortSignal.timeout — generation is long-running but never hangs.
   */
  private async callChat(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ timeoutMs: this.requestTimeoutMs, reason }, 'OpenAI request failed/timed out');
      throw err;
    }
    if (res.status >= 500) {
      const errorBody = await res.text();
      this.logger.error(
        { status: res.status, body: errorBody.substring(0, 300) },
        'OpenAI API call failed (5xx)',
      );
      throw new Error(`OpenAI API returned ${res.status}`);
    }
    return res;
  }

  /** Builds the dialect-specific URL + auth header. */
  private endpoint(): { url: string; headers: Record<string, string> } {
    if (this.isAzure) {
      return {
        url: `${this.baseUrl}/openai/deployments/${this.azureDeployment}/chat/completions?api-version=${this.azureApiVersion}`,
        headers: { 'api-key': this.apiKey },
      };
    }
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
    };
  }
}
