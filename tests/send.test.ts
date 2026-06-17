import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yuanbaoMessageToPrompt } from '../src/adapter/inbound.js';

test('yuanbaoMessageToPrompt maps text to one text block', async () => {
  const blocks = await yuanbaoMessageToPrompt({
    msgId: 'm1',
    fromAccount: 'u1',
    toAccount: 'bot-1',
    senderNickname: 'alice',
    chatId: 'dm:u1',
    chatType: 'dm',
    text: 'hello',
    timestamp: Date.now(),
  });

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: 'text', text: 'hello' });
});

test('yuanbaoMessageToPrompt falls back on empty content', async () => {
  const blocks = await yuanbaoMessageToPrompt({
    msgId: 'm2',
    fromAccount: 'u2',
    toAccount: 'bot-1',
    senderNickname: 'bob',
    chatId: 'group:g1',
    chatType: 'group',
    text: '   ',
    timestamp: Date.now(),
  });

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: 'text', text: '[empty message]' });
});
