import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { QuanticModule } from '@quanticjs/quanticjs';
import { QuanticMetricsModule } from '@quanticjs/metrics';
import { QuanticHealthModule } from '@quanticjs/health';

import { GenerateModule } from './generate/generate.module';
import { EmbedModule } from './embed/embed.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        serializers: {
          req: (req: any) => ({ id: req.id, method: req.method, url: req.url }),
          res: (res: any) => ({ statusCode: res.statusCode }),
        },
      },
    }),

    QuanticModule.forRoot({
      redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
      events: true,
    }),

    QuanticMetricsModule.forRoot(),

    QuanticHealthModule.forRoot({
      transport: { type: 'controller' },
      shutdownAware: true,
      shutdownDelayMs: 5_000,
    }),

    GenerateModule,
    EmbedModule,
  ],
})
export class AppModule {}
