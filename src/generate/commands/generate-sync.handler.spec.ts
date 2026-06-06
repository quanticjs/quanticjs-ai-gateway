import { Test } from '@nestjs/testing';
import { ErrorType } from '@quanticjs/core';
import { GenerateSyncHandler } from './generate-sync.handler';
import { GenerateSyncCommand } from './generate-sync.command';
import { AI_PROVIDER, AiProvider, AiGenerateResponse } from '../services/ai-provider.interface';
import { GenerateMetrics } from '../generate.metrics';

const mockResponse: AiGenerateResponse = {
  content: 'Hello world',
  model: 'claude-sonnet-4-5-20250929',
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.001,
  durationMs: 500,
};

function createMockProvider(): jest.Mocked<AiProvider> {
  return {
    name: 'mock-provider',
    generate: jest.fn().mockResolvedValue(mockResponse),
  };
}

function createMockMetrics(): GenerateMetrics {
  return {
    requestsTotal: { inc: jest.fn() },
    requestDuration: { observe: jest.fn() },
    tokensTotal: { inc: jest.fn() },
    costDollars: { inc: jest.fn() },
    circuitBreakerState: { set: jest.fn() },
  } as unknown as GenerateMetrics;
}

const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

describe('GenerateSyncHandler', () => {
  let handler: GenerateSyncHandler;
  let provider: jest.Mocked<AiProvider>;
  let metrics: GenerateMetrics;

  beforeEach(async () => {
    provider = createMockProvider();
    metrics = createMockMetrics();

    const module = await Test.createTestingModule({
      providers: [
        GenerateSyncHandler,
        { provide: AI_PROVIDER, useValue: provider },
        { provide: GenerateMetrics, useValue: metrics },
        { provide: 'PinoLogger:GenerateSyncHandler', useValue: mockLogger },
      ],
    }).compile();

    handler = module.get(GenerateSyncHandler);
  });

  it('should generate and return success with response data', async () => {
    const command = new GenerateSyncCommand('system', 'user', undefined, undefined, undefined, 'test', 'svc');
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(true);
    expect(result.value).toEqual({
      content: 'Hello world',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
      durationMs: 500,
    });
  });

  it('should pass all fields to provider.generate', async () => {
    const schema = { type: 'object' };
    const command = new GenerateSyncCommand('sys', 'usr', 4096, 'claude-opus-4-20250514', schema, 'test', 'svc');
    await handler.execute(command);

    expect(provider.generate).toHaveBeenCalledWith({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxTokens: 4096,
      model: 'claude-opus-4-20250514',
      jsonSchema: schema,
    });
  });

  it('should record success metrics', async () => {
    const command = new GenerateSyncCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined);
    await handler.execute(command);

    expect(metrics.requestsTotal.inc).toHaveBeenCalledWith({ status: 'success' });
    expect(metrics.requestDuration.observe).toHaveBeenCalledWith(
      { model: 'claude-sonnet-4-5-20250929', status: 'success' },
      0.5,
    );
    expect(metrics.tokensTotal.inc).toHaveBeenCalledWith({ model: 'claude-sonnet-4-5-20250929', direction: 'input' }, 10);
    expect(metrics.tokensTotal.inc).toHaveBeenCalledWith({ model: 'claude-sonnet-4-5-20250929', direction: 'output' }, 20);
    expect(metrics.costDollars.inc).toHaveBeenCalledWith({ model: 'claude-sonnet-4-5-20250929' }, 0.001);
  });

  it('should return InternalError when provider throws', async () => {
    provider.generate.mockRejectedValue(new Error('API rate limited'));
    const command = new GenerateSyncCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined);
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.InternalError);
  });

  it('should record error metrics when provider throws', async () => {
    provider.generate.mockRejectedValue(new Error('timeout'));
    const command = new GenerateSyncCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined);
    await handler.execute(command);

    expect(metrics.requestsTotal.inc).toHaveBeenCalledWith({ status: 'error' });
  });

  it('should handle non-Error throw values', async () => {
    provider.generate.mockRejectedValue('string error');
    const command = new GenerateSyncCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined);
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.InternalError);
  });
});
