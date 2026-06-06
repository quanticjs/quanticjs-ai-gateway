import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import * as request from 'supertest';
import { Result } from '@quanticjs/core';
import { GenerateController } from './generate.controller';

describe('GenerateController (integration)', () => {
  let app: INestApplication;
  let commandBus: { execute: jest.Mock };

  beforeAll(async () => {
    commandBus = { execute: jest.fn() };

    const module = await Test.createTestingModule({
      controllers: [GenerateController],
      providers: [
        { provide: CommandBus, useValue: commandBus },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    commandBus.execute.mockReset();
  });

  describe('POST /generate/sync', () => {
    const validPayload = {
      systemPrompt: 'You are a helpful assistant',
      userPrompt: 'Hello',
    };

    it('should return 200 with valid payload', async () => {
      commandBus.execute.mockResolvedValue(Result.success({
        content: 'Hi',
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0.0001,
        durationMs: 300,
      }));

      const res = await request(app.getHttpServer())
        .post('/generate/sync')
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(commandBus.execute).toHaveBeenCalledTimes(1);
    });

    it('should dispatch GenerateSyncCommand with all fields', async () => {
      commandBus.execute.mockResolvedValue(Result.success({}));

      await request(app.getHttpServer())
        .post('/generate/sync')
        .send({
          ...validPayload,
          maxTokens: 2048,
          model: 'claude-opus-4-20250514',
          purpose: 'summarize',
          callerService: 'svc',
        });

      const dispatched = commandBus.execute.mock.calls[0]![0];
      expect(dispatched.systemPrompt).toBe('You are a helpful assistant');
      expect(dispatched.userPrompt).toBe('Hello');
      expect(dispatched.maxTokens).toBe(2048);
      expect(dispatched.model).toBe('claude-opus-4-20250514');
      expect(dispatched.purpose).toBe('summarize');
      expect(dispatched.callerService).toBe('svc');
    });

    it('should return 400 when systemPrompt is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/generate/sync')
        .send({ userPrompt: 'Hello' });

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it('should return 400 when userPrompt is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/generate/sync')
        .send({ systemPrompt: 'sys' });

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it('should return 400 when maxTokens is not an integer', async () => {
      const res = await request(app.getHttpServer())
        .post('/generate/sync')
        .send({ ...validPayload, maxTokens: 1.5 });

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it('should strip unknown fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/generate/sync')
        .send({ ...validPayload, hackField: 'injected' });

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });

  describe('POST /generate', () => {
    const validPayload = {
      systemPrompt: 'You are a helpful assistant',
      userPrompt: 'Summarize this',
    };

    it('should return 202 with valid payload', async () => {
      commandBus.execute.mockResolvedValue(Result.success({ requestId: 'abc-123' }));

      const res = await request(app.getHttpServer())
        .post('/generate')
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(commandBus.execute).toHaveBeenCalledTimes(1);
    });

    it('should return 400 when body is empty', async () => {
      const res = await request(app.getHttpServer())
        .post('/generate')
        .send({});

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });
});
