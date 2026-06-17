#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { YuanbaoAcpBridge } from '../src/bridge.js';
import {
  defaultConfig,
  defaultStorageDir,
  listBuiltInAgents,
  resolveAgentSelection,
  validateCommandAliases,
  validateInstanceName,
  DAEMON_ENV_VAR,
} from '../src/config.js';
import type { YuanbaoAcpConfig } from '../src/config.js';
import { queueInjectedMessage } from '../src/inject/queue.js';
import { DEFAULT_INJECTION_TARGET } from '../src/inject/types.js';
import {
  initTelemetry,
  trackEvent,
  trackException,
  shutdownTelemetry,
} from '../src/telemetry/index.js';
import packageJson from '../package.json' with { type: 'json' };

function usage(): void {
  const presets = listBuiltInAgents()
    .map(({ id }) => id)
    .join(', ');

  console.log(`
yuanbao-acp v${packageJson.version} — Bridge Tencent Yuanbao to any ACP-compatible AI agent

Usage:
  yuanbao-acp --agent <preset|command> [options]
  yuanbao-acp agents
  yuanbao-acp inject --text <text>
  yuanbao-acp stop
  yuanbao-acp status

Options:
  --agent <value>            Built-in preset or raw agent command
  --cwd <dir>                Working directory for agent
  --daemon                   Run in background
  --config <file>            Config file path (JSON)
  --instance <name>          Use isolated storage instance
  --yuanbao-app-id <id>      Yuanbao app id
  --yuanbao-app-secret <s>   Yuanbao app secret
  --yuanbao-bot-id <id>      Yuanbao bot id (optional)
  --yuanbao-ws-url <url>     Yuanbao websocket url
  --yuanbao-api-domain <u>   Yuanbao api domain
  --yuanbao-route-env <env>  Yuanbao route env
  --idle-timeout <m>         Session idle timeout in minutes
  --max-sessions <n>         Max concurrent sessions
  --hide-thoughts            Hide model thoughts
  --show-diffs               Show ACP diffs
  --text <text>              Message text for inject
  --file <path>              Read injection text from file
  --to <target>              Injection target (default: ${DEFAULT_INJECTION_TARGET})
  --context-token <token>    Override stored context token for inject
  -v, --verbose              Verbose logging
  -V, --version              Print version
  -h, --help                 Show help
`);
}

function parseArgs(argv: string[]): {
  command?: string;
  agent?: string;
  cwd?: string;
  daemon: boolean;
  configFile?: string;
  instance?: string;
  idleTimeout?: number;
  maxSessions?: number;
  injectText?: string;
  injectFile?: string;
  injectTo?: string;
  injectContextToken?: string;
  hideThoughts: boolean;
  showDiffs: boolean;
  verbose: boolean;
  version: boolean;
  help: boolean;
  yuanbaoAppId?: string;
  yuanbaoAppSecret?: string;
  yuanbaoBotId?: string;
  yuanbaoWsUrl?: string;
  yuanbaoApiDomain?: string;
  yuanbaoRouteEnv?: string;
} {
  const result = {
    daemon: false,
    hideThoughts: false,
    showDiffs: false,
    verbose: false,
    version: false,
    help: false,
  } as ReturnType<typeof parseArgs>;

  const args = argv.slice(2);
  let i = 0;

  if (args[0] && !args[0].startsWith('-')) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--agent':
        result.agent = args[++i];
        break;
      case '--cwd':
        result.cwd = args[++i];
        break;
      case '--daemon':
        result.daemon = true;
        break;
      case '--config':
        result.configFile = args[++i];
        break;
      case '--instance':
        result.instance = args[++i];
        break;
      case '--idle-timeout':
        result.idleTimeout = parseInt(args[++i], 10);
        break;
      case '--max-sessions':
        result.maxSessions = parseInt(args[++i], 10);
        break;
      case '--text':
        result.injectText = args[++i];
        break;
      case '--file':
        result.injectFile = args[++i];
        break;
      case '--to':
        result.injectTo = args[++i];
        break;
      case '--context-token':
        result.injectContextToken = args[++i];
        break;
      case '--hide-thoughts':
        result.hideThoughts = true;
        break;
      case '--show-diffs':
        result.showDiffs = true;
        break;
      case '--yuanbao-app-id':
        result.yuanbaoAppId = args[++i];
        break;
      case '--yuanbao-app-secret':
        result.yuanbaoAppSecret = args[++i];
        break;
      case '--yuanbao-bot-id':
        result.yuanbaoBotId = args[++i];
        break;
      case '--yuanbao-ws-url':
        result.yuanbaoWsUrl = args[++i];
        break;
      case '--yuanbao-api-domain':
        result.yuanbaoApiDomain = args[++i];
        break;
      case '--yuanbao-route-env':
        result.yuanbaoRouteEnv = args[++i];
        break;
      case '-v':
      case '--verbose':
        result.verbose = true;
        break;
      case '-V':
      case '--version':
        result.version = true;
        break;
      case '-h':
      case '--help':
        result.help = true;
        break;
      default:
        if (arg?.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

function loadConfigFile(filePath: string): Partial<YuanbaoAcpConfig> {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Partial<YuanbaoAcpConfig>;
}

function handleAgents(config: YuanbaoAcpConfig): void {
  console.log('Built-in ACP agent presets:\n');
  for (const { id, preset } of listBuiltInAgents(config.agents)) {
    const commandLine = [preset.command, ...preset.args].join(' ');
    console.log(`${id.padEnd(10)} ${commandLine}`);
    if (preset.description) console.log(`           ${preset.description}`);
  }
}

function handleStop(config: YuanbaoAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log('No daemon running (no PID file found)');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(pidFile);
    console.log(`Stopped daemon (PID ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      fs.unlinkSync(pidFile);
      console.log(`Daemon not running (stale PID ${pid}), cleaned up`);
    } else {
      console.error(`Failed to stop daemon: ${String(err)}`);
    }
  }
}

function handleStatus(config: YuanbaoAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log('Not running');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0);
    console.log(`Running (PID ${pid})`);
  } catch {
    console.log(`Not running (stale PID ${pid})`);
    fs.unlinkSync(pidFile);
  }
}

function daemonize(config: YuanbaoAcpConfig): void {
  const logFile = config.daemon.logFile;
  const pidFile = config.daemon.pidFile;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  const args = process.argv.slice(1).filter((a) => a !== '--daemon');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, [DAEMON_ENV_VAR]: '1' },
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), 'utf-8');
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  console.log(`PID file: ${pidFile}`);
  process.exit(0);
}

async function handleInject(
  config: YuanbaoAcpConfig,
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  if (!config.storage.injectDir) {
    throw new Error('storage.injectDir is not configured');
  }
  if (!args.injectText && !args.injectFile) {
    throw new Error('inject requires --text <text> or --file <path>');
  }
  if (args.injectText && args.injectFile) {
    throw new Error('inject accepts only one of --text or --file');
  }

  const text = args.injectFile
    ? fs.readFileSync(path.resolve(args.injectFile), 'utf-8')
    : args.injectText!;

  const { job, filePath } = await queueInjectedMessage({
    injectDir: config.storage.injectDir,
    text,
    target: args.injectTo,
    contextToken: args.injectContextToken,
  });

  console.log(`Queued injection ${job.id}`);
  console.log(`Target: ${job.target}`);
  console.log(`File: ${filePath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(packageJson.version);
    process.exit(0);
  }

  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.instance !== undefined) {
    try {
      validateInstanceName(args.instance);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const config = defaultConfig({ instance: args.instance });

  if (args.configFile) {
    const fileConfig = loadConfigFile(args.configFile);
    Object.assign(config.yuanbao, fileConfig.yuanbao ?? {});
    Object.assign(config.agent, fileConfig.agent ?? {});
    Object.assign(config.agents, fileConfig.agents ?? {});
    Object.assign(config.session, fileConfig.session ?? {});
    Object.assign(config.daemon, fileConfig.daemon ?? {});
    if (Object.prototype.hasOwnProperty.call(fileConfig, 'commandAliases')) {
      config.commandAliases = fileConfig.commandAliases;
    }
    Object.assign(config.storage, fileConfig.storage ?? {});
  }

  if (args.instance) {
    config.storage.instance = args.instance;
    config.storage.dir = defaultStorageDir(args.instance);
    config.daemon.logFile = path.join(config.storage.dir, 'yuanbao-acp.log');
    config.daemon.pidFile = path.join(config.storage.dir, 'daemon.pid');
    config.storage.stateFile = path.join(config.storage.dir, 'state.json');
    config.storage.injectDir = path.join(config.storage.dir, 'inject');
  }

  config.yuanbao.appId =
    args.yuanbaoAppId ?? process.env.YUANBAO_APP_ID ?? config.yuanbao.appId;
  config.yuanbao.appSecret =
    args.yuanbaoAppSecret ??
    process.env.YUANBAO_APP_SECRET ??
    config.yuanbao.appSecret;
  config.yuanbao.botId =
    args.yuanbaoBotId ?? process.env.YUANBAO_BOT_ID ?? config.yuanbao.botId;
  config.yuanbao.wsUrl =
    args.yuanbaoWsUrl ?? process.env.YUANBAO_WS_URL ?? config.yuanbao.wsUrl;
  config.yuanbao.apiDomain =
    args.yuanbaoApiDomain ??
    process.env.YUANBAO_API_DOMAIN ??
    config.yuanbao.apiDomain;
  config.yuanbao.routeEnv =
    args.yuanbaoRouteEnv ??
    process.env.YUANBAO_ROUTE_ENV ??
    config.yuanbao.routeEnv;

  if (config.storage.stateFile && !path.isAbsolute(config.storage.stateFile)) {
    config.storage.stateFile = path.resolve(config.storage.stateFile);
  }
  if (config.storage.injectDir && !path.isAbsolute(config.storage.injectDir)) {
    config.storage.injectDir = path.resolve(config.storage.injectDir);
  }

  try {
    validateCommandAliases(config.commandAliases);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (args.command === 'agents') {
    handleAgents(config);
    return;
  }
  if (args.command === 'inject') {
    await handleInject(config, args);
    return;
  }
  if (args.command === 'stop') {
    handleStop(config);
    return;
  }
  if (args.command === 'status') {
    handleStatus(config);
    return;
  }

  const agentSelection = args.agent ?? config.agent.preset;
  if (!agentSelection && !config.agent.command) {
    console.error('Error: --agent is required\n');
    usage();
    process.exit(1);
  }

  if (agentSelection) {
    const resolvedAgent = resolveAgentSelection(agentSelection, config.agents);
    config.agent.preset = resolvedAgent.id;
    config.agent.command = resolvedAgent.command;
    config.agent.args = resolvedAgent.args;
    if (resolvedAgent.env) {
      config.agent.env = { ...(config.agent.env ?? {}), ...resolvedAgent.env };
    }
  }

  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.idleTimeout !== undefined) {
    if (!Number.isFinite(args.idleTimeout) || args.idleTimeout < 0) {
      console.error('Error: invalid --idle-timeout value');
      process.exit(1);
    }
    config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  }
  if (args.maxSessions) config.session.maxConcurrentUsers = args.maxSessions;
  if (args.hideThoughts) config.agent.showThoughts = false;
  if (args.showDiffs) config.agent.showDiffs = true;
  config.daemon.enabled = args.daemon;

  if (!config.yuanbao.appId || !config.yuanbao.appSecret) {
    console.error(
      'Error: --yuanbao-app-id and --yuanbao-app-secret are required',
    );
    process.exit(1);
  }

  if (args.daemon && !process.env[DAEMON_ENV_VAR]) {
    daemonize(config);
    return;
  }

  initTelemetry({
    version: packageJson.version,
    storageDir: config.storage.dir,
    agentPreset: config.agent.preset ?? 'raw',
    daemon: config.daemon.enabled,
  });
  trackEvent('app.start', {
    agentPreset: config.agent.preset ?? 'raw',
    daemon: config.daemon.enabled,
  });
  const startedAt = Date.now();

  const bridge = new YuanbaoAcpBridge(config, (msg) => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${ts}] ${msg}`);
  });

  const shutdown = async (reason: 'signal' | 'error' | 'normal') => {
    trackEvent('app.stop', {
      reason,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
    await bridge.stop();
    await shutdownTelemetry();
    process.exit(reason === 'error' ? 1 : 0);
  };

  process.on('SIGINT', () => void shutdown('signal'));
  process.on('SIGTERM', () => void shutdown('signal'));

  try {
    await bridge.start();
  } catch (err) {
    trackException(err, 'main');
    await shutdownTelemetry();
    console.error(`Fatal: ${String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
