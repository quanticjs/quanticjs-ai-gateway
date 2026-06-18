import { ConfigService } from '@nestjs/config';
import { MediaFetcher, toAnthropicContentBlock } from './media-fetcher';
import type { AiMediaRef } from './ai-provider.interface';

const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

/** ConfigService stub honouring get(key, default). overrides win, else default. */
function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, def?: unknown) => (key in overrides ? overrides[key] : def),
  } as unknown as ConfigService;
}

function ref(over: Partial<AiMediaRef> = {}): AiMediaRef {
  return {
    url: 'http://files:9000/bucket/doc.pdf?sig=abc',
    kind: 'document',
    mediaType: 'application/pdf',
    ...over,
  };
}

describe('MediaFetcher', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function mockFetch(body: Buffer, headers: Record<string, string> = {}) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }) as unknown as typeof fetch;
  }

  it('fetches a URL and returns base64-encoded content', async () => {
    const bytes = Buffer.from('%PDF-1.7 hello');
    mockFetch(bytes);
    const fetcher = new MediaFetcher(configWith(), mockLogger as never);

    const out = (await fetcher.fetchAll([ref()]))[0]!;

    expect(out.base64).toBe(bytes.toString('base64'));
    expect(out.mediaType).toBe('application/pdf');
    expect(out.kind).toBe('document');
  });

  it('rejects a non-http(s) scheme', async () => {
    const fetcher = new MediaFetcher(configWith(), mockLogger as never);
    await expect(fetcher.fetchAll([ref({ url: 'file:///etc/passwd' })])).rejects.toThrow(/scheme/);
  });

  it('blocks the cloud metadata address', async () => {
    const fetcher = new MediaFetcher(configWith(), mockLogger as never);
    await expect(
      fetcher.fetchAll([ref({ url: 'http://169.254.169.254/latest/meta-data/' })]),
    ).rejects.toThrow(/blocked/);
  });

  it('enforces the host allowlist when set', async () => {
    mockFetch(Buffer.from('x'));
    const fetcher = new MediaFetcher(configWith({ MEDIA_FETCH_ALLOWED_HOSTS: 'files:9000' }), mockLogger as never);

    // Allowed host passes.
    await expect(fetcher.fetchAll([ref({ url: 'http://files:9000/a.pdf' })])).resolves.toHaveLength(1);
    // Disallowed host is rejected.
    await expect(fetcher.fetchAll([ref({ url: 'http://evil.example/a.pdf' })])).rejects.toThrow(/allowlist/);
  });

  it('rejects content larger than the max byte cap (declared content-length)', async () => {
    mockFetch(Buffer.from('small'), { 'content-length': String(20 * 1024 * 1024) });
    const fetcher = new MediaFetcher(configWith(), mockLogger as never);
    await expect(fetcher.fetchAll([ref()])).rejects.toThrow(/exceeds/);
  });

  it('rejects content larger than the cap after download (no content-length header)', async () => {
    mockFetch(Buffer.alloc(11 * 1024 * 1024, 1));
    const fetcher = new MediaFetcher(configWith(), mockLogger as never);
    await expect(fetcher.fetchAll([ref()])).rejects.toThrow(/exceeds/);
  });

  it('throws when the upstream returns a non-OK status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }) as unknown as typeof fetch;
    const fetcher = new MediaFetcher(configWith(), mockLogger as never);
    await expect(fetcher.fetchAll([ref()])).rejects.toThrow(/404/);
  });
});

describe('toAnthropicContentBlock', () => {
  it('maps a document to a base64 document block', () => {
    expect(toAnthropicContentBlock({ kind: 'document', mediaType: 'application/pdf', base64: 'QUJD' })).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
    });
  });

  it('maps an image to a base64 image block', () => {
    expect(toAnthropicContentBlock({ kind: 'image', mediaType: 'image/png', base64: 'QUJD' })).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
  });
});
