import { ConfigService } from '@nestjs/config';
import { OpenAiProvider } from './openai.provider';
import { EmbedMetrics } from '../embed.metrics';

// Assertions are derived from the OpenAI / Azure OpenAI REST contracts, NOT from the
// provider implementation:
//   - Standard OpenAI: POST {base}/embeddings, Authorization: Bearer, model in body.
//   - Azure OpenAI:     POST {base}/openai/deployments/{deployment}/embeddings?api-version=...,
//                       api-key header, NO model in body (deployment selects the model).

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

function makeMetrics(): EmbedMetrics {
  return { circuitBreakerState: { set: jest.fn() } } as unknown as EmbedMetrics;
}

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => (key in values ? values[key] : fallback),
  } as unknown as ConfigService;
}

const OK_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }], model: 'text-embedding-3-small' }),
};

describe('OpenAiProvider', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(OK_RESPONSE);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls the standard OpenAI endpoint with Bearer auth and model in body', async () => {
    const provider = new OpenAiProvider(
      makeConfig({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://api.openai.com/v1' }),
      logger,
      makeMetrics(),
    );

    await provider.embed(['hello']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.headers['api-key']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ model: 'text-embedding-3-small', input: ['hello'] });
  });

  it('auto-detects Azure from the endpoint and uses the deployment path + api-key header', async () => {
    const provider = new OpenAiProvider(
      makeConfig({
        OPENAI_API_KEY: 'azure-key',
        OPENAI_BASE_URL: 'https://aiusecases-ins.openai.azure.com/',
        AZURE_OPENAI_DEPLOYMENT: 'my-embed-deploy',
        AZURE_OPENAI_API_VERSION: '2024-10-21',
      }),
      logger,
      makeMetrics(),
    );

    await provider.embed(['hello']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://aiusecases-ins.openai.azure.com/openai/deployments/my-embed-deploy/embeddings?api-version=2024-10-21',
    );
    expect(init.headers['api-key']).toBe('azure-key');
    expect(init.headers.Authorization).toBeUndefined();
    // Azure selects the model by deployment — model must NOT be in the body.
    expect(JSON.parse(init.body)).toEqual({ input: ['hello'] });
  });

  it('defaults the Azure deployment to the embedding model name when unset', async () => {
    const provider = new OpenAiProvider(
      makeConfig({
        OPENAI_API_KEY: 'azure-key',
        OPENAI_BASE_URL: 'https://aiusecases-ins.openai.azure.com',
        OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
      }),
      logger,
      makeMetrics(),
    );

    await provider.embed(['hello']);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/openai/deployments/text-embedding-3-large/embeddings');
    expect(url).toContain('api-version=2024-10-21');
  });
});
