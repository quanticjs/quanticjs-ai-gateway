import { Test } from '@nestjs/testing';
import { ErrorType } from '@quanticjs/core';
import { EmbedTextsHandler } from './embed-texts.handler';
import { EmbedTextsCommand } from './embed-texts.command';
import { EMBEDDING_PROVIDER, EmbeddingProvider, EmbedResponse } from '../services/embedding-provider.interface';
import { EmbedMetrics } from '../embed.metrics';

const mockResponse: EmbedResponse = {
  embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
  model: 'tei-base',
  dimensions: 3,
};

function createMockProvider(): jest.Mocked<EmbeddingProvider> {
  return {
    name: 'mock-tei',
    embed: jest.fn().mockResolvedValue(mockResponse),
  };
}

function createMockMetrics(): EmbedMetrics {
  return {
    requestsTotal: { inc: jest.fn() },
    requestDuration: { observe: jest.fn() },
    inputsTotal: { inc: jest.fn() },
    circuitBreakerState: { set: jest.fn() },
  } as unknown as EmbedMetrics;
}

const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

describe('EmbedTextsHandler', () => {
  let handler: EmbedTextsHandler;
  let provider: jest.Mocked<EmbeddingProvider>;
  let metrics: EmbedMetrics;

  beforeEach(async () => {
    provider = createMockProvider();
    metrics = createMockMetrics();

    const module = await Test.createTestingModule({
      providers: [
        EmbedTextsHandler,
        { provide: EMBEDDING_PROVIDER, useValue: provider },
        { provide: EmbedMetrics, useValue: metrics },
        { provide: 'PinoLogger:EmbedTextsHandler', useValue: mockLogger },
      ],
    }).compile();

    handler = module.get(EmbedTextsHandler);
  });

  it('should embed texts and return success', async () => {
    const command = new EmbedTextsCommand(['hello', 'world'], 'svc');
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(true);
    expect(result.value).toEqual({
      embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      model: 'tei-base',
      dimensions: 3,
    });
  });

  it('should pass inputs to provider.embed', async () => {
    const inputs = ['text1', 'text2', 'text3'];
    const command = new EmbedTextsCommand(inputs, undefined);
    await handler.execute(command);

    expect(provider.embed).toHaveBeenCalledWith(inputs);
  });

  it('should record success metrics', async () => {
    const command = new EmbedTextsCommand(['a', 'b'], 'svc');
    await handler.execute(command);

    expect(metrics.requestsTotal.inc).toHaveBeenCalledWith({ status: 'success' });
    expect(metrics.inputsTotal.inc).toHaveBeenCalledWith({ model: 'tei-base' }, 2);
  });

  it('should return InternalError when provider throws', async () => {
    provider.embed.mockRejectedValue(new Error('TEI unreachable'));
    const command = new EmbedTextsCommand(['hello'], 'svc');
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.InternalError);
  });

  it('should record error metrics when provider throws', async () => {
    provider.embed.mockRejectedValue(new Error('fail'));
    const command = new EmbedTextsCommand(['hello'], undefined);
    await handler.execute(command);

    expect(metrics.requestsTotal.inc).toHaveBeenCalledWith({ status: 'error' });
  });

  it('should handle non-Error throw values', async () => {
    provider.embed.mockRejectedValue('string error');
    const command = new EmbedTextsCommand(['hello'], undefined);
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.InternalError);
  });
});
