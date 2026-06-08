import { Inject, Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  KafkaEventConsumer,
  KafkaEventMetrics,
  KAFKA_OPTIONS,
  type KafkaEvent,
  type KafkaEventsModuleOptions,
} from '@quanticjs/events-kafka';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SubmitGenerationCommand } from '../commands/submit-generation.command';

@Injectable()
export class AiRequestConsumer extends KafkaEventConsumer {
  readonly topic = 'quantic.commands.ai-generate';
  readonly groupId = 'ai-gateway-generate';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
    @InjectPinoLogger(AiRequestConsumer.name) private readonly appLogger: PinoLogger,
    private readonly commandBus: CommandBus,
  ) {
    super(config, metrics);
  }

  async handleMessage(event: KafkaEvent): Promise<void> {
    const payload = typeof event.payload === 'string'
      ? JSON.parse(event.payload) as Record<string, unknown>
      : event.payload;

    const systemPrompt = payload['systemPrompt'] as string;
    const userPrompt = payload['userPrompt'] as string;
    const maxTokens = payload['maxTokens'] as number | undefined;
    const model = payload['model'] as string | undefined;
    const jsonSchema = payload['jsonSchema'] as Record<string, unknown> | undefined;
    const purpose = payload['purpose'] as string | undefined;
    const callerService = payload['callerService'] as string | undefined;
    const metadata = payload['metadata'] as Record<string, unknown> | undefined;

    if (!systemPrompt || !userPrompt) {
      this.appLogger.warn({ payload }, 'Invalid AI request — missing prompts');
      return;
    }

    this.appLogger.info(
      { purpose, callerService, promptLength: userPrompt.length },
      'AI generation request received via Kafka',
    );

    await this.commandBus.execute(
      new SubmitGenerationCommand(
        systemPrompt,
        userPrompt,
        maxTokens,
        model,
        jsonSchema,
        purpose,
        callerService,
        metadata,
      ),
    );
  }
}
