import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { LoggerModule } from 'nestjs-pino';
import { QuanticModule } from '@quanticjs/quanticjs';
import { JwtStrategy, JwtAuthGuard, AuthContextInterceptor } from '@quanticjs/core';
import { QuanticMetricsModule } from '@quanticjs/metrics';
import { QuanticHealthModule } from '@quanticjs/health';
import { QuanticEventsKafkaModule } from '@quanticjs/events-kafka';

import { GenerateModule } from './generate/generate.module';
import { EmbedModule } from './embed/embed.module';

// This service is stateless (no database). v7's QuanticEventsCoreModule
// registers OutboxPublisher unconditionally and its DataSource dependency is
// not @Optional(), so a null DataSource satisfies DI. Safe because this app
// publishes via EVENT_PUBLISHER directly and never calls publishViaOutbox().
// FOLLOW-UP: remove once @quanticjs/events-core makes DataSource optional.
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: null }],
  exports: [DataSource],
})
class NoDatabaseModule {}

@Module({
  imports: [
    NoDatabaseModule,
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
    }),

    QuanticEventsKafkaModule.forRoot({
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
      clientId: 'ai-gateway',
      outbox: false,
      ssl: process.env.KAFKA_SSL === 'true' ? true : undefined,
      sasl: process.env.KAFKA_SASL_USERNAME
        ? {
            mechanism: 'scram-sha-512',
            username: process.env.KAFKA_SASL_USERNAME,
            password: process.env.KAFKA_SASL_PASSWORD!,
          }
        : undefined,
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
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuthContextInterceptor },
  ],
})
export class AppModule {}
