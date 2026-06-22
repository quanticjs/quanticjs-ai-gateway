import { ConfigService } from '@nestjs/config';
import { OpenAiGenerationProvider } from './openai.provider';
import { MediaFetcher, type FetchedMedia } from './media-fetcher';
import { TikaExtractor } from './tika-extractor.service';
import { GenerateMetrics } from '../generate.metrics';

const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, def?: unknown) => (key in overrides ? overrides[key] : def),
  } as unknown as ConfigService;
}

function mockMetrics(): GenerateMetrics {
  return {
    requestsTotal: { inc: jest.fn() },
    requestDuration: { observe: jest.fn() },
    tokensTotal: { inc: jest.fn() },
    costDollars: { inc: jest.fn() },
    circuitBreakerState: { set: jest.fn() },
  } as unknown as GenerateMetrics;
}

/** A successful Chat Completions response. */
function okResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'gpt-4.1',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 23 },
      ...over,
    }),
    text: async () => '',
  };
}

function bodyOf(fetchFn: jest.Mock, call = 0): any {
  return JSON.parse((fetchFn.mock.calls[call][1] as { body: string }).body);
}
function urlOf(fetchFn: jest.Mock, call = 0): string {
  return fetchFn.mock.calls[call][0] as string;
}
function headersOf(fetchFn: jest.Mock, call = 0): Record<string, string> {
  return (fetchFn.mock.calls[call][1] as { headers: Record<string, string> }).headers;
}

const AZURE_BASE = 'https://my-resource.openai.azure.com';
const OPENAI_BASE = 'https://api.openai.com/v1';

describe('OpenAiGenerationProvider', () => {
  const realFetch = global.fetch;
  let fetcher: jest.Mocked<MediaFetcher>;
  let tika: jest.Mocked<TikaExtractor>;
  let metrics: GenerateMetrics;

  beforeEach(() => {
    fetcher = { fetchAll: jest.fn() } as unknown as jest.Mocked<MediaFetcher>;
    tika = { extract: jest.fn() } as unknown as jest.Mocked<TikaExtractor>;
    metrics = mockMetrics();
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function provider(cfg: Record<string, unknown>) {
    return new OpenAiGenerationProvider(
      configWith(cfg),
      mockLogger as never,
      metrics,
      fetcher,
      tika,
    );
  }

  // ── Azure (primary) success ──────────────────────────────────────────────
  it('Azure: routes to the deployment URL with api-key header, omits model, maps response', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchFn as unknown as typeof fetch;

    const res = await provider({
      OPENAI_API_KEY: 'azkey',
      OPENAI_BASE_URL: AZURE_BASE,
      AZURE_OPENAI_GEN_DEPLOYMENT: 'gpt41-deploy',
    }).generate({ systemPrompt: 'sys', userPrompt: 'hi' });

    expect(urlOf(fetchFn)).toBe(
      `${AZURE_BASE}/openai/deployments/gpt41-deploy/chat/completions?api-version=2024-10-21`,
    );
    expect(headersOf(fetchFn)['api-key']).toBe('azkey');
    expect(headersOf(fetchFn).Authorization).toBeUndefined();

    const body = bodyOf(fetchFn);
    expect(body.model).toBeUndefined(); // deployment-routed
    expect(body.max_tokens).toBeDefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);

    expect(res.content).toBe('hello');
    expect(res.model).toBe('gpt-4.1');
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(23);
    expect(res.costUsd).toBeGreaterThan(0); // gpt-4.1 priced
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Direct OpenAI success ────────────────────────────────────────────────
  it('OpenAI: Bearer header, /chat/completions URL, includes model in body', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchFn as unknown as typeof fetch;

    await provider({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'sys',
      userPrompt: 'hi',
    });

    expect(urlOf(fetchFn)).toBe(`${OPENAI_BASE}/chat/completions`);
    expect(headersOf(fetchFn).Authorization).toBe('Bearer sk-test');
    expect(headersOf(fetchFn)['api-key']).toBeUndefined();
    expect(bodyOf(fetchFn).model).toBe('gpt-4.1');
  });

  // ── Structured output ────────────────────────────────────────────────────
  it('sends response_format json_schema with strict:true by default', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchFn as unknown as typeof fetch;
    const schema = { type: 'object', properties: { a: { type: 'string' } } };

    await provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'sys',
      userPrompt: 'hi',
      jsonSchema: schema,
    });

    expect(bodyOf(fetchFn).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'structured_output', strict: true, schema },
    });
  });

  it('honours OPENAI_STRUCTURED_STRICT=false', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchFn as unknown as typeof fetch;

    await provider({
      OPENAI_API_KEY: 'sk',
      OPENAI_BASE_URL: OPENAI_BASE,
      OPENAI_STRUCTURED_STRICT: 'false',
    }).generate({ systemPrompt: 'sys', userPrompt: 'hi', jsonSchema: { type: 'object' } });

    expect(bodyOf(fetchFn).response_format.json_schema.strict).toBe(false);
  });

  // ── Media inlining (Tika) ────────────────────────────────────────────────
  it('inlines Tika-extracted document text and skips media with no text', async () => {
    const fetched: FetchedMedia[] = [
      { kind: 'document', mediaType: 'application/pdf', base64: 'UERG', fileName: 'spec.pdf' },
      { kind: 'image', mediaType: 'image/png', base64: 'UE5H', fileName: 'shot.png' },
    ];
    fetcher.fetchAll.mockResolvedValue(fetched);
    tika.extract
      .mockResolvedValueOnce('EXTRACTED PDF TEXT') // document
      .mockResolvedValueOnce(''); // image — no text, skipped
    const fetchFn = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchFn as unknown as typeof fetch;

    await provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'sys',
      userPrompt: 'analyze',
      media: [
        { url: 'http://files/a.pdf', kind: 'document', mediaType: 'application/pdf', fileName: 'spec.pdf' },
        { url: 'http://files/b.png', kind: 'image', mediaType: 'image/png', fileName: 'shot.png' },
      ],
    });

    expect(fetcher.fetchAll).toHaveBeenCalledTimes(1);
    expect(tika.extract).toHaveBeenCalledTimes(2);
    const userMsg = bodyOf(fetchFn).messages[1].content as string;
    expect(userMsg).toContain('analyze');
    expect(userMsg).toContain('<attachment name="spec.pdf" type="application/pdf">');
    expect(userMsg).toContain('EXTRACTED PDF TEXT');
    expect(userMsg).not.toContain('shot.png'); // empty extraction skipped
  });

  // ── Cost mapping ─────────────────────────────────────────────────────────
  it('reports costUsd 0 for an unknown model (no throw)', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(okResponse({ model: 'some-unlisted-model' }));
    global.fetch = fetchFn as unknown as typeof fetch;

    const res = await provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'sys',
      userPrompt: 'hi',
    });
    expect(res.costUsd).toBe(0);
    expect(res.model).toBe('some-unlisted-model');
  });

  // ── Config fail-fast ─────────────────────────────────────────────────────
  it('rejects when OPENAI_API_KEY is missing', async () => {
    const fetchFn = jest.fn();
    global.fetch = fetchFn as unknown as typeof fetch;
    await expect(
      provider({ OPENAI_API_KEY: '', OPENAI_BASE_URL: OPENAI_BASE }).generate({
        systemPrompt: 'sys',
        userPrompt: 'hi',
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects on the Azure path when the deployment is missing', async () => {
    const fetchFn = jest.fn();
    global.fetch = fetchFn as unknown as typeof fetch;
    await expect(
      provider({
        OPENAI_API_KEY: 'azkey',
        OPENAI_BASE_URL: AZURE_BASE,
        AZURE_OPENAI_GEN_DEPLOYMENT: '',
      }).generate({ systemPrompt: 'sys', userPrompt: 'hi' }),
    ).rejects.toThrow(/AZURE_OPENAI_GEN_DEPLOYMENT/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // ── 4xx is deterministic — never retried ─────────────────────────────────
  it('does NOT retry a 4xx response (fetch called exactly once)', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
      json: async () => ({}),
    });
    global.fetch = fetchFn as unknown as typeof fetch;

    await expect(
      provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
        systemPrompt: 'sys',
        userPrompt: 'hi',
      }),
    ).rejects.toThrow(/OpenAI API returned 400/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('Azure 400 with a schema names the minimum api-version', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'unsupported response_format',
      json: async () => ({}),
    });
    global.fetch = fetchFn as unknown as typeof fetch;

    await expect(
      provider({
        OPENAI_API_KEY: 'azkey',
        OPENAI_BASE_URL: AZURE_BASE,
        AZURE_OPENAI_GEN_DEPLOYMENT: 'd',
        AZURE_OPENAI_API_VERSION: '2024-02-01',
      }).generate({ systemPrompt: 'sys', userPrompt: 'hi', jsonSchema: { type: 'object' } }),
    ).rejects.toThrow(/2024-08-01-preview/);
  });

  // ── 5xx opens the breaker (short-circuits) + gauge wired for "openai" ─────
  it('opens the breaker on repeated 5xx so later calls fast-fail, and wires the gauge for "openai"', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
      json: async () => ({}),
    });
    global.fetch = fetchFn as unknown as typeof fetch;

    const p = provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE });
    const CALLS = 8;
    for (let i = 0; i < CALLS; i++) {
      await p.generate({ systemPrompt: 'sys', userPrompt: 'hi' }).catch(() => undefined);
    }
    // Breaker opened: once open, calls fast-fail WITHOUT hitting the network — strictly fewer
    // fetches than generate() calls. (Proves 5xx tripped the circuit, not retried forever.)
    expect(fetchFn.mock.calls.length).toBeLessThan(CALLS);
    // The circuit-breaker gauge is wired for this provider.
    expect(metrics.circuitBreakerState.set as jest.Mock).toHaveBeenCalledWith(
      { provider: 'openai' },
      expect.any(Number),
    );
  }, 30_000);

  // ── Timeout signal ───────────────────────────────────────────────────────
  it('passes an AbortSignal (explicit timeout) to fetch', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchFn as unknown as typeof fetch;

    await provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'sys',
      userPrompt: 'hi',
    });
    const opts = fetchFn.mock.calls[0][1] as { signal?: unknown };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  // ── Refusal ──────────────────────────────────────────────────────────────
  it('rejects when the model returns a refusal (not returned as content)', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }] }),
    );
    global.fetch = fetchFn as unknown as typeof fetch;

    await expect(
      provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
        systemPrompt: 'sys',
        userPrompt: 'hi',
      }),
    ).rejects.toThrow(/refus/i);
  });

  // ── Truncation ───────────────────────────────────────────────────────────
  it('returns content but warns on truncation (finish_reason length)', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }),
    );
    global.fetch = fetchFn as unknown as typeof fetch;

    const res = await provider({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'sys',
      userPrompt: 'hi',
    });
    expect(res.content).toBe('partial');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: 'length' }),
      expect.stringMatching(/truncat/i),
    );
  });

  // ── Logging boundary ─────────────────────────────────────────────────────
  it('never logs prompt/response content or the API key', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: 'SECRET RESPONSE' }, finish_reason: 'stop' }] }));
    global.fetch = fetchFn as unknown as typeof fetch;

    await provider({ OPENAI_API_KEY: 'super-secret-key', OPENAI_BASE_URL: OPENAI_BASE }).generate({
      systemPrompt: 'SENSITIVE SYSTEM PROMPT',
      userPrompt: 'SENSITIVE USER PROMPT',
    });

    const logged = JSON.stringify([
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
      ...mockLogger.debug.mock.calls,
    ]);
    expect(logged).not.toContain('super-secret-key');
    expect(logged).not.toContain('SENSITIVE SYSTEM PROMPT');
    expect(logged).not.toContain('SENSITIVE USER PROMPT');
    expect(logged).not.toContain('SECRET RESPONSE');
    // metadata IS logged
    expect(logged).toContain('promptLength');
  });
});
