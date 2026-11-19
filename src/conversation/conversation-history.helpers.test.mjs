import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleParticipantHistory,
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

test('assembleParticipantHistory zostawia 5 konwersacji i 5 ostatnich wiadomości', () => {
  const conversations = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id, index) =>
    conversation(id, `2026-11-0${index + 1}T00:00:00.000Z`),
  );
  const messages = [];
  for (let index = 1; index <= 7; index += 1) {
    messages.push(
      message(`m${index}`, 'c1', `2026-11-19T10:00:0${index}.000Z`, `tresc-${index}`),
    );
  }
  messages.push(message('other', 'c6', '2026-11-19T11:00:00.000Z', 'poza limitem'));

  const history = assembleParticipantHistory('48291', conversations, messages);

  assert.equal(history.participantId, '48291');
  assert.deepEqual(
    history.conversations.map((item) => item.conversationId),
    ['c1', 'c2', 'c3', 'c4', 'c5'],
  );
  assert.deepEqual(
    history.conversations[0].messages.map((item) => item.content),
    ['tresc-3', 'tresc-4', 'tresc-5', 'tresc-6', 'tresc-7'],
  );
  assert.equal(history.conversations[1].messages.length, 0);
});