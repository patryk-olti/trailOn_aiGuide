import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  return header.match(BEARER_PATTERN)?.[1];
}

export function bearerTokensMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
