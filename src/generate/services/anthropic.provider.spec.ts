import { ConfigService } from '@nestjs/config';
import { AnthropicProvider } from './anthropic.provider';
import { MediaFetcher, type FetchedMedia } from './media-fetcher';
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

/** Captures the JSON body POSTed to the Anthropic API. */
function mockAnthropicFetch() {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-sonnet-4-5-20250929',
      usage: { input_tokens: 5, output_tokens: 7 },
    }),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function bodyOf(fetchFn: jest.Mock): any {
  return JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body);
}

describe('AnthropicProvider (multimodal)', () => {
  const realFetch = global.fetch;
  let fetcher: jest.Mocked<MediaFetcher>;

  beforeEach(() => {
    fetcher = { fetchAll: jest.fn() } as unknown as jest.Mocked<MediaFetcher>;
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  function provider() {
    return new AnthropicProvider(
      configWith({ ANTHROPIC_API_KEY: 'test-key' }),
      mockLogger as never,
      mockMetrics(),
      fetcher,
    );
  }

  it('sends a plain string content when there is no media (unchanged path)', async () => {
    const fetchFn = mockAnthropicFetch();
    await provider().generate({ systemPrompt: 'sys', userPrompt: 'hi' });

    expect(fetcher.fetchAll).not.toHaveBeenCalled();
    expect(bodyOf(fetchFn).messages[0].content).toBe('hi');
  });

  it('builds document/image content blocks followed by the text when media is present', async () => {
    const fetched: FetchedMedia[] = [
      { kind: 'document', mediaType: 'application/pdf', base64: 'UERG' },
      { kind: 'image', mediaType: 'image/png', base64: 'UE5H' },
    ];
    fetcher.fetchAll.mockResolvedValue(fetched);
    const fetchFn = mockAnthropicFetch();

    await provider().generate({
      systemPrompt: 'sys',
      userPrompt: 'analyze these',
      media: [
        { url: 'http://files/a.pdf', kind: 'document', mediaType: 'application/pdf' },
        { url: 'http://files/b.png', kind: 'image', mediaType: 'image/png' },
      ],
    });

    const content = bodyOf(fetchFn).messages[0].content;
    expect(content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      { type: 'text', text: 'analyze these' },
    ]);
  });
});
