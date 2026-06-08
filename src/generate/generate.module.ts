import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { GenerateController } from './controllers/generate.controller';
import { GenerateSyncHandler } from './commands/generate-sync.handler';
import { GenerateSyncValidator } from './commands/generate-sync.validator';
import { SubmitGenerationHandler } from './commands/submit-generation.handler';
import { SubmitGenerationValidator } from './commands/submit-generation.validator';
import { AiRequestConsumer } from './consumers/ai-request.consumer';
import { SdkProvider } from './services/sdk.provider';
import { AnthropicProvider } from './services/anthropic.provider';
import { AI_PROVIDER } from './services/ai-provider.interface';
import { GenerateMetrics } from './generate.metrics';

@Module({
  imports: [CqrsModule],
  controllers: [GenerateController],
  providers: [
    GenerateSyncHandler,
    GenerateSyncValidator,
    SubmitGenerationHandler,
    SubmitGenerationValidator,
    AiRequestConsumer,
    GenerateMetrics,
    SdkProvider,
    AnthropicProvider,
    {
      provide: AI_PROVIDER,
      useFactory: (config: ConfigService, sdk: SdkProvider, anthropic: AnthropicProvider) => {
        const provider = config.get('AI_PROVIDER', 'claude-sdk');
        return provider === 'anthropic-api' ? anthropic : sdk;
      },
      inject: [ConfigService, SdkProvider, AnthropicProvider],
    },
  ],
  exports: [AI_PROVIDER],
})
export class GenerateModule {}
