import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GenerateController } from './controllers/generate.controller';
import { GenerateSyncHandler } from './commands/generate-sync.handler';
import { GenerateSyncValidator } from './commands/generate-sync.validator';
import { SubmitGenerationHandler } from './commands/submit-generation.handler';
import { SubmitGenerationValidator } from './commands/submit-generation.validator';
import { AiRequestConsumer } from './consumers/ai-request.consumer';
import { SdkProvider } from './services/sdk.provider';
import { AnthropicProvider } from './services/anthropic.provider';
import { OpenAiGenerationProvider } from './services/openai.provider';
import { MediaFetcher } from './services/media-fetcher';
import { TikaExtractor } from './services/tika-extractor.service';
import type { AiProvider } from './services/ai-provider.interface';
import { AI_PROVIDER } from './services/ai-provider.interface';
import { GenerateMetrics } from './generate.metrics';

/**
 * Resolves the generation provider from the `AI_PROVIDER` config value.
 * `'anthropic-api'` → Anthropic, `'openai'` → OpenAI/Azure, anything else → the Claude SDK default.
 * Exported so the selection is unit-testable without booting the whole module.
 */
export function selectAiProvider(
  value: string,
  providers: { sdk: AiProvider; anthropic: AiProvider; openai: AiProvider },
): AiProvider {
  if (value === 'anthropic-api') return providers.anthropic;
  if (value === 'openai') return providers.openai;
  return providers.sdk;
}

@Module({
  imports: [],
  controllers: [GenerateController],
  providers: [
    GenerateSyncHandler,
    GenerateSyncValidator,
    SubmitGenerationHandler,
    SubmitGenerationValidator,
    AiRequestConsumer,
    GenerateMetrics,
    MediaFetcher,
    TikaExtractor,
    SdkProvider,
    AnthropicProvider,
    OpenAiGenerationProvider,
    {
      provide: AI_PROVIDER,
      useFactory: (
        config: ConfigService,
        sdk: SdkProvider,
        anthropic: AnthropicProvider,
        openai: OpenAiGenerationProvider,
      ) => selectAiProvider(config.get('AI_PROVIDER', 'claude-sdk'), { sdk, anthropic, openai }),
      inject: [ConfigService, SdkProvider, AnthropicProvider, OpenAiGenerationProvider],
    },
  ],
  exports: [AI_PROVIDER],
})
export class GenerateModule {}
