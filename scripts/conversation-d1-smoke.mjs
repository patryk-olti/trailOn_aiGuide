import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

async function query(sql, params = []) {
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(JSON.stringify(payload));
  }
  return payload.result?.[0]?.results ?? [];
}

const conversationId = randomUUID();
const participantA = `smoke-a-${Date.now()}`;
const participantB = `smoke-b-${Date.now()}`;
const now = new Date().toISOString();

await query(
  `INSERT INTO guide_conversations (conversation_id, participant_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  [conversationId, participantA, now, now],
);

const ownerRows = await query(
  `SELECT participant_id FROM guide_conversations WHERE conversation_id = ?`,
  [conversationId],
);
if (ownerRows[0]?.participant_id !== participantA) {
  throw new Error('Niepoprawny właściciel rozmowy po INSERT.');
}

const userId = randomUUID();
const asstId = randomUUID();
await query(
  `INSERT INTO guide_messages (message_id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
  [userId, conversationId, 'pytanie smoke', now],
);
await query(
  `INSERT INTO guide_messages (message_id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`,
  [asstId, conversationId, 'odpowiedź smoke', now],
);

const history = await query(
  `SELECT role, content FROM guide_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
  [conversationId],
);
if (history.length !== 2 || history[1].content !== 'odpowiedź smoke') {
  throw new Error('Historia wiadomości nie została odczytana poprawnie.');
}

const forbidden = await query(
  `SELECT conversation_id FROM guide_conversations WHERE conversation_id = ? AND participant_id = ?`,
  [conversationId, participantB],
);
if (forbidden.length > 0) {
  throw new Error('Participant B nie powinien mieć dostępu — logika aplikacji ma to blokować.');
}

console.log('conversation-d1-smoke OK', { conversationId, participantA });