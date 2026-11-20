import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleParticipantHistory,
  compareHistoryMessages,
  exchangeTimestamps,
  PARTICIPANT_HISTORY_MESSAGE_LIMIT,
  trimTurnsToLimit,
} from '../../dist/conversation/conversation-history.helpers.js';

test('trimTurnsToLimit zostawia ostatnie N wymian', () => {
  const rows = [
    { role: 'user', content: '1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: '2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: '3' },
    { role: 'assistant', content: 'a3' },
  ];
  const trimmed = trimTurnsToLimit(rows, 2);
  assert.deepEqual(trimmed, [
    { role: 'user', content: '2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: '3' },
    { role: 'assistant', content: 'a3' },
  ]);
});

test('trimTurnsToLimit bez obcinania gdy mieszczą się w limicie', () => {
  const rows = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(trimTurnsToLimit(rows, 5), rows);
});

function conversation(id, updatedAt) {
  return {
    conversation_id: id,
    participant_id: '48291',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: updatedAt,
  };
}

function message(id, conversationId, createdAt, content) {
  return {
    message_id: id,
    conversation_id: conversationId,
    role: createdAt.endsWith('1') ? 'user' : 'assistant',
    content,
    created_at: createdAt,
  };
}

test('exchangeTimestamps rozdziela przyjście pytania i zapis odpowiedzi', () => {
  const stamps = exchangeTimestamps(
    '2026-11-19T13:22:01.482Z',
    new Date('2026-11-19T13:22:08.100Z'),
  );
  assert.equal(stamps.askedAt, '2026-11-19T13:22:01.482Z');
  assert.equal(stamps.answeredAt, '2026-11-19T13:22:08.100Z');
  assert.ok(stamps.askedAt < stamps.answeredAt);
});

test('exchangeTimestamps nie skleja pary w tej samej milisekundzie', () => {
  const stamps = exchangeTimestamps(
    '2026-11-19T13:22:01.482Z',
    new Date('2026-11-19T13:22:01.482Z'),
  );
  assert.equal(stamps.askedAt, '2026-11-19T13:22:01.482Z');
  assert.equal(stamps.answeredAt, '2026-11-19T13:22:01.483Z');
});

test('compareHistoryMessages układa wspólny znacznik: pytanie, potem odpowiedź', () => {
  const shared = '2026-11-19T13:33:00.000Z';
  const rows = [
    { created_at: '2026-11-19T13:55:00.000Z', role: 'user', content: 'karpacz' },
    { created_at: '2026-11-19T13:33:00.000Z', role: 'user', content: 'pogoda' },
    { created_at: '2026-11-19T13:34:00.000Z', role: 'user', content: 'trasy' },
    { created_at: shared, role: 'assistant', content: 'odpowiedz-pogoda' },
    { created_at: '2026-11-19T13:34:00.000Z', role: 'assistant', content: 'odpowiedz-trasy' },
  ];
  const ordered = [...rows].sort(compareHistoryMessages);
  assert.deepEqual(
    ordered.map((row) => row.content),
    ['pogoda', 'odpowiedz-pogoda', 'trasy', 'odpowiedz-trasy', 'karpacz'],
  );
});

test('assembleParticipantHistory trzyma pełne pary przy wspólnym znaczniku', () => {
  const pairs = [
    ['2026-11-20T08:01:04.196Z', 'q1', 'a1'],
    ['2026-11-20T08:02:38.298Z', 'q2', 'a2'],
    ['2026-11-20T08:03:35.152Z', 'q3', 'a3'],
  ];
  const messages = pairs.flatMap(([createdAt, question, answer], index) => [
    {
      message_id: `a-${index}`,
      conversation_id: 'thread',
      role: 'assistant',
      content: answer,
      created_at: createdAt,
    },
    {
      message_id: `q-${index}`,
      conversation_id: 'thread',
      role: 'user',
      content: question,
      created_at: createdAt,
    },
  ]);
  const history = assembleParticipantHistory('48291', [conversation('thread', pairs[2][0])], messages);
  assert.deepEqual(
    history.conversations[0].messages.map((message) => message.content),
    ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'],
  );
});

test('assembleParticipantHistory zostawia 5 konwersacji i ostatnie wiadomości', () => {
  const conversations = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id, index) =>
    conversation(id, `2026-11-0${index + 1}T00:00:00.000Z`),
  );
  const total = PARTICIPANT_HISTORY_MESSAGE_LIMIT + 2;
  const messages = [];
  for (let index = 1; index <= total; index += 1) {
    const second = String(index).padStart(2, '0');
    messages.push(
      message(`m${index}`, 'c1', `2026-11-19T10:00:${second}.000Z`, `tresc-${index}`),
    );
  }
  messages.push(message('other', 'c6', '2026-11-19T11:00:00.000Z', 'poza limitem'));

  const history = assembleParticipantHistory('48291', conversations, messages);

  assert.equal(history.participantId, '48291');
  assert.deepEqual(
    history.conversations.map((item) => item.conversationId),
    ['c1', 'c2', 'c3', 'c4', 'c5'],
  );
  assert.equal(history.conversations[0].messages.length, PARTICIPANT_HISTORY_MESSAGE_LIMIT);
  assert.equal(history.conversations[0].messages[0].content, 'tresc-3');
  assert.equal(
    history.conversations[0].messages.at(-1).content,
    `tresc-${total}`,
  );
  assert.equal(history.conversations[1].messages.length, 0);
});