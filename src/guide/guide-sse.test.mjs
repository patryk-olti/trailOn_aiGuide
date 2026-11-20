import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeSseEvent } from '../../dist/guide/guide-sse.js';

test('ramka SSE ma event, jedną linię data i pustą linię końca', () => {
  const frame = encodeSseEvent('delta', { text: 'Wielka\nSowa' });
  assert.equal(frame, 'event: delta\ndata: {"text":"Wielka\\nSowa"}\n\n');
  assert.equal(frame.split('\n').filter((line) => line.startsWith('data: ')).length, 1);
});

test('zdarzenie done niesie końcową odpowiedź', () => {
  const frame = encodeSseEvent('done', { conversationId: 'abc', response: '<p>ok</p>' });
  assert.match(frame, /^event: done\n/);
  const data = JSON.parse(frame.split('\n')[1].slice('data: '.length));
  assert.equal(data.conversationId, 'abc');
  assert.equal(data.response, '<p>ok</p>');
});
