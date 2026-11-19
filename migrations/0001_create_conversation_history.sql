-- Historia rozmów AI Guide (osobne od katalogu szczytów)

CREATE TABLE IF NOT EXISTS guide_conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_guide_conversations_participant
  ON guide_conversations (participant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS guide_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (conversation_id) REFERENCES guide_conversations (conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_guide_messages_conversation_created
  ON guide_messages (conversation_id, created_at ASC);