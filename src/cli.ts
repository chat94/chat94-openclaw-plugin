import { stdout as output } from "node:process";
import { resolveChat94Account } from "./accounts.js";
import { generateGroupKey, generatePairingCode } from "./crypto.js";
import { dumpChat94Trace } from "./error-log.js";
import { inspectChat94StateAccess, saveStoredGroupKey } from "./key-store.js";
import { hostPairingSession } from "./pairing.js";
import {
  clearChat94SessionBinding,
  findOpenClawSessionCandidate,
  getChat94SessionBinding,
  listOpenClawSessionCandidates,
  setChat94SessionBinding,
} from "./session-binding.js";
import { captureChat94TestException, getTelemetryStatus, setTelemetryEnabled } from "./telemetry.js";

type PluginApiLike = {
  config?: Record<string, unknown>;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  runtime?: {
    config?: {
      loadConfig?: () => Record<string, unknown>;
      writeConfigFile?: (nextConfig: Record<string, unknown>) => Promise<void>;
    };
  };
  registerCli?: (
    registrar: (ctx: { program: any; config: Record<string, unknown>; workspaceDir?: string }) => void,
    opts?: { commands?: string[]; descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }> },
  ) => void;
};

type PairCommandOptions = {
  account?: string;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
  noPair?: boolean;
  pair?: boolean;
  code?: string;
};

type SessionListOptions = {
  account?: string;
  limit?: string;
};

type SessionBindingOptions = {
  account?: string;
  sessionKey?: string;
};

export function registerChat94Cli(api: PluginApiLike): void {
  api.registerCli?.(
    ({ program }) => {
      const chat94 = program
        .command("chat94")
        .description("Manage chat94 pairing and local key state")
        .option("--no-telemetry", "Disable anonymous error reporting for this run");

      chat94
        .command("pair")
        .description("Configure chat94 (if needed) and start a pairing session for a client")
        .option("--account <id>", "Account id", "default")
        .option("--code <value>", "Explicit pairing code")
        .option("--pairing-log-level <level>", "Pairing log level (info|debug)")
        .option("--runtime-log-level <level>", "Runtime log level (info|debug)")
        .option("--no-pair", "Save config and local key without starting pairing")
        .action(async (opts: PairCommandOptions) => {
          await runPairCommand(api, opts).catch(handleCliError);
        });

      chat94
        .command("status")
        .description("Show current chat94 channel status")
        .option("--account <id>", "Account id", "default")
        .action(async (opts: { account?: string }) => {
          const cfg = loadConfig(api);
          const account = resolveChat94Account({
            cfg: cfg as { channels?: Record<string, unknown> },
            accountId: opts.account,
          });
          output.write(
            [
              `account: ${account.accountId}`,
              `pairing log level: ${account.pairingLogLevel}`,
              `runtime log level: ${account.runtimeLogLevel}`,
              `key source: ${account.keySource}`,
              `key file: ${account.keyFilePath}`,
              `group id: ${account.groupId || "(missing)"}`,
              `configured: ${account.configured ? "yes" : "no"}`,
            ].join("\n") + "\n",
          );
        });

      const sessions = chat94
        .command("sessions")
        .description("Inspect and bind chat94 to existing OpenClaw sessions");

      sessions
        .command("list")
        .description("List recent OpenClaw sessions that chat94 can join")
        .option("--account <id>", "Account id", "default")
        .option("--limit <n>", "Max sessions to show", "20")
        .action(async (opts: SessionListOptions) => {
          await runListSessions(api, opts).catch(handleCliError);
        });

      sessions
        .command("current")
        .description("Show the current chat94 session binding")
        .option("--account <id>", "Account id", "default")
        .action(async (opts: { account?: string }) => {
          await runShowCurrentBinding(api, opts).catch(handleCliError);
        });

      sessions
        .command("bind")
        .description("Bind chat94 to an existing OpenClaw session key")
        .option("--account <id>", "Account id", "default")
        .option("--session-key <value>", "Existing OpenClaw session key to join")
        .action(async (opts: SessionBindingOptions) => {
          await runBindSession(api, opts).catch(handleCliError);
        });

      sessions
        .command("clear")
        .description("Clear the current chat94 session binding")
        .option("--account <id>", "Account id", "default")
        .action(async (opts: { account?: string }) => {
          await runClearBinding(api, opts).catch(handleCliError);
        });

      const telemetry = chat94
        .command("telemetry")
        .description("Manage anonymous error reporting");

      telemetry
        .command("status")
        .description("Show telemetry status")
        .action(() => {
          const status = getTelemetryStatus();
          output.write(`Telemetry: ${status.enabled ? "enabled" : "disabled"}\n`);
          if (status.enabled) {
            output.write("  Disable: openclaw chat94 telemetry disable\n");
            output.write("  Or set CHAT94_TELEMETRY_DISABLED=1\n");
          } else {
            output.write(`  Source: ${status.reason}\n`);
            output.write("  Enable: openclaw chat94 telemetry enable\n");
          }
        });

      telemetry
        .command("disable")
        .description("Disable telemetry persistently")
        .action(() => {
          setTelemetryEnabled(false);
          output.write("Telemetry disabled. No data will be sent to chat94.\n");
          output.write("Re-enable: openclaw chat94 telemetry enable\n");
        });

      telemetry
        .command("enable")
        .description("Enable telemetry persistently")
        .action(() => {
          setTelemetryEnabled(true);
          output.write("Telemetry enabled. Anonymous error reports will be sent.\n");
          output.write("Privacy policy: https://chat94.com/privacy\n");
        });

      telemetry
        .command("test-exception", { hidden: true })
        .description("Send a test exception to Sentry")
        .action(async () => {
          const sent = await captureChat94TestException();
          output.write(
            sent
              ? "Telemetry test exception sent.\n"
              : "Telemetry test exception not sent. Telemetry is disabled or no DSN is configured.\n",
          );
        });
    },
    {
      commands: ["chat94"],
      descriptors: [
        {
          name: "chat94",
          description: "Manage chat94 pairing and local key state",
          hasSubcommands: true,
        },
      ],
    },
  );
}

async function runPairCommand(api: PluginApiLike, opts: PairCommandOptions): Promise<boolean> {
  const cfg = loadConfig(api);
  const before = resolveChat94Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const beforeConfigured = before.configured;

  const pairingLogLevel = normalizePairingLogLevel(opts.pairingLogLevel ?? before.pairingLogLevel);
  const runtimeLogLevel = normalizePairingLogLevel(opts.runtimeLogLevel ?? before.runtimeLogLevel);

  await writeChannelConfig(api, {
    accountId: before.accountId,
    pairingLogLevel,
    runtimeLogLevel,
  });

  const groupKeyBytes = ensureLocalKeyForAccount(before);

  if (shouldSkipPairing(opts)) {
    output.write("Saved chat94 settings.\n");
    output.write(restartHint(beforeConfigured));
    output.write('Next step: "openclaw chat94 pair"\n');
    return true;
  }

  const code = opts.code?.trim() || generatePairingCode();

  output.write(`Pairing code: ${code}\n`);
  output.write(`${renderPairingCodeBanner(code)}\n`);
  await renderQrIfAvailable(buildPairingQrPayload({ code }));

  const result = await hostPairingSession({
    relayUrl: before.relayUrl,
    groupKeyBytes,
    code,
    logLevel: pairingLogLevel,
    onStatus: (status, detail) => {
      output.write(`${formatStatus(status)} ${detail}\n`);
    },
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const logPath = dumpChat94Trace("cli-pair", error, {
      accountId: before.accountId,
      code,
      pairingLogLevel,
    });
    output.write(
      [
        "",
        `Pairing ended: ${message}`,
        `Trace log: ${logPath}`,
        "If this happened after about 60 seconds, the relay path likely idled out the WebSocket.",
        'Try again with: "openclaw chat94 pair"',
      ].join("\n") + "\n",
    );
    return null;
  });

  if (!result) {
    return false;
  }

  const after = resolveChat94Account({
    cfg: loadConfig(api) as { channels?: Record<string, unknown> },
    accountId: before.accountId,
  });
  output.write(`Pairing room: ${result.roomId}\n`);
  output.write(`Connected group: ${after.groupId || "(local key ready)"}\n`);
  output.write(restartHint(beforeConfigured));
  return true;
}

function restartHint(beforeConfigured: boolean): string {
  if (beforeConfigured) {
    return "Gateway already serves chat94 — no restart needed.\n";
  }
  return 'Restart the gateway to start serving chat94: "openclaw gateway restart"\n';
}

async function runListSessions(api: PluginApiLike, opts: SessionListOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat94Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const limit = Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20);
  const binding = account.groupId
    ? getChat94SessionBinding({ accountId: account.accountId, groupId: account.groupId })
    : null;
  const sessions = listOpenClawSessionCandidates(cfg).slice(0, limit);
  if (sessions.length === 0) {
    output.write("No OpenClaw sessions found.\n");
    return;
  }

  for (const [index, session] of sessions.entries()) {
    const marker = binding?.targetSessionKey === session.sessionKey ? "*" : " ";
    output.write(
      [
        `[${index + 1}]${marker} ${session.sessionKey}`,
        `  updated: ${formatRelativeTime(session.updatedAt)} | channel: ${session.lastChannel ?? "unknown"} | label: ${session.label}`,
        ...(session.lastPreview ? [`  preview: ${session.lastPreview}`] : []),
      ].join("\n") + "\n",
    );
  }
  output.write('Bind one with: openclaw chat94 sessions bind --session-key "<session-key>"\n');
}

async function runShowCurrentBinding(
  api: PluginApiLike,
  opts: { account?: string },
): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat94Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  if (!account.groupId) {
    output.write('No local chat94 key yet. Pair first with: "openclaw chat94 pair"\n');
    return;
  }
  const binding = getChat94SessionBinding({
    accountId: account.accountId,
    groupId: account.groupId,
  });
  if (!binding) {
    output.write("No bound session. chat94 will use its default route.\n");
    return;
  }
  output.write(
    [
      `group id: ${account.groupId}`,
      `target session: ${binding.targetSessionKey}`,
      `agent: ${binding.agentId}`,
      `label: ${binding.label}`,
      `last channel: ${binding.lastChannel ?? "unknown"}`,
      `updated: ${formatRelativeTime(binding.updatedAt)}`,
      `bound at: ${binding.boundAt}`,
      ...(binding.lastPreview ? [`preview: ${binding.lastPreview}`] : []),
    ].join("\n") + "\n",
  );
}

async function runBindSession(api: PluginApiLike, opts: SessionBindingOptions): Promise<void> {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error('missing --session-key, try: openclaw chat94 sessions bind --session-key "agent:main:telegram:direct:123"');
  }
  const cfg = loadConfig(api);
  const account = resolveChat94Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  if (!account.groupId) {
    throw new Error('chat94 has no local key yet. Pair first with: "openclaw chat94 pair"');
  }
  const candidate = findOpenClawSessionCandidate(sessionKey, cfg);
  if (!candidate) {
    throw new Error(`session not found: ${sessionKey}`);
  }
  const binding = setChat94SessionBinding({
    accountId: account.accountId,
    groupId: account.groupId,
    target: candidate,
  });
  output.write(
    [
      `Bound chat94 group ${account.groupId} to ${binding.targetSessionKey}`,
      `agent: ${binding.agentId}`,
      `label: ${binding.label}`,
      ...(binding.lastPreview ? [`preview: ${binding.lastPreview}`] : []),
    ].join("\n") + "\n",
  );
}

async function runClearBinding(
  api: PluginApiLike,
  opts: { account?: string },
): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat94Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  if (!account.groupId) {
    output.write("No local chat94 key found, nothing to clear.\n");
    return;
  }
  const cleared = clearChat94SessionBinding({
    accountId: account.accountId,
    groupId: account.groupId,
  });
  output.write(cleared ? "Cleared chat94 session binding.\n" : "No chat94 session binding was set.\n");
}

function loadConfig(api: PluginApiLike): Record<string, unknown> {
  return api.runtime?.config?.loadConfig?.() ?? api.config ?? {};
}

function shouldSkipPairing(opts: PairCommandOptions): boolean {
  return opts.noPair === true || opts.pair === false;
}

function ensureLocalKeyForAccount(account: {
  accountId: string;
  groupKeyBytes: Uint8Array;
}): Buffer {
  assertStateAccess(account.accountId);
  let groupKeyBytes =
    Buffer.isBuffer(account.groupKeyBytes)
      ? account.groupKeyBytes
      : Buffer.from(account.groupKeyBytes);
  if (groupKeyBytes.length !== 32) {
    groupKeyBytes = generateGroupKey();
    const stored = saveStoredGroupKey(account.accountId, groupKeyBytes);
      output.write(`Created local chat94 key.\nKey file: ${stored.path}\n`);
  }
  return groupKeyBytes;
}

async function writeChannelConfig(
  api: PluginApiLike,
  params: {
    accountId: string;
    pairingLogLevel: "info" | "debug";
    runtimeLogLevel: "info" | "debug";
  },
): Promise<void> {
  const current = loadConfig(api);
  const next = patchChannelConfig(current, params);
  if (api.runtime?.config?.writeConfigFile) {
    await api.runtime.config.writeConfigFile(next);
    return;
  }
  throw new Error("chat94 setup cannot persist config in this runtime");
}

export function patchChannelConfig(
  cfg: Record<string, unknown>,
  params: {
    accountId: string;
    pairingLogLevel: "info" | "debug";
    runtimeLogLevel: "info" | "debug";
  },
): Record<string, unknown> {
  const channels = { ...((cfg.channels as Record<string, unknown> | undefined) ?? {}) };
  const currentChannel = { ...((channels.chat94 as Record<string, unknown> | undefined) ?? {}) };
  const plugins = { ...((cfg.plugins as Record<string, unknown> | undefined) ?? {}) };
  const entries = {
    ...((plugins.entries as Record<string, Record<string, unknown>> | undefined) ?? {}),
  };
  entries.chat94 = {
    ...(entries.chat94 ?? {}),
    enabled: true,
  };
  plugins.entries = entries;
  const currentAllow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  if (currentAllow) {
    plugins.allow = currentAllow.includes("chat94") ? currentAllow : [...currentAllow, "chat94"];
  }

  if (params.accountId === "default") {
    currentChannel.enabled = true;
    currentChannel.pairingLogLevel = params.pairingLogLevel;
    currentChannel.runtimeLogLevel = params.runtimeLogLevel;
  } else {
    const accounts = {
      ...((currentChannel.accounts as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    accounts[params.accountId] = {
      ...(accounts[params.accountId] ?? {}),
      enabled: true,
      pairingLogLevel: params.pairingLogLevel,
      runtimeLogLevel: params.runtimeLogLevel,
    };
    currentChannel.accounts = accounts;
    if (!currentChannel.defaultAccount) {
      currentChannel.defaultAccount = params.accountId;
    }
  }

  channels.chat94 = currentChannel;
  return { ...cfg, channels, plugins };
}

function buildPairingQrPayload(params: { code?: string }): string {
  const code = params.code ?? "";
  return `chat94://pair?code=${encodeURIComponent(code)}`;
}

async function renderQrIfAvailable(payload: string): Promise<void> {
  output.write(`QR payload: ${payload}\n`);

  try {
    const moduleName = "qrcode-terminal";
    const qr = (await import(moduleName)) as { default?: { generate?: (value: string, opts?: { small?: boolean }) => void }; generate?: (value: string, opts?: { small?: boolean }) => void };
    const generate = qr.generate ?? qr.default?.generate;
    if (typeof generate === "function") {
      generate(payload, { small: true });
    }
  } catch {
    output.write("(Install optional dependency `qrcode-terminal` to render ASCII QR here.)\n");
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "connecting":
      return "[1/5]";
    case "connected":
      return "[2/5]";
    case "waiting":
      return "[3/5]";
    case "joiner-ready":
      return "[4/5]";
    case "grant-sent":
      return "[4/5]";
    case "completed":
      return "[5/5]";
    case "closed":
      return "[x]";
    default:
      return "[*]";
  }
}

function handleCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const logPath = dumpChat94Trace("cli", error);
  output.write(`chat94 error: ${message}\nTrace log: ${logPath}\n`);
}

function normalizePairingLogLevel(value: string | undefined): "info" | "debug" {
  return value?.trim().toLowerCase() === "debug" ? "debug" : "info";
}

function assertStateAccess(accountId: string): void {
  const access = inspectChat94StateAccess(accountId);
  if (!access.hasOwnershipMismatch) {
    return;
  }
  if (access.canAutoRepairOwnership) {
    return;
  }
  const current = typeof access.currentUid === "number" ? String(access.currentUid) : "unknown";
  const expected =
    typeof access.preferredOwnerUid === "number" ? String(access.preferredOwnerUid) : "unknown";
  throw new Error(
    [
      `chat94 state dir is owned by uid ${expected}, but this command is running as uid ${current}.`,
      "Run `openclaw chat94 pair` as the same user that runs OpenClaw.",
      `State dir: ${access.stateDir}`,
    ].join(" "),
  );
}

function formatRelativeTime(timestampMs: number): string {
  const deltaMs = Math.max(0, Date.now() - timestampMs);
  if (deltaMs < 60_000) {
    return `${Math.round(deltaMs / 1_000)}s ago`;
  }
  if (deltaMs < 60 * 60_000) {
    return `${Math.round(deltaMs / 60_000)}m ago`;
  }
  if (deltaMs < 24 * 60 * 60_000) {
    return `${Math.round(deltaMs / (60 * 60_000))}h ago`;
  }
  return `${Math.round(deltaMs / (24 * 60 * 60_000))}d ago`;
}

function renderPairingCodeBanner(code: string): string {
  const lines = [
    "╔════════════════════════════════════════════════════════════════════════════════════════════╗",
    "║                                     CHAT94 PAIRING                                       ║",
    "╠════════════════════════════════════════════════════════════════════════════════════════════╣",
  ];

  const glyphs = code.split("").map((char) => PAIR_CODE_FONT[char] ?? PAIR_CODE_FONT["?"]);
  for (let row = 0; row < 7; row += 1) {
    const content = glyphs.map((glyph) => glyph[row]).join("  ");
    lines.push(`║ ${content.padEnd(88, " ")} ║`);
  }

  lines.push("╠════════════════════════════════════════════════════════════════════════════════════════════╣");
  lines.push(`║ CODE: ${code.padEnd(81, " ")} ║`);
  lines.push("╚════════════════════════════════════════════════════════════════════════════════════════════╝");
  return lines.join("\n");
}

const PAIR_CODE_FONT: Record<string, string[]> = {
  A: ["   AAA   ", "  AAAAA  ", " AAA AAA ", " AAAAAAA ", " AAA AAA ", " AAA AAA ", " AAA AAA "],
  B: [" BBBBBB  ", " BBB BBB ", " BBB BBB ", " BBBBBB  ", " BBB BBB ", " BBB BBB ", " BBBBBB  "],
  C: ["  CCCCC  ", " CCC CCC ", " CCC     ", " CCC     ", " CCC     ", " CCC CCC ", "  CCCCC  "],
  D: [" DDDDD   ", " DDD DDD ", " DDD  DDD", " DDD  DDD", " DDD  DDD", " DDD DDD ", " DDDDD   "],
  E: [" EEEEEEE ", " EEE     ", " EEE     ", " EEEEE   ", " EEE     ", " EEE     ", " EEEEEEE "],
  F: [" FFFFFFF ", " FFF     ", " FFF     ", " FFFFF   ", " FFF     ", " FFF     ", " FFF     "],
  G: ["  GGGGG  ", " GGG GGG ", " GGG     ", " GGG GGG ", " GGG  GGG", " GGG GGG ", "  GGGGG  "],
  H: [" HHH HHH ", " HHH HHH ", " HHH HHH ", " HHHHHHH ", " HHH HHH ", " HHH HHH ", " HHH HHH "],
  J: [" JJJJJJJ ", "    JJJ  ", "    JJJ  ", "    JJJ  ", " J  JJJ  ", " JJJJJ   ", "  JJJ    "],
  K: [" KKK  KKK", " KKK KKK ", " KKKKKK  ", " KKKKK   ", " KKKKKK  ", " KKK KKK ", " KKK  KKK"],
  M: [" MMM MMM ", " MMMMMMM ", " MMMMMMM ", " MMM MMM ", " MMM MMM ", " MMM MMM ", " MMM MMM "],
  N: [" NNN  NNN", " NNNN NNN", " NNNNNNNN", " NNN NNNN", " NNN  NNN", " NNN  NNN", " NNN  NNN"],
  P: [" PPPPPP  ", " PPP PPP ", " PPP PPP ", " PPPPPP  ", " PPP     ", " PPP     ", " PPP     "],
  Q: ["  QQQQQ  ", " QQQ QQQ ", " QQQ QQQ ", " QQQ QQQ ", " QQQQQQQ ", " QQQ  QQQ", "  QQQQQ Q"],
  R: [" RRRRRR  ", " RRR RRR ", " RRR RRR ", " RRRRRR  ", " RRRRR   ", " RRR RRR ", " RRR  RRR"],
  S: ["  SSSSS  ", " SSS SSS ", " SSS     ", "  SSSSS  ", "     SSS ", " SSS SSS ", "  SSSSS  "],
  T: [" TTTTTTT ", " TTTTTTT ", "   TTT   ", "   TTT   ", "   TTT   ", "   TTT   ", "   TTT   "],
  U: [" UUU UUU ", " UUU UUU ", " UUU UUU ", " UUU UUU ", " UUU UUU ", " UUU UUU ", "  UUUUU  "],
  V: [" VVV VVV ", " VVV VVV ", " VVV VVV ", " VVV VVV ", " VVV VVV ", "  VVVVV  ", "   VVV   "],
  W: [" WWW WWW ", " WWW WWW ", " WWW WWW ", " WWWWWWW ", " WWWWWWW ", " WWW WWW ", " WWW WWW "],
  X: [" XXX XXX ", " XXX XXX ", "  XXXXX  ", "   XXX   ", "  XXXXX  ", " XXX XXX ", " XXX XXX "],
  Y: [" YYY YYY ", " YYY YYY ", "  YYYYY  ", "   YYY   ", "   YYY   ", "   YYY   ", "   YYY   "],
  Z: [" ZZZZZZZ ", "    ZZZ  ", "   ZZZ   ", "  ZZZ    ", " ZZZ     ", " ZZZ     ", " ZZZZZZZ "],
  2: [" 222222  ", "222  222 ", "    222  ", "   222   ", "  222    ", " 222     ", "22222222 "],
  3: ["3333333  ", "     333 ", "   3333  ", "     333 ", "     333 ", "333 333  ", " 33333   "],
  4: [" 44  44  ", " 44  44  ", " 44  44  ", " 4444444 ", "     44  ", "     44  ", "     44  "],
  6: ["  66666  ", " 666     ", " 666     ", " 666666  ", " 666 666 ", " 666 666 ", "  66666  "],
  7: ["77777777 ", "    777  ", "   777   ", "   777   ", "  777    ", "  777    ", "  777    "],
  8: [" 888888  ", "888  888 ", "888  888 ", " 888888  ", "888  888 ", "888  888 ", " 888888  "],
  9: [" 999999  ", "999  999 ", "999  999 ", " 9999999 ", "     999 ", "     999 ", "  99999  "],
  "-": ["          ", "          ", "          ", " -------- ", " -------- ", "          ", "          "],
  "?": [" ??????  ", "??   ??? ", "    ???  ", "   ???   ", "   ???   ", "         ", "   ???   "],
};
