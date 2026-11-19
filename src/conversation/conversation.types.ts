export type StoredMessageRole = 'user' | 'assistant';

export interface ConversationRow {
  conversation_id: string;
  participant_id: string;
  created_at: string;
  updated_at: string;
}

export interface GuideMessageRow {
  message_id: string;
  conversation_id: string;
  role: StoredMessageRole;
  content: string;
  created_at: string;
}

export interface StoredChatTurn {
  role: StoredMessageRole;
  content: string;
}