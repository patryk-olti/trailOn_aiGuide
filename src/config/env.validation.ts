export interface AppEnv {
  PORT: number;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_TIMEOUT_MS: number;
  OPENAI_EMBEDDING_MODEL: string;
  AUTH_BEARER_TOKEN: string;
  CF_D1_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  CF_D1_DATABASE_ID: string;
  CF_D1_PEAKS_TABLE: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  R2_ENDPOINT: string;
  R2_REGION: string;
  RAG_INDEX_KEY: string;
  RAG_EMBEDDING_DIMENSIONS: number;
  RAG_MIN_SCORE: number;
  RAG_PREFETCH_LIMIT: number;
  RAG_TOOL_ROUND_LIMIT: number;
  RAG_MAX_COMPLETION_TOKENS: number;
  CF_D1_CONVERSATIONS_TABLE: string;
  CF_D1_MESSAGES_TABLE: string;
  GUIDE_HISTORY_TURN_LIMIT: number;
}

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const apiKey = readRequiredString(config, 'OPENAI_API_KEY');
  const bearerToken = readRequiredString(config, 'AUTH_BEARER_TOKEN');
  const port = readPort(config.PORT);
  const timeoutMs = readTimeout(config.OPENAI_TIMEOUT_MS);
  const model = readModel(config.OPENAI_MODEL);
  const accountId = readRequiredString(config, 'CF_D1_ACCOUNT_ID');
  const d1Token = readRequiredString(config, 'CF_D1_API_TOKEN');
  const d1DatabaseId = readRequiredString(config, 'CF_D1_DATABASE_ID');
  const r2AccessKeyId = readRequiredString(config, 'R2_ACCESS_KEY_ID');
  const r2SecretAccessKey = readRequiredString(config, 'R2_SECRET_ACCESS_KEY');

  const r2Endpoint = readOptionalString(
    config,
    'R2_ENDPOINT',
    `https://${accountId}.r2.cloudflarestorage.com`,
  );
  const r2Bucket = readOptionalString(config, 'R2_BUCKET', 'trailonblog');
  const r2Region = readOptionalString(config, 'R2_REGION', 'auto');
  const embeddingModel = readOptionalString(
    config,
    'OPENAI_EMBEDDING_MODEL',
    'text-embedding-3-small',
  );
  const peaksTable = readOptionalString(config, 'CF_D1_PEAKS_TABLE', 'trailon_peaks_blob');
  const ragIndexKey = readOptionalString(config, 'RAG_INDEX_KEY', 'rag-index/index.json');
  const conversationsTable = readOptionalString(
    config,
    'CF_D1_CONVERSATIONS_TABLE',
    'guide_conversations',
  );
  const messagesTable = readOptionalString(config, 'CF_D1_MESSAGES_TABLE', 'guide_messages');

  return {
    PORT: port,
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
    OPENAI_TIMEOUT_MS: timeoutMs,
    OPENAI_EMBEDDING_MODEL: embeddingModel,
    AUTH_BEARER_TOKEN: bearerToken,
    CF_D1_ACCOUNT_ID: accountId,
    CF_D1_API_TOKEN: d1Token,
    CF_D1_DATABASE_ID: d1DatabaseId,
    CF_D1_PEAKS_TABLE: peaksTable,
    R2_ACCESS_KEY_ID: r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
    R2_BUCKET: r2Bucket,
    R2_ENDPOINT: r2Endpoint,
    R2_REGION: r2Region,
    RAG_INDEX_KEY: ragIndexKey,
    RAG_EMBEDDING_DIMENSIONS: readPositiveInt(config, 'RAG_EMBEDDING_DIMENSIONS', 512, 128, 3072),
    RAG_MIN_SCORE: readFloat(config, 'RAG_MIN_SCORE', 0.32, 0, 1),
    RAG_PREFETCH_LIMIT: readPositiveInt(config, 'RAG_PREFETCH_LIMIT', 4, 1, 12),
    RAG_TOOL_ROUND_LIMIT: readPositiveInt(config, 'RAG_TOOL_ROUND_LIMIT', 3, 0, 5),
    RAG_MAX_COMPLETION_TOKENS: readPositiveInt(
      config,
      'RAG_MAX_COMPLETION_TOKENS',
      800,
      128,
      4096,
    ),
    CF_D1_CONVERSATIONS_TABLE: conversationsTable,
    CF_D1_MESSAGES_TABLE: messagesTable,
    GUIDE_HISTORY_TURN_LIMIT: readPositiveInt(config, 'GUIDE_HISTORY_TURN_LIMIT', 20, 1, 50),
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

function readOptionalString(
  config: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = config[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string when set`);
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

function readPositiveInt(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readFloat(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return parsed;
}