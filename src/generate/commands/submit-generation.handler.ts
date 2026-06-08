import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { v4 as uuidv4 } from 'uuid';
import { Result } from '@quanticjs/core';
import { DomainEvent, EVENT_PUBLISHER, IEventPublisher } from '@quanticjs/events-core';
import { SubmitGenerationCommand } from './submit-generation.command';
import { AI_PROVIDER, AiProvider } from '../services/ai-provider.interface';
import { GenerateMetrics } from '../generate.metrics';
import type { AsyncGenerateResponseDto } from '../dtos/generate-response.dto';

@CommandHandler(SubmitGenerationCommand)
export class SubmitGenerationHandler implements ICommandHandler<SubmitGenerationCommand> {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(EVENT_PUBLISHER) private readonly publisher: IEventPublisher,
    @InjectPinoLogger(SubmitGenerationHandler.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
  ) {}

  async execute(command: SubmitGenerationCommand): Promise<Result<AsyncGenerateResponseDto>> {
    const requestId = uuidv4();

    this.processInBackground(requestId, command);

    return Result.success({ requestId });
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

        await this.publisher.publish(
          new DomainEvent(
            'generation.completed',
            requestId,
            {
              content: response.content,
              model: response.model,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
              costUsd: response.costUsd,
              durationMs: response.durationMs,
              purpose: command.purpose,
              callerService: command.callerService,
              metadata: command.metadata,
            },
            undefined,
            command.callerService,
          ),
        );
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        this.metrics.requestsTotal.inc({ status: 'error' });
        this.logger.error({ requestId, error: message }, 'Async generation failed');

        await this.publisher.publish(
          new DomainEvent(
            'generation.failed',
            requestId,
            {
              error: message,
              callerService: command.callerService,
              metadata: command.metadata,
            },
            undefined,
            command.callerService,
          ),
        );
      });
  }
}
