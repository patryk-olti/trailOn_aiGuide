import type { StoredChatTurn } from './conversation.types';

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