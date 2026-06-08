import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, ICommand } from '@nestjs/cqrs';
import {
  CqrsKafkaConsumer,
  KafkaEventMetrics,
  KAFKA_OPTIONS,
  type KafkaEvent,
  type KafkaEventsModuleOptions,
} from '@quanticjs/events-kafka';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SubmitGenerationCommand } from '../commands/submit-generation.command';

@Injectable()
export class AiRequestConsumer extends CqrsKafkaConsumer {
  readonly topic = 'quantic.commands.ai-generate';
  readonly groupId = 'ai-gateway-generate';

  constructor(
    @Inject(KAFKA_OPTIONS) config: KafkaEventsModuleOptions,
    @Inject('KAFKA_METRICS') metrics: KafkaEventMetrics,
    commandBus: CommandBus,
    @InjectPinoLogger(AiRequestConsumer.name) private readonly appLogger: PinoLogger,
  ) {
    super(config, metrics, commandBus);
  }

  mapToCommand(event: KafkaEvent): ICommand | null {
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
      return null;
    }

    this.appLogger.info(
      { purpose, callerService, promptLength: userPrompt.length },
      'AI generation request received via Kafka',
    );

    return new SubmitGenerationCommand(
      systemPrompt,
      userPrompt,
      maxTokens,
      model,
      jsonSchema,
      purpose,
      callerService,
      metadata,
    );
  }
}
