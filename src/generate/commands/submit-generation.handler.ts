import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Optional } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { v4 as uuidv4 } from 'uuid';
import type { Redis } from 'ioredis';
import { Result, ErrorType, REDIS_CLIENT } from '@quanticjs/core';
import { SubmitGenerationCommand } from './submit-generation.command';
import { AI_PROVIDER, AiProvider } from '../services/ai-provider.interface';
import { GenerateMetrics } from '../generate.metrics';
import type { AsyncGenerateResponseDto } from '../dtos/generate-response.dto';

const RESULT_STREAM = 'arex:ai:results';
const STREAM_MAXLEN = '10000';

@CommandHandler(SubmitGenerationCommand)
export class SubmitGenerationHandler implements ICommandHandler<SubmitGenerationCommand> {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | undefined,
    @InjectPinoLogger(SubmitGenerationHandler.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
  ) {}

  async execute(command: SubmitGenerationCommand): Promise<Result<AsyncGenerateResponseDto>> {
    if (!this.redis) {
      return Result.failure(ErrorType.InternalError, 'Redis not available for async generation');
    }

    const requestId = uuidv4();

    this.processInBackground(requestId, command);

    return Result.success({ requestId, stream: RESULT_STREAM });
  }

  private processInBackground(requestId: string, command: SubmitGenerationCommand): void {
    this.provider
      .generate({
        systemPrompt: command.systemPrompt,
        userPrompt: command.userPrompt,
        maxTokens: command.maxTokens,
        model: command.model,
        jsonSchema: command.jsonSchema,
      })
      .then(async (response) => {
        this.metrics.requestsTotal.inc({ status: 'success' });
        this.metrics.requestDuration.observe({ model: response.model, status: 'success' }, response.durationMs / 1000);
        this.metrics.tokensTotal.inc({ model: response.model, direction: 'input' }, response.inputTokens);
        this.metrics.tokensTotal.inc({ model: response.model, direction: 'output' }, response.outputTokens);
        this.metrics.costDollars.inc({ model: response.model }, response.costUsd);

        this.logger.info(
          {
            requestId,
            model: response.model,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costUsd: response.costUsd.toFixed(6),
            durationMs: response.durationMs,
            purpose: command.purpose,
            callerService: command.callerService,
          },
          'Async generation completed',
        );

        await this.redis!.xadd(
          RESULT_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*',
          'requestId', requestId,
          'status', 'success',
          'content', response.content,
          'model', response.model,
          'inputTokens', String(response.inputTokens),
          'outputTokens', String(response.outputTokens),
          'costUsd', response.costUsd.toFixed(6),
        );
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        this.metrics.requestsTotal.inc({ status: 'error' });
        this.logger.error({ requestId, error: message }, 'Async generation failed');

        await this.redis!.xadd(
          RESULT_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*',
          'requestId', requestId,
          'status', 'error',
          'error', message,
        );
      });
  }
}
