import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbedController } from './controllers/embed.controller';
import { EmbedTextsHandler } from './commands/embed-texts.handler';
import { EmbedTextsValidator } from './commands/embed-texts.validator';
import { TeiProvider } from './services/tei.provider';
import { OpenAiProvider } from './services/openai.provider';
import { EMBEDDING_PROVIDER } from './services/embedding-provider.interface';
import { EmbedMetrics } from './embed.metrics';

@Module({
  imports: [],
  controllers: [EmbedController],
  providers: [
    EmbedTextsHandler,
    EmbedTextsValidator,
    EmbedMetrics,
    TeiProvider,
    OpenAiProvider,
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (config: ConfigService, tei: TeiProvider, openai: OpenAiProvider) => {
        const provider = config.get('EMBEDDING_PROVIDER', 'tei');
        return provider === 'openai' ? openai : tei;
      },
      inject: [ConfigService, TeiProvider, OpenAiProvider],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbedModule {}
