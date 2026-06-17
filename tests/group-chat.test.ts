import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { YuanbaoAcpBridge } from '../src/bridge.js';
import { defaultConfig } from '../src/config.js';
import { getGroupChatState } from '../src/storage/state.js';
import type { IncomingMessage } from '../src/yuanbao/yuanbao-client.js';

function makeGroupMsg(text: string): IncomingMessage {
  return {
    msgId: `msg-${Date.now()}`,
    fromAccount: 'u1',
    toAccount: 'bot-1',
    senderNickname: 'alice',
    chatId: 'group:g1',
    chatType: 'group',
    groupCode: 'g1',
    groupName: 'g1',
    text,
    timestamp: Date.now(),
  };
}

test('group management command on/off/reset/status updates persisted state', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yb-state-'));
  const cfg = defaultConfig({ instance: 'test-instance' });
  cfg.yuanbao.botId = 'bot-1';
  cfg.storage.stateFile = path.join(tempDir, 'state.json');

  const bridge = new YuanbaoAcpBridge(cfg, () => {}) as any;
  bridge.sessionManager = { resetSession: async () => true };

  const replies: string[] = [];
  bridge.sendReply = async (_chatId: string, _ctx: string, text: string) => {
    replies.push(text);
  };

  await bridge.handleGroupManagementCommand(makeGroupMsg('/acp off'), 'ctx');
  let state = await getGroupChatState(cfg.storage.stateFile!, 'group:g1');
  assert.equal(state.enabled, false);

  await bridge.handleGroupManagementCommand(makeGroupMsg('/acp on'), 'ctx');
  state = await getGroupChatState(cfg.storage.stateFile!, 'group:g1');
  assert.equal(state.enabled, true);

  await bridge.handleGroupManagementCommand(makeGroupMsg('/acp reset'), 'ctx');
  state = await getGroupChatState(cfg.storage.stateFile!, 'group:g1');
  assert.ok(state.resetAt);

  await bridge.handleGroupManagementCommand(makeGroupMsg('/acp status'), 'ctx');
  assert.ok(replies.some((r) => r.includes('当前群会话状态')));
});

test('group trigger requires enabled state and @bot/reply signal', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yb-state-'));
  const cfg = defaultConfig({ instance: 'test-instance-2' });
  cfg.yuanbao.botId = 'bot-1';
  cfg.storage.stateFile = path.join(tempDir, 'state.json');

  const bridge = new YuanbaoAcpBridge(cfg, () => {}) as any;

  await bridge.handleGroupManagementCommand(makeGroupMsg('/acp off'), 'ctx');
  let triggered = await bridge.shouldTriggerGroupSession(
    makeGroupMsg('@bot-1 hi'),
  );
  assert.equal(triggered, false);

  await bridge.handleGroupManagementCommand(makeGroupMsg('/acp on'), 'ctx');
  triggered = await bridge.shouldTriggerGroupSession(
    makeGroupMsg('hello everyone'),
  );
  assert.equal(triggered, false);

  const mentionMsg = makeGroupMsg('hello everyone');
  mentionMsg.mentions = ['bot-1'];
  triggered = await bridge.shouldTriggerGroupSession(mentionMsg);
  assert.equal(triggered, true);

  const mentionFallbackMsg = makeGroupMsg('@H3你好');
  mentionFallbackMsg.mentions = ['H3你好'];
  triggered = await bridge.shouldTriggerGroupSession(mentionFallbackMsg);
  assert.equal(triggered, true);

  const mentionByNicknameMsg = makeGroupMsg('@H3你好');
  mentionByNicknameMsg.mentions = ['H3你好'];
  mentionByNicknameMsg.mentionAccounts = ['bot-1'];
  triggered = await bridge.shouldTriggerGroupSession(mentionByNicknameMsg);
  assert.equal(triggered, true);

  const replyMsg = makeGroupMsg('follow up');
  replyMsg.replyToMsgId = 'last-bot-msg';
  triggered = await bridge.shouldTriggerGroupSession(replyMsg);
  assert.equal(triggered, true);
});
