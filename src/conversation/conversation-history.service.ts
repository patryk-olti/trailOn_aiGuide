import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../cloudflare/d1.service';
import {
  assembleParticipantHistory,
  PARTICIPANT_HISTORY_CONVERSATION_LIMIT,
  PARTICIPANT_HISTORY_MESSAGE_LIMIT,
  trimTurnsToLimit,
} from './conversation-history.helpers';
import {
  StoredChatTurn,
  ConversationRow,
  GuideMessageRow,
  ParticipantHistory,
} from './conversation.types';

@Injectable()
export class ConversationHistoryService {
  private readonly conversationsTable: string;
  private readonly messagesTable: string;
  private readonly historyTurnLimit: number;

  constructor(
    private readonly d1: D1Service,
    config: ConfigService,
  ) {
    this.conversationsTable = this.d1.assertTableName(
      config.getOrThrow<string>('CF_D1_CONVERSATIONS_TABLE'),
    );
    this.messagesTable = this.d1.assertTableName(
      config.getOrThrow<string>('CF_D1_MESSAGES_TABLE'),
    );
    this.historyTurnLimit = config.getOrThrow<number>('GUIDE_HISTORY_TURN_LIMIT');
  }

  /**
   * Zwraca istniejącą rozmowę po weryfikacji właściciela lub tworzy nową.
   */
  async resolveConversation(
    participantId: string,
    conversationId?: string,
  ): Promise<string> {
    const trimmedParticipant = participantId.trim();
    if (!trimmedParticipant) {
      throw new ForbiddenException('participantId jest wymagany.');
    }

    if (conversationId?.trim()) {
      const id = conversationId.trim();
      const rows = await this.d1.query<ConversationRow>(
        `SELECT conversation_id, participant_id FROM ${this.conversationsTable} WHERE conversation_id = ? LIMIT 1`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundException('Nie znaleziono rozmowy o podanym conversationId.');
      }
      if (row.participant_id !== trimmedParticipant) {
        throw new ForbiddenException('Rozmowa nie należy do tego uczestnika.');
      }
      return row.conversation_id;
    }

    const newId = randomUUID();
    const now = new Date().toISOString();
    await this.d1.query(
      `INSERT INTO ${this.conversationsTable} (conversation_id, participant_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [newId, trimmedParticipant, now, now],
    );
    return newId;
  }

  /**
   * Ostatnie konwersacje uczestnika (max 5) wraz z ostatnimi wiadomościami każdej z nich (max 5).
   */
  async getHistoryForParticipant(participantId: string): Promise<ParticipantHistory> {
    const trimmedParticipant = participantId.trim();
    if (!trimmedParticipant || trimmedParticipant.length > 256) {
      throw new BadRequestException('participantId musi mieć od 1 do 256 znaków.');
    }

    const conversations = await this.d1.query<ConversationRow>(
      `SELECT conversation_id, participant_id, created_at, updated_at FROM ${this.conversationsTable} WHERE participant_id = ? ORDER BY updated_at DESC LIMIT ?`,
      [trimmedParticipant, PARTICIPANT_HISTORY_CONVERSATION_LIMIT],
    );
    if (conversations.length === 0) {
      return assembleParticipantHistory(trimmedParticipant, [], []);
    }

    const placeholders = conversations.map(() => '?').join(', ');
    const messages = await this.d1.query<GuideMessageRow>(
      `SELECT message_id, conversation_id, role, content, created_at FROM (
        SELECT message_id, conversation_id, role, content, created_at,
               ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
        FROM ${this.messagesTable}
        WHERE conversation_id IN (${placeholders})
      ) ranked
      WHERE rn <= ?`,
      [...conversations.map((row) => row.conversation_id), PARTICIPANT_HISTORY_MESSAGE_LIMIT],
    );

    return assembleParticipantHistory(trimmedParticipant, conversations, messages);
  }

  async getRecentTurns(conversationId: string): Promise<StoredChatTurn[]> {
    const fetchLimit = Math.max(1, this.historyTurnLimit) * 2;
    const rows = await this.d1.query<GuideMessageRow>(
      `SELECT role, content FROM ${this.messagesTable} WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
      [conversationId, fetchLimit],
    );
    const chronologic = [...rows].reverse();
    return trimTurnsToLimit(chronologic, this.historyTurnLimit).map((row) => ({
      role: row.role,
      content: row.content,
    }));
  }

  /**
   * Zapisuje parę pytanie/odpowiedź po udanym wygenerowaniu odpowiedzi.
   */
  async appendExchange(
    conversationId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();

    await this.d1.query(
      `INSERT INTO ${this.messagesTable} (message_id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      [userMessageId, conversationId, question, now],
    );
    await this.d1.query(
      `INSERT INTO ${this.messagesTable} (message_id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`,
      [assistantMessageId, conversationId, answer, now],
    );
    await this.d1.query(
      `UPDATE ${this.conversationsTable} SET updated_at = ? WHERE conversation_id = ?`,
      [now, conversationId],
    );
  }
}