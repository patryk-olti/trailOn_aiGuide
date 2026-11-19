import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnvFile() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) {
    return;
  }
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const accountId = process.env.CF_D1_ACCOUNT_ID;
const databaseId = process.env.CF_D1_DATABASE_ID;
const apiToken = process.env.CF_D1_API_TOKEN;

if (!accountId || !databaseId || !apiToken) {
  console.error('Brak CF_D1_ACCOUNT_ID, CF_D1_DATABASE_ID lub CF_D1_API_TOKEN.');
  process.exit(1);
}

const migrationFile =
  process.argv[2] ?? join(root, 'migrations', '0001_create_conversation_history.sql');
const sqlRaw = readFileSync(migrationFile, 'utf8');
const statements = sqlRaw
  .split(';')
  .map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim())
  .filter((s) => s.length > 0);

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

for (const sql of statements) {
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    console.error('Migracja nie powiodła się:', JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  console.log('OK:', sql.split('\n')[0].slice(0, 80));
}

console.log('Migracja zakończona.');