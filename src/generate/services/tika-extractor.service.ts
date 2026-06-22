import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import type { FetchedMedia } from './media-fetcher';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Extracts plain text from fetched media via an Apache Tika server.
 *
 * Tika is the same extraction engine Solr/Tika uses platform-wide and handles
 * PDF, Office (docx/xlsx/pptx), HTML, RTF, etc. The gateway owns its own Tika
 * instance (TIKA_URL) — it never reaches into another service's infrastructure.
 *
 * `text/*` is decoded locally to avoid a network hop. Images have no extractable
 * text (no OCR) and return '' — callers should skip them.
 */
@Injectable()
export class TikaExtractor {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(TikaExtractor.name) private readonly logger: PinoLogger,
  ) {
    this.baseUrl = this.config.get('TIKA_URL', 'http://tika:9998').replace(/\/+$/, '');
    this.timeoutMs = Number(this.config.get('TIKA_TIMEOUT_MS', DEFAULT_TIMEOUT_MS));

    this.breaker = createCircuitBreaker({
      maxRetries: 2,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) => this.logger.warn({ state }, 'Tika circuit breaker state change'),
    });
  }

  async extract(m: FetchedMedia): Promise<string> {
    const type = m.mediaType.toLowerCase();

    // Plain text needs no extraction — decode directly, skip the network hop.
    if (type.startsWith('text/')) {
      return Buffer.from(m.base64, 'base64').toString('utf8');
    }

    // Images carry no extractable text (Tika has no OCR here) — skip.
    if (type.startsWith('image/')) {
      this.logger.warn({ mediaType: m.mediaType }, 'Skipping image — no text to extract');
      return '';
    }

    return this.breaker.execute(() => this.callTika(m));
  }

  private async callTika(m: FetchedMedia): Promise<string> {
    const buffer = Buffer.from(m.base64, 'base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/tika`, {
        method: 'PUT',
        headers: { Accept: 'text/plain', 'Content-Type': m.mediaType },
        body: new Uint8Array(buffer),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = (await response.text()).substring(0, 300);
      this.logger.error({ status: response.status, body, mediaType: m.mediaType }, 'Tika extraction failed');
      throw new Error(`Tika request failed: ${response.status}`);
    }

    return (await response.text()).trim();
  }
}
