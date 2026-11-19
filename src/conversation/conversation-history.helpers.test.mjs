import assert from 'node:assert/strict';
import test from 'node:test';
import { trimTurnsToLimit } from '../../dist/conversation/conversation-history.helpers.js';

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