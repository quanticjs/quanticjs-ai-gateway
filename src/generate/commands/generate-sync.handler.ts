import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Result, ErrorType } from '@quanticjs/core';
import { GenerateSyncCommand } from './generate-sync.command';
import { AI_PROVIDER, AiProvider } from '../services/ai-provider.interface';
import { GenerateMetrics } from '../generate.metrics';
import type { GenerateResponseDto } from '../dtos/generate-response.dto';

@CommandHandler(GenerateSyncCommand)
export class GenerateSyncHandler implements ICommandHandler<GenerateSyncCommand> {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @InjectPinoLogger(GenerateSyncHandler.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
  ) {}

  async execute(command: GenerateSyncCommand): Promise<Result<GenerateResponseDto>> {
    try {
      const response = await this.provider.generate({
        systemPrompt: command.systemPrompt,
        userPrompt: command.userPrompt,
        maxTokens: command.maxTokens,
        model: command.model,
        jsonSchema: command.jsonSchema,
        media: command.media,
      });

      this.metrics.requestsTotal.inc({ status: 'success' });
      this.metrics.requestDuration.observe({ model: response.model, status: 'success' }, response.durationMs / 1000);
      this.metrics.tokensTotal.inc({ model: response.model, direction: 'input' }, response.inputTokens);
      this.metrics.tokensTotal.inc({ model: response.model, direction: 'output' }, response.outputTokens);
      this.metrics.costDollars.inc({ model: response.model }, response.costUsd);

      this.logger.info(
        {
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: response.costUsd.toFixed(6),
          durationMs: response.durationMs,
          purpose: command.purpose,
          callerService: command.callerService,
        },
        'Generation completed',
      );

      return Result.success({
        content: response.content,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        durationMs: response.durationMs,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.metrics.requestsTotal.inc({ status: 'error' });
      this.logger.error(
        { error: message, purpose: command.purpose, callerService: command.callerService },
        'Generation failed',
      );

      return Result.failure(ErrorType.InternalError, `AI generation failed: ${message}`);
    }
  }
}
