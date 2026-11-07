import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bearerTokensMatch, readBearerToken } from './bearer-token';

interface AuthorizedRequest {
  headers: {
    authorization?: string | string[];
  };
}

@Injectable()
export class BearerAuthMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(req: AuthorizedRequest, _res: unknown, next: () => void): void {
    const header = req.headers.authorization;
    const provided = readBearerToken(typeof header === 'string' ? header : undefined);
    const expected = this.config.getOrThrow<string>('AUTH_BEARER_TOKEN');
    if (!provided || !bearerTokensMatch(provided, expected)) {
      throw new UnauthorizedException();
    }
    next();
  }
}
