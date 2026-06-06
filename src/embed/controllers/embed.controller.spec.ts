import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import * as request from 'supertest';
import { Result } from '@quanticjs/core';
import { EmbedController } from './embed.controller';

describe('EmbedController (integration)', () => {
  let app: INestApplication;
  let commandBus: { execute: jest.Mock };

  beforeAll(async () => {
    commandBus = { execute: jest.fn() };

    const module = await Test.createTestingModule({
      controllers: [EmbedController],
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

  describe('POST /embed', () => {
    it('should return 200 with valid batch payload', async () => {
      commandBus.execute.mockResolvedValue(Result.success({
        embeddings: [[0.1, 0.2], [0.3, 0.4]],
        model: 'tei-base',
        dimensions: 2,
      }));

      const res = await request(app.getHttpServer())
        .post('/embed')
        .send({ inputs: ['hello', 'world'] });

      expect(res.status).toBe(200);
      expect(commandBus.execute).toHaveBeenCalledTimes(1);
    });

    it('should dispatch EmbedTextsCommand with inputs and callerService', async () => {
      commandBus.execute.mockResolvedValue(Result.success({}));

      await request(app.getHttpServer())
        .post('/embed')
        .send({ inputs: ['text1'], callerService: 'my-svc' });

      const dispatched = commandBus.execute.mock.calls[0]![0];
      expect(dispatched.inputs).toEqual(['text1']);
      expect(dispatched.callerService).toBe('my-svc');
    });

    it('should return 400 when inputs is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/embed')
        .send({});

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it('should return 400 when inputs is empty array', async () => {
      const res = await request(app.getHttpServer())
        .post('/embed')
        .send({ inputs: [] });

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it('should return 400 with unknown fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/embed')
        .send({ inputs: ['hello'], unknownField: 'bad' });

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });

  describe('POST /embed/single', () => {
    it('should return 200 with valid single payload', async () => {
      commandBus.execute.mockResolvedValue(Result.success({
        embeddings: [[0.1, 0.2, 0.3]],
        model: 'tei-base',
        dimensions: 3,
      }));

      const res = await request(app.getHttpServer())
        .post('/embed/single')
        .send({ input: 'hello world' });

      expect(res.status).toBe(200);
      expect(commandBus.execute).toHaveBeenCalledTimes(1);
    });

    it('should wrap single input into array for EmbedTextsCommand', async () => {
      commandBus.execute.mockResolvedValue(Result.success({
        embeddings: [[0.1]],
        model: 'tei-base',
        dimensions: 1,
      }));

      await request(app.getHttpServer())
        .post('/embed/single')
        .send({ input: 'test' });

      const dispatched = commandBus.execute.mock.calls[0]![0];
      expect(dispatched.inputs).toEqual(['test']);
    });

    it('should unwrap single embedding from batch response', async () => {
      commandBus.execute.mockResolvedValue(Result.success({
        embeddings: [[0.1, 0.2, 0.3]],
        model: 'tei-base',
        dimensions: 3,
      }));

      const res = await request(app.getHttpServer())
        .post('/embed/single')
        .send({ input: 'hello' });

      expect(res.body.value.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(res.body.value.model).toBe('tei-base');
      expect(res.body.value.dimensions).toBe(3);
    });

    it('should return 400 when input is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/embed/single')
        .send({});

      expect(res.status).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });
});
