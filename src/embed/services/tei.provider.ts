import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import type { EmbeddingProvider, EmbedResponse } from './embedding-provider.interface';
import { EmbedMetrics } from '../embed.metrics';

const BREAKER_STATE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

@Injectable()
export class TeiProvider implements EmbeddingProvider {
  readonly name = 'tei';

  private readonly baseUrl: string;
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(TeiProvider.name) private readonly logger: PinoLogger,
    private readonly metrics: EmbedMetrics,
  ) {
    this.baseUrl = this.config.get('TEI_URL', 'http://text-embeddings:8080');

    this.breaker = createCircuitBreaker({
      maxRetries: 2,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) =>
        this.metrics.circuitBreakerState.set({ provider: 'tei' }, BREAKER_STATE[state] ?? 0),
    });
  }

  async embed(inputs: string[]): Promise<EmbedResponse> {
    return this.breaker.execute(() => this.callTei(inputs));
  }

  private async callTei(inputs: string[]): Promise<EmbedResponse> {
    const startTime = Date.now();
    this.logger.info({ inputCount: inputs.length }, 'Starting TEI embedding request');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60 * 1000);

    const response = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text();
      this.logger.error({ status: response.status, body: body.substring(0, 300) }, 'TEI embedding request failed');
      throw new Error(`TEI request failed: ${response.status}`);
    }

    const embeddings: number[][] = await response.json();
    const dimensions = embeddings[0]?.length ?? 0;
    const durationMs = Date.now() - startTime;

    this.logger.info({ inputCount: inputs.length, dimensions, durationMs }, 'TEI embedding complete');

    return { embeddings, model: 'tei', dimensions };
  }
}
