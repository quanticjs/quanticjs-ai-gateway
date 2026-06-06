import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { EmbedController } from './controllers/embed.controller';
import { EmbedTextsHandler } from './commands/embed-texts.handler';
import { EmbedTextsValidator } from './commands/embed-texts.validator';
import { TeiProvider } from './services/tei.provider';
import { EMBEDDING_PROVIDER } from './services/embedding-provider.interface';
import { EmbedMetrics } from './embed.metrics';

@Module({
  imports: [CqrsModule],
  controllers: [EmbedController],
  providers: [
    EmbedTextsHandler,
    EmbedTextsValidator,
    EmbedMetrics,
    TeiProvider,
    { provide: EMBEDDING_PROVIDER, useExisting: TeiProvider },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbedModule {}
