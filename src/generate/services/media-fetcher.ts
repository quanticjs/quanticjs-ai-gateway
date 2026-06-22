import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { AiMediaRef } from './ai-provider.interface';

export interface FetchedMedia {
  kind: AiMediaRef['kind'];
  mediaType: string;
  base64: string;
  fileName?: string;
}

/**
 * Maps fetched media to an Anthropic content block with a base64 source.
 * Shared by the raw Messages API provider and the Agent SDK provider — both
 * use the same `MessageParam` content-block shape.
 */
export function toAnthropicContentBlock(m: FetchedMedia): Record<string, unknown> {
  return {
    type: m.kind, // 'image' | 'document'
    source: { type: 'base64', media_type: m.mediaType, data: m.base64 },
  };
}

/**
 * Extracts plain text from fetched media for providers that cannot ingest inline
 * media content blocks (the Agent SDK / Claude Code subprocess). `text/*` is
 * decoded directly; PDFs are parsed with `pdf-parse`. Images are unsupported
 * (no OCR) and throw — callers must filter them out first.
 */
export async function extractMediaText(m: FetchedMedia): Promise<string> {
  const buffer = Buffer.from(m.base64, 'base64');
  const type = m.mediaType.toLowerCase();

  if (type.startsWith('text/')) {
    return buffer.toString('utf8');
  }

  if (type === 'application/pdf') {
    // Import the parser directly (the package root runs debug side-effects on load).
    // The specifier is a non-literal string so TS skips module-type resolution
    // (pdf-parse ships no types for this subpath).
    const spec: string = 'pdf-parse/lib/pdf-parse.js';
    const pdfParse = (await import(spec)).default as (
      data: Buffer,
    ) => Promise<{ text: string }>;
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }

  throw new Error(`Cannot extract text from media type: ${m.mediaType}`);
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — mirrors the conversation attachment cap
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fetches multimodal file content referenced by a presigned URL and returns it
 * base64-encoded for inclusion in an Anthropic content block. The gateway does
 * the fetch (not the caller) so callers never transmit bytes, and so internal
 * File Service URLs — which api.anthropic.com cannot reach — work.
 *
 * SSRF posture: this service performs outbound fetches against caller-supplied
 * URLs, so it enforces an optional host allowlist (MEDIA_FETCH_ALLOWED_HOSTS),
 * rejects non-http(s) schemes, and blocks the cloud metadata address. Always set
 * MEDIA_FETCH_ALLOWED_HOSTS in production to the File Service host(s).
 */
@Injectable()
export class MediaFetcher {
  private readonly allowedHosts: Set<string>;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(MediaFetcher.name) private readonly logger: PinoLogger,
  ) {
    const raw = this.config.get<string>('MEDIA_FETCH_ALLOWED_HOSTS', '');
    this.allowedHosts = new Set(
      raw
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
    this.maxBytes = Number(this.config.get('MEDIA_FETCH_MAX_BYTES', DEFAULT_MAX_BYTES));
    this.timeoutMs = Number(this.config.get('MEDIA_FETCH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS));

    if (this.allowedHosts.size === 0) {
      this.logger.warn(
        'MEDIA_FETCH_ALLOWED_HOSTS is not set — media URL fetching is unrestricted (dev only). Set it in production.',
      );
    }
  }

  async fetchAll(media: AiMediaRef[]): Promise<FetchedMedia[]> {
    return Promise.all(media.map((m) => this.fetchOne(m)));
  }

  private async fetchOne(ref: AiMediaRef): Promise<FetchedMedia> {
    this.assertUrlAllowed(ref.url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(ref.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`media fetch returned ${res.status}`);
      }

      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared && declared > this.maxBytes) {
        throw new Error(`media exceeds ${this.maxBytes} bytes (content-length ${declared})`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > this.maxBytes) {
        throw new Error(`media exceeds ${this.maxBytes} bytes (received ${buffer.byteLength})`);
      }

      return {
        kind: ref.kind,
        mediaType: ref.mediaType,
        base64: buffer.toString('base64'),
        fileName: ref.fileName,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertUrlAllowed(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('media url is not a valid URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`media url scheme not allowed: ${parsed.protocol}`);
    }

    // Block the cloud instance-metadata endpoint regardless of allowlist.
    if (parsed.hostname === '169.254.169.254') {
      throw new Error('media url host is blocked');
    }

    if (this.allowedHosts.size > 0) {
      const host = parsed.host.toLowerCase(); // host:port if a port is present
      const hostname = parsed.hostname.toLowerCase();
      if (!this.allowedHosts.has(host) && !this.allowedHosts.has(hostname)) {
        throw new Error(`media url host not in allowlist: ${host}`);
      }
    }
  }
}
