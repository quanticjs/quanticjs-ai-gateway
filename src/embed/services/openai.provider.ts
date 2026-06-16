import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import type { EmbeddingProvider, EmbedResponse } from './embedding-provider.interface';
import { EmbedMetrics } from '../embed.metrics';

const BREAKER_STATE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

@Injectable()
export class OpenAiProvider implements EmbeddingProvider {
  readonly name = 'openai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(OpenAiProvider.name) private readonly logger: PinoLogger,
    private readonly metrics: EmbedMetrics,
  ) {
    this.apiKey = this.config.get('OPENAI_API_KEY', '');
    this.baseUrl = this.config.get('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    this.model = this.config.get('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');

    if (!this.apiKey) {
      this.logger.warn('OPENAI_API_KEY not set — OpenAiProvider will fail on embed calls');
    }

    this.breaker = createCircuitBreaker({
      maxRetries: 2,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) =>
        this.metrics.circuitBreakerState.set({ provider: 'openai' }, BREAKER_STATE[state] ?? 0),
    });
  }

  async embed(inputs: string[]): Promise<EmbedResponse> {
    return this.breaker.execute(() => this.callOpenAi(inputs));
  }

  private async callOpenAi(inputs: string[]): Promise<EmbedResponse> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    const startTime = Date.now();
    this.logger.info({ inputCount: inputs.length, model: this.model }, 'Starting OpenAI embedding request');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60 * 1000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: inputs }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        { status: response.status, body: body.substring(0, 300) },
        'OpenAI embedding request failed',
      );
      throw new Error(`OpenAI request failed: ${response.status}`);
    }

    const data = (await response.json()) as OpenAiEmbeddingResponse;

    // OpenAI does not guarantee result ordering — sort by index to align with inputs.
    const embeddings = data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    const dimensions = embeddings[0]?.length ?? 0;
    const durationMs = Date.now() - startTime;

    this.logger.info(
      { inputCount: inputs.length, model: data.model, dimensions, durationMs },
      'OpenAI embedding complete',
    );

    return { embeddings, model: data.model, dimensions };
  }
}
