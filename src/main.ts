import './tracing';
import { bootstrapService } from '@quanticjs/core';
import { AppModule } from './app.module';

bootstrapService({
  module: AppModule,
  port: parseInt(process.env.PORT ?? '3005', 10),
  serviceName: 'AiGateway',
  globalPrefixExclude: ['health/*path'],
});
