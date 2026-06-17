import type * as acp from '@agentclientprotocol/sdk';
import { SessionManager } from './acp/session.js';
import { yuanbaoMessageToPrompt } from './adapter/inbound.js';
import type { YuanbaoAcpConfig, YuanBaoAcpConfig } from './config.js';
import {
  BRIDGE_COMMANDS,
  resolveCommandAliases,
  resolveCommandNames,
} from './config.js';
import { InjectionMonitor } from './inject/monitor.js';
import type { InjectedMessage } from './inject/types.js';
import {
  resolveUserTarget,
  updateLastActiveUser,
  getGroupChatState,
  setGroupChatEnabled,
  markGroupChatReset,
} from './storage/state.js';
import { formatError } from './acp/agent-manager.js';
import { trackEvent, trackException, hashUserId } from './telemetry/index.js';
import type { IncomingMessage } from './yuanbao/yuanbao-client.js';
import { YuanbaoClient } from './yuanbao/yuanbao-client.js';

const ACP_CONFIG_COMMAND = BRIDGE_COMMANDS.acpConfig;
const ACP_CANCEL_COMMAND = BRIDGE_COMMANDS.acpCancel;
const BUFFER_START_COMMAND = BRIDGE_COMMANDS.promptStart;
const BUFFER_DONE_COMMAND = BRIDGE_COMMANDS.promptDone;
const GROUP_MGMT_COMMAND = '/acp';
const TEXT_CHUNK_LIMIT = 4000;
const BUFFER_TTL_MS = 10 * 60 * 1000;
const BUFFER_MAX_BLOCKS = 50;

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf('\n', maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    segments.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, '');
  }
  return segments;
}

export class YuanbaoAcpBridge {
  private config: YuanbaoAcpConfig;
  private sessionManager: SessionManager | null = null;
  private injectionMonitor: InjectionMonitor | null = null;
  private yuanbaoClient: YuanbaoClient | null = null;
  private stateUpdate = Promise.resolve();
  private sendChains = new Map<string, Promise<void>>();
  private started = false;

  private messageBuffers = new Map<
    string,
    {
      blocks: acp.ContentBlock[];
      contextToken: string;
      pending: Promise<void>;
      lastUpdatedAt: number;
    }
  >();
  private bufferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bufferFlushing = new Map<string, Promise<void>>();

  private log: (msg: string) => void;

  constructor(config: YuanbaoAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[yuanbao-acp] ${msg}`));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.config.yuanbao.appId || !this.config.yuanbao.appSecret) {
      throw new Error('--yuanbao-app-id and --yuanbao-app-secret are required');
    }

    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      agentPreset: this.config.agent.preset ?? 'raw',
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      showDiffs: this.config.agent.showDiffs ?? false,
      log: this.log,
      onReply: (chatId, contextToken, text) =>
        this.sendReply(chatId, contextToken, text),
      sendTyping: (chatId) => this.sendTypingIndicator(chatId),
    });
    this.sessionManager.start();

    if (this.config.storage.injectDir && this.config.storage.stateFile) {
      this.injectionMonitor = new InjectionMonitor({
        injectDir: this.config.storage.injectDir,
        log: this.log,
        onMessage: (job) => this.enqueueInjectedMessage(job),
      });
      await this.injectionMonitor.start();
      this.log(`Injection queue: ${this.config.storage.injectDir}`);
    }

    this.yuanbaoClient = new YuanbaoClient({
      appId: this.config.yuanbao.appId,
      appSecret: this.config.yuanbao.appSecret,
      botId: this.config.yuanbao.botId,
      wsUrl: this.config.yuanbao.wsUrl,
      apiDomain: this.config.yuanbao.apiDomain,
      routeEnv: this.config.yuanbao.routeEnv,
    });

    this.yuanbaoClient.onMessage((msg) => {
      this.handleMessage(msg).catch((err) => {
        this.log(`Failed to handle message ${msg.msgId}: ${formatError(err)}`);
        trackException(err, 'enqueue', hashUserId(msg.chatId));
      });
    });

    const connected = await this.yuanbaoClient.connect();
    if (!connected) {
      throw new Error('Failed to connect Yuanbao client');
    }

    this.started = true;
    this.log('Yuanbao bridge started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.log('Stopping bridge...');
    this.yuanbaoClient?.disconnect();
    this.yuanbaoClient = null;
    await this.injectionMonitor?.stop();
    await this.sessionManager?.stop();
    await this.stateUpdate.catch(() => {});
    this.started = false;
    this.log('Bridge stopped');
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const chatId = msg.chatId;
    const contextToken = msg.msgId;

    this.log(`Message from ${chatId}: ${this.previewMessage(msg.text)}`);
    this.rememberActiveUser(chatId, contextToken);

    trackEvent(
      'message.received',
      { userIdHash: hashUserId(chatId), kind: msg.chatType },
      hashUserId(chatId),
    );

    if (msg.chatType === 'group') {
      if (await this.handleGroupManagementCommand(msg, contextToken)) {
        return;
      }
      if (!(await this.shouldTriggerGroupSession(msg))) {
        this.log(`[group] skipped ${chatId}: trigger check failed`);
        return;
      }
    }

    const acpConfigCommand = this.extractBridgeCommand(
      msg.text,
      ACP_CONFIG_COMMAND,
    );
    if (acpConfigCommand) {
      await this.handleAcpConfigCommand(acpConfigCommand, chatId, contextToken);
      return;
    }

    const acpCancelCommand = this.extractBridgeCommand(
      msg.text,
      ACP_CANCEL_COMMAND,
    );
    if (acpCancelCommand) {
      await this.handleAcpCancelCommand(acpCancelCommand, chatId, contextToken);
      return;
    }

    if (this.extractBridgeCommand(msg.text, BUFFER_START_COMMAND)) {
      this.handleBufferStart(chatId, contextToken);
      return;
    }

    if (this.extractBridgeCommand(msg.text, BUFFER_DONE_COMMAND)) {
      await this.handleBufferDone(chatId, contextToken);
      return;
    }

    if (this.messageBuffers.has(chatId)) {
      this.appendToBuffer(msg, chatId, contextToken);
      return;
    }

    const waitForFlush = this.bufferFlushing.get(chatId);
    const enqueue = waitForFlush
      ? waitForFlush.then(() => this.enqueueMessage(msg, chatId, contextToken))
      : this.enqueueMessage(msg, chatId, contextToken);
    await enqueue;
  }

  private async shouldTriggerGroupSession(
    msg: IncomingMessage,
  ): Promise<boolean> {
    const hasMention = this.isMentionTrigger(msg);
    const hasReply = !!msg.replyToMsgId;
    if (!this.config.storage.stateFile) {
      return hasMention || hasReply;
    }
    const state = await getGroupChatState(
      this.config.storage.stateFile,
      msg.chatId,
    );
    if (!state.enabled) {
      this.log(`[group] ${msg.chatId} not enabled (send /acp on to enable)`);
      return false;
    }
    if (!hasMention && !hasReply) {
      this.log(
        `[group] ${msg.chatId} no mention/reply trigger (botId=${this.yuanbaoClient?.getBotId() ?? this.config.yuanbao.botId ?? '<empty>'}, mentionAccounts=${JSON.stringify(msg.mentionAccounts ?? [])}, mentions=${JSON.stringify(msg.mentions ?? [])})`,
      );
    }
    return hasMention || hasReply;
  }

  private isMentionTrigger(msg: IncomingMessage): boolean {
    const botId =
      this.yuanbaoClient?.getBotId() ?? this.config.yuanbao.botId ?? '';
    if (!botId) return false;
    const normalize = (value: string): string =>
      value.trim().replace(/^@+/, '');
    const normalizedBotId = normalize(botId);

    if (
      (msg.mentionAccounts ?? []).some(
        (account) => normalize(account) === normalizedBotId,
      )
    ) {
      return true;
    }

    if (
      (msg.mentions ?? []).some(
        (mention) => normalize(mention) === normalizedBotId,
      )
    ) {
      return true;
    }

    // Fallback for group messages where mention parsing only yields display names
    // (e.g. "@H3你好") and account-level mention metadata is missing.
    if (
      (msg.mentions?.length ?? 0) > 0 &&
      normalize(msg.toAccount || '') === normalizedBotId
    ) {
      return true;
    }

    const text = msg.text || '';
    return text.includes(`@${botId}`);
  }

  private async handleGroupManagementCommand(
    msg: IncomingMessage,
    contextToken: string,
  ): Promise<boolean> {
    const text = (msg.text || '').trim();
    if (!text.startsWith(GROUP_MGMT_COMMAND)) return false;

    const args = text.split(/\s+/);
    const sub = (args[1] ?? 'status').toLowerCase();
    if (!this.config.storage.stateFile) {
      await this.sendReply(
        msg.chatId,
        contextToken,
        '⚠️ Group management requires storage.stateFile to persist state.',
      );
      return true;
    }

    switch (sub) {
      case 'on': {
        await setGroupChatEnabled(
          this.config.storage.stateFile,
          msg.chatId,
          true,
        );
        await this.sendReply(
          msg.chatId,
          contextToken,
          '✅ 当前群会话已开启（支持 @bot / reply 触发）',
        );
        return true;
      }
      case 'off': {
        await setGroupChatEnabled(
          this.config.storage.stateFile,
          msg.chatId,
          false,
        );
        await this.sendReply(
          msg.chatId,
          contextToken,
          '✅ 当前群会话已关闭（仅保留 /acp 管理指令）',
        );
        return true;
      }
      case 'reset': {
        await this.sessionManager?.resetSession(msg.chatId);
        await markGroupChatReset(this.config.storage.stateFile, msg.chatId);
        await this.sendReply(
          msg.chatId,
          contextToken,
          '✅ 当前群会话上下文已重置',
        );
        return true;
      }
      case 'status':
      default: {
        const state = await getGroupChatState(
          this.config.storage.stateFile,
          msg.chatId,
        );
        const enabled = state.enabled ? '开启' : '关闭';
        const resetAt = state.resetAt ?? '无';
        await this.sendReply(
          msg.chatId,
          contextToken,
          `📋 当前群会话状态\n- 开关: ${enabled}\n- 最近重置: ${resetAt}`,
        );
        return true;
      }
    }
  }

  private async enqueueMessage(
    msg: IncomingMessage,
    chatId: string,
    contextToken: string,
  ): Promise<void> {
    const prompt = await yuanbaoMessageToPrompt(msg);
    await this.sessionManager!.enqueue(chatId, { prompt, contextToken });
  }

  private async enqueueInjectedMessage(job: InjectedMessage): Promise<void> {
    if (!this.sessionManager || !this.config.storage.stateFile) {
      throw new Error('Bridge is not ready to process injected messages');
    }

    const target = await resolveUserTarget(
      this.config.storage.stateFile,
      job.target,
      job.contextToken,
    );
    const prompt: acp.ContentBlock[] = [{ type: 'text', text: job.text }];
    await this.sessionManager.enqueueAndWait(target.userId, {
      prompt,
      contextToken: target.contextToken,
    });
  }

  private async handleAcpConfigCommand(
    command: string,
    chatId: string,
    contextToken: string,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length === 1) {
      const options = this.sessionManager?.getSessionConfigOptions(chatId);
      if (!options || options.length === 0) {
        await this.sendReply(chatId, contextToken, '当前会话没有可配置项。');
        return;
      }
      const lines = options.map((o) => `- ${o.id} (${o.type})`);
      await this.sendReply(
        chatId,
        contextToken,
        `⚙️ ACP Config\n${lines.join('\n')}`,
      );
      return;
    }

    if (args[1] === 'set') {
      if (args.length < 4) {
        await this.sendReply(
          chatId,
          contextToken,
          `${ACP_CONFIG_COMMAND} set <configId> <value>`,
        );
        return;
      }
      const configId = args[2]!;
      const rawValue = args.slice(3).join(' ');
      const normalized = this.normalizeConfigValue(rawValue);
      await this.sessionManager!.setSessionConfigOption(
        chatId,
        configId,
        normalized,
      );
      await this.sendReply(
        chatId,
        contextToken,
        `✅ Updated ${configId} = ${String(normalized)}`,
      );
      return;
    }

    await this.sendReply(
      chatId,
      contextToken,
      `${ACP_CONFIG_COMMAND} set <configId> <value>`,
    );
  }

  private normalizeConfigValue(raw: string): string | boolean {
    const v = raw.trim().toLowerCase();
    if (['true', 'on', '1', 'yes'].includes(v)) return true;
    if (['false', 'off', '0', 'no'].includes(v)) return false;
    return raw;
  }

  private async handleAcpCancelCommand(
    command: string,
    chatId: string,
    contextToken: string,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    const drainQueue = args[1]?.toLowerCase() === 'all';
    const result = await this.sessionManager!.cancelCurrent(chatId, {
      drainQueue,
    });
    await this.sendReply(
      chatId,
      contextToken,
      `🛑 cancel=${result.cancelledTurn}, dropped=${result.droppedQueueCount}`,
    );
  }

  private handleBufferStart(chatId: string, contextToken: string): void {
    if (this.messageBuffers.has(chatId)) {
      void this.sendReply(
        chatId,
        contextToken,
        '📝 已在缓冲模式，继续发送后用 /acp-prompt-done 提交。',
      );
      return;
    }

    this.messageBuffers.set(chatId, {
      blocks: [],
      contextToken,
      pending: Promise.resolve(),
      lastUpdatedAt: Date.now(),
    });
    this.resetBufferTimer(chatId);
    void this.sendReply(
      chatId,
      contextToken,
      '📝 缓冲模式已开启，发送 /acp-prompt-done 提交。',
    );
  }

  private handleBufferDone(
    chatId: string,
    contextToken: string,
  ): Promise<void> {
    const buffer = this.messageBuffers.get(chatId);
    if (!buffer) {
      return this.sendReply(
        chatId,
        contextToken,
        '⚠️ 当前没有缓冲内容，请先发送 /acp-prompt-start。',
      );
    }

    const pending = buffer.pending;
    this.messageBuffers.delete(chatId);
    this.clearBufferTimer(chatId);

    const flushPromise = this.doFlush(chatId, contextToken, buffer, pending);
    this.bufferFlushing.set(chatId, flushPromise);
    flushPromise.finally(() => {
      if (this.bufferFlushing.get(chatId) === flushPromise) {
        this.bufferFlushing.delete(chatId);
      }
    });
    return flushPromise;
  }

  private async doFlush(
    chatId: string,
    contextToken: string,
    buffer: {
      blocks: acp.ContentBlock[];
      contextToken: string;
      pending: Promise<void>;
      lastUpdatedAt: number;
    },
    pending: Promise<void>,
  ): Promise<void> {
    await pending;

    if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
      await this.sendReply(chatId, contextToken, '⚠️ 缓冲已超时，请重新开始。');
      return;
    }

    if (buffer.blocks.length === 0) {
      await this.sendReply(chatId, contextToken, '⚠️ 缓冲为空。');
      return;
    }

    await this.sessionManager!.enqueue(chatId, {
      prompt: buffer.blocks,
      contextToken: buffer.contextToken,
    });
  }

  private appendToBuffer(
    msg: IncomingMessage,
    chatId: string,
    contextToken: string,
  ): void {
    const buffer = this.messageBuffers.get(chatId);
    if (!buffer) return;

    buffer.pending = buffer.pending.then(async () => {
      if (!this.messageBuffers.has(chatId)) return;
      if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
        this.messageBuffers.delete(chatId);
        await this.sendReply(chatId, contextToken, '⚠️ 缓冲超时，请重新开始。');
        return;
      }
      if (buffer.blocks.length >= BUFFER_MAX_BLOCKS) {
        await this.sendReply(
          chatId,
          contextToken,
          `⚠️ 缓冲已满（${BUFFER_MAX_BLOCKS} 块）。`,
        );
        return;
      }

      const prompt = await yuanbaoMessageToPrompt(msg);
      buffer.blocks.push(...prompt);
      buffer.contextToken = contextToken;
      buffer.lastUpdatedAt = Date.now();
      this.resetBufferTimer(chatId);
    });

    buffer.pending.catch((err) => {
      this.log(`Failed to buffer message from ${chatId}: ${String(err)}`);
      trackException(err, 'buffer', hashUserId(chatId));
    });
  }

  private resetBufferTimer(chatId: string): void {
    this.clearBufferTimer(chatId);
    this.bufferTimers.set(
      chatId,
      setTimeout(() => {
        this.messageBuffers.delete(chatId);
        this.bufferTimers.delete(chatId);
      }, BUFFER_TTL_MS),
    );
  }

  private clearBufferTimer(chatId: string): void {
    const timer = this.bufferTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.bufferTimers.delete(chatId);
    }
  }

  private rememberActiveUser(chatId: string, contextToken: string): void {
    if (!this.config.storage.stateFile) return;
    this.stateUpdate = this.stateUpdate
      .catch(() => {})
      .then(() =>
        updateLastActiveUser(
          this.config.storage.stateFile!,
          chatId,
          contextToken,
        ),
      );
  }

  private async sendReply(
    chatId: string,
    _contextToken: string,
    text: string,
  ): Promise<void> {
    const previous = this.sendChains.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const segments = splitText(text, TEXT_CHUNK_LIMIT);
        for (const segment of segments) {
          this.yuanbaoClient?.sendMessage(chatId, segment);
        }
        this.yuanbaoClient?.stopReplyHeartbeat(chatId, true);
      });
    this.sendChains.set(
      chatId,
      current.catch(() => {}),
    );
    await current;
  }

  private async sendTypingIndicator(chatId: string): Promise<void> {
    this.yuanbaoClient?.startReplyHeartbeat(chatId);
  }

  private previewMessage(text: string): string {
    const t = text.trim();
    return t.length > 80 ? `${t.slice(0, 80)}...` : t;
  }

  private extractBridgeCommand(text: string, canonical: string): string | null {
    const raw = text.trim();
    const names = resolveCommandNames(canonical, this.config.commandAliases);
    for (const name of names) {
      if (raw === name) return canonical;
      if (name.startsWith('/') && raw.startsWith(`${name} `)) {
        return canonical + raw.slice(name.length);
      }
    }
    return null;
  }

  private aliasHint(canonical: string): string {
    const aliases = resolveCommandAliases(
      canonical,
      this.config.commandAliases,
    );
    return aliases.length > 0 ? ` (aliases: ${aliases.join(', ')})` : '';
  }
}

// Backward-compatible export names for older imports.
export { YuanbaoAcpBridge as YuanBaoAcpBridge };
export type { YuanbaoAcpConfig as YuanBaoAcpConfigCompat, YuanBaoAcpConfig };
