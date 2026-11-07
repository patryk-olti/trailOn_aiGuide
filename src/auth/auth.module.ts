import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { BearerAuthMiddleware } from './bearer-auth.middleware';

@Module({
  providers: [BearerAuthMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(BearerAuthMiddleware).forRoutes('{*path}');
  }
}
