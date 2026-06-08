import { Test } from '@nestjs/testing';
import { SubmitGenerationHandler } from './submit-generation.handler';
import { SubmitGenerationCommand } from './submit-generation.command';
import { AI_PROVIDER, AiProvider, AiGenerateResponse } from '../services/ai-provider.interface';
import { EVENT_PUBLISHER, IEventPublisher } from '@quanticjs/events-core';
import { GenerateMetrics } from '../generate.metrics';

const mockResponse: AiGenerateResponse = {
  content: 'Generated text',
  model: 'claude-sonnet-4-5-20250929',
  inputTokens: 15,
  outputTokens: 25,
  costUsd: 0.002,
  durationMs: 800,
};

function createMockProvider(): jest.Mocked<AiProvider> {
  return {
    name: 'mock-provider',
    generate: jest.fn().mockResolvedValue(mockResponse),
  };
}

function createMockPublisher(): jest.Mocked<IEventPublisher> {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<IEventPublisher>;
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

describe('SubmitGenerationHandler', () => {
  let handler: SubmitGenerationHandler;
  let provider: jest.Mocked<AiProvider>;
  let publisher: jest.Mocked<IEventPublisher>;
  let metrics: GenerateMetrics;

  beforeEach(async () => {
    provider = createMockProvider();
    publisher = createMockPublisher();
    metrics = createMockMetrics();

    const module = await Test.createTestingModule({
      providers: [
        SubmitGenerationHandler,
        { provide: AI_PROVIDER, useValue: provider },
        { provide: EVENT_PUBLISHER, useValue: publisher },
        { provide: GenerateMetrics, useValue: metrics },
        { provide: 'PinoLogger:SubmitGenerationHandler', useValue: mockLogger },
      ],
    }).compile();

    handler = module.get(SubmitGenerationHandler);
  });

  it('should return success with a requestId immediately', async () => {
    const command = new SubmitGenerationCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined, undefined);
    const result = await handler.execute(command);

    expect(result.isSuccess).toBe(true);
    expect(result.value!.requestId).toBeDefined();
    expect(typeof result.value!.requestId).toBe('string');
    expect(result.value!.requestId.length).toBeGreaterThan(0);
  });

  it('should fire background generation and publish generation.completed event', async () => {
    const command = new SubmitGenerationCommand('sys', 'usr', undefined, undefined, undefined, 'test', 'svc', undefined);
    await handler.execute(command);

    await new Promise((r) => setTimeout(r, 100));

    expect(provider.generate).toHaveBeenCalledWith({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxTokens: undefined,
      model: undefined,
      jsonSchema: undefined,
    });
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    const publishedEvent = (publisher.publish as jest.Mock).mock.calls[0]![0];
    expect(publishedEvent.eventType).toBe('generation.completed');
    expect(publishedEvent.payload.content).toBe('Generated text');
    expect(publishedEvent.payload.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('should record success metrics after background completion', async () => {
    const command = new SubmitGenerationCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined, undefined);
    await handler.execute(command);

    await new Promise((r) => setTimeout(r, 100));

    expect(metrics.requestsTotal.inc).toHaveBeenCalledWith({ status: 'success' });
  });

  it('should publish generation.failed event when provider throws', async () => {
    provider.generate.mockRejectedValue(new Error('Provider down'));
    const command = new SubmitGenerationCommand('sys', 'usr', undefined, undefined, undefined, undefined, 'svc', undefined);
    await handler.execute(command);

    await new Promise((r) => setTimeout(r, 100));

    expect(publisher.publish).toHaveBeenCalledTimes(1);

    const publishedEvent = (publisher.publish as jest.Mock).mock.calls[0]![0];
    expect(publishedEvent.eventType).toBe('generation.failed');
    expect(publishedEvent.payload.error).toBe('Provider down');
  });

  it('should record error metrics when provider throws', async () => {
    provider.generate.mockRejectedValue(new Error('fail'));
    const command = new SubmitGenerationCommand('sys', 'usr', undefined, undefined, undefined, undefined, undefined, undefined);
    await handler.execute(command);

    await new Promise((r) => setTimeout(r, 100));

    expect(metrics.requestsTotal.inc).toHaveBeenCalledWith({ status: 'error' });
  });
});
