import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BearerAuthMiddleware } from './bearer-auth.middleware';

@Module({
  providers: [BearerAuthMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(BearerAuthMiddleware)
      .exclude({ path: '/', method: RequestMethod.GET })
      .forRoutes('{*path}');
  }
}
