import type {
  ConversationRow,
  GuideMessageRow,
  ParticipantHistory,
  StoredChatTurn,
} from './conversation.types';

/** Ile ostatnich konwersacji użytkownika zwraca odczyt historii. */
export const PARTICIPANT_HISTORY_CONVERSATION_LIMIT = 5;

/**
 * Ile ostatnich wiadomości zwraca odczyt w ramach jednej konwersacji.
 * Trzy wymiany to już 6 wiadomości, więc limit musi pomieścić cały krótki wątek.
 */
export const PARTICIPANT_HISTORY_MESSAGE_LIMIT = 40;

/**
 * Czas przyjścia pytania i czas zapisu odpowiedzi.
 * `askedAt` zostaje takie, jakie przyszło z żądania. `answeredAt` jest późniejsze,
 * także gdy odpowiedź zmieści się w tej samej milisekundzie.
 */
export function exchangeTimestamps(
  questionAt: string,
  now = new Date(),
): { askedAt: string; answeredAt: string } {
  const parsedQuestion = Date.parse(questionAt);
  const askedMs = Number.isNaN(parsedQuestion) ? now.getTime() : parsedQuestion;
  const askedAt = new Date(askedMs).toISOString();
  const answeredAt = new Date(Math.max(now.getTime(), askedMs + 1)).toISOString();
  return { askedAt, answeredAt };
}

/** Pytanie przed odpowiedzią, gdy znacznik czasu jest wspólny (starsze zapisy). */
export function compareHistoryMessages(
  left: { created_at: string; role: string },
  right: { created_at: string; role: string },
): number {
  if (left.created_at < right.created_at) {
    return -1;
  }
  if (left.created_at > right.created_at) {
    return 1;
  }
  if (left.role === right.role) {
    return 0;
  }
  return left.role === 'user' ? -1 : 1;
}

/** Obcina listę wiadomości do ostatnich N wymian (user+assistant). */
export function trimTurnsToLimit<T extends Pick<StoredChatTurn, 'role' | 'content'>>(
  rows: T[],
  turnLimit: number,
): T[] {
  const maxMessages = Math.max(1, turnLimit) * 2;
  if (rows.length <= maxMessages) {
    return rows;
  }
  return rows.slice(rows.length - maxMessages);
}

/**
 * Składa historię użytkownika: najwyżej 5 konwersacji (w podanej kolejności)
 * i w każdej ostatnie wiadomości, chronologicznie (pytanie przed odpowiedzią).
 */
export function assembleParticipantHistory(
  participantId: string,
  conversations: ConversationRow[],
  messages: GuideMessageRow[],
): ParticipantHistory {
  const selected = conversations.slice(0, PARTICIPANT_HISTORY_CONVERSATION_LIMIT);
  const allowed = new Set(selected.map((row) => row.conversation_id));
  const grouped = new Map<string, GuideMessageRow[]>();

  for (const message of messages) {
    if (!allowed.has(message.conversation_id)) {
      continue;
    }
    const list = grouped.get(message.conversation_id) ?? [];
    list.push(message);
    grouped.set(message.conversation_id, list);
  }

  return {
    participantId,
    conversations: selected.map((row) => {
      const chronological = [...(grouped.get(row.conversation_id) ?? [])].sort(
        compareHistoryMessages,
      );
      const recent = chronological.slice(-PARTICIPANT_HISTORY_MESSAGE_LIMIT);
      return {
        conversationId: row.conversation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages: recent.map((message) => ({
          messageId: message.message_id,
          role: message.role,
          content: message.content,
          createdAt: message.created_at,
        })),
      };
    }),
  };
}