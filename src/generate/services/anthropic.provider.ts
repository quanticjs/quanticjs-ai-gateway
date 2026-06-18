import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import type { AiProvider, AiGenerateRequest, AiGenerateResponse } from './ai-provider.interface';
import { MediaFetcher, toAnthropicContentBlock } from './media-fetcher';
import { GenerateMetrics } from '../generate.metrics';

const BREAKER_STATE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
};

@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic-api';

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(AnthropicProvider.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
    private readonly mediaFetcher: MediaFetcher,
  ) {
    this.apiKey = this.config.get('ANTHROPIC_API_KEY', '');
    this.defaultModel = this.config.get('AI_MODEL', 'claude-sonnet-4-5-20250929');

    if (!this.apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AnthropicProvider will fail on generate calls');
    }

    this.breaker = createCircuitBreaker({
      maxRetries: 2,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) =>
        this.metrics.circuitBreakerState.set({ provider: 'anthropic-api' }, BREAKER_STATE[state] ?? 0),
    });
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    return this.breaker.execute(() => this.callApi(request));
  }

  private async callApi(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
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
      'Starting Anthropic API call',
    );

    const userContent: unknown = fetched.length
      ? [...fetched.map((m) => toAnthropicContentBlock(m)), { type: 'text', text: request.userPrompt }]
      : request.userPrompt;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    };

    if (request.jsonSchema) {
      body.tools = [{
        name: 'structured_output',
        description: 'Return the result in the required JSON schema',
        input_schema: request.jsonSchema,
      }];
      body.tool_choice = { type: 'tool', name: 'structured_output' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error({ status: response.status, body: errorBody.substring(0, 300) }, 'Anthropic API call failed');
      throw new Error(`Anthropic API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string; input?: unknown }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    let content = '';
    if (request.jsonSchema) {
      const toolBlock = data.content.find((b) => b.type === 'tool_use');
      content = toolBlock?.input ? JSON.stringify(toolBlock.input) : '';
    } else {
      content = data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }

    const inputTokens = data.usage.input_tokens;
    const outputTokens = data.usage.output_tokens;
    const pricing = MODEL_PRICING[data.model] ?? { input: 3, output: 15 };
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    const durationMs = Date.now() - startTime;

    this.logger.info({ model: data.model, inputTokens, outputTokens, costUsd, durationMs }, 'Anthropic API call complete');

    return { content, model: data.model, inputTokens, outputTokens, costUsd, durationMs };
  }
}
