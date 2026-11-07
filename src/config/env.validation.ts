export interface AppEnv {
  PORT: number;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_TIMEOUT_MS: number;
  AUTH_BEARER_TOKEN: string;
}

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const apiKey = readRequiredString(config, 'OPENAI_API_KEY');
  const bearerToken = readRequiredString(config, 'AUTH_BEARER_TOKEN');
  const port = readPort(config.PORT);
  const timeoutMs = readTimeout(config.OPENAI_TIMEOUT_MS);
  const model = readModel(config.OPENAI_MODEL);

  return {
    PORT: port,
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
    OPENAI_TIMEOUT_MS: timeoutMs,
    AUTH_BEARER_TOKEN: bearerToken,
  };
}

function readRequiredString(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function readPort(value: unknown): number {
  const raw = value === undefined || value === '' ? '3000' : String(value);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readTimeout(value: unknown): number {
  const raw = value === undefined || value === '' ? '30000' : String(value);
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    throw new Error('OPENAI_TIMEOUT_MS must be an integer between 1000 and 120000');
  }
  return timeout;
}

function readModel(value: unknown): string {
  if (value === undefined || value === '') {
    return 'gpt-4o-mini';
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('OPENAI_MODEL must be a non-empty string');
  }
  return value.trim();
}
