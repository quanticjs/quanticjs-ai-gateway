import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Result, ErrorType } from '@quanticjs/core';
import { EmbedTextsCommand } from './embed-texts.command';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../services/embedding-provider.interface';
import { EmbedMetrics } from '../embed.metrics';
import type { EmbedBatchResponseDto } from '../dtos/embed-response.dto';

@CommandHandler(EmbedTextsCommand)
export class EmbedTextsHandler implements ICommandHandler<EmbedTextsCommand> {
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    @InjectPinoLogger(EmbedTextsHandler.name) private readonly logger: PinoLogger,
    private readonly metrics: EmbedMetrics,
  ) {}

  async execute(command: EmbedTextsCommand): Promise<Result<EmbedBatchResponseDto>> {
    const startTime = Date.now();

    try {
      const response = await this.provider.embed(command.inputs);
      const durationMs = Date.now() - startTime;

      this.metrics.requestsTotal.inc({ status: 'success' });
      this.metrics.requestDuration.observe({ model: response.model, status: 'success' }, durationMs / 1000);
      this.metrics.inputsTotal.inc({ model: response.model }, command.inputs.length);

      this.logger.info(
        {
          inputCount: command.inputs.length,
          model: response.model,
          dimensions: response.dimensions,
          durationMs,
          callerService: command.callerService,
        },
        'Embedding completed',
      );

      return Result.success({
        embeddings: response.embeddings,
        model: response.model,
        dimensions: response.dimensions,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      this.metrics.requestsTotal.inc({ status: 'error' });
      this.metrics.requestDuration.observe({ model: 'unknown', status: 'error' }, durationMs / 1000);

      this.logger.error(
        { error: message, inputCount: command.inputs.length, callerService: command.callerService },
        'Embedding failed',
      );

      return Result.failure(ErrorType.InternalError, `Embedding failed: ${message}`);
    }
  }
}
