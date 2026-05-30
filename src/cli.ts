import { stdout as output } from "node:process";
import { rmSync } from "node:fs";
import { resolveChat4000Account } from "./accounts.js";
import { dumpChat4000Trace } from "./error-log.js";
import { deleteMatrixCredentials } from "./matrix/credentials.js";
import type { MatrixCredentials } from "./matrix/types.js";
import { configureIdentity, selfRedeemIdentity } from "./pairing/bot-identity.js";
import { createPairedRoom } from "./matrix/rooms.js";
import { endpointsForEnv, resolveEnv, type Chat4000Env } from "./pairing/env.js";
import { getOrCreatePluginId } from "./pairing/instance.js";
import { RegistrarClient } from "./pairing/registrar.js";
import { renderQr, startHumanPairing } from "./pairing/qr.js";
import { resolveChat4000AccountStateDir } from "./paths.js";
import {
  clearChat4000SessionBinding,
  findOpenClawSessionCandidate,
  getChat4000SessionBinding,
  listOpenClawSessionCandidates,
  setChat4000SessionBinding,
} from "./session-binding.js";
import { detectV1State } from "./migration/detect.js";
import { runChat4000Migration } from "./migration/migrate.js";
import { captureChat4000TestException, getTelemetryStatus, setTelemetryEnabled } from "./telemetry.js";

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

type SetupCommandOptions = {
  account?: string;
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  deviceId?: string;
  selfRedeem?: boolean;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
  noPair?: boolean;
  pair?: boolean;
};

type PairCommandOptions = {
  account?: string;
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  ttl?: string;
};

type MigrateCommandOptions = {
  account?: string;
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  homeserver?: string;
};

type SessionBindingOptions = {
  account?: string;
  room?: string;
  sessionKey?: string;
};

export function registerChat4000Cli(api: PluginApiLike): void {
  api.registerCli?.(
    ({ program }) => {
      const chat4000 = program
        .command("chat4000")
        .description("Manage chat4000 (Matrix) setup, pairing, and migration")
        .option("--no-telemetry", "Disable anonymous error reporting for this run");

      chat4000
        .command("setup")
        .description("Configure this agent's Matrix identity and (optionally) pair a device")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option("--homeserver <url>", "Matrix homeserver URL (overrides env preset)")
        .option("--user-id <id>", "Matrix bot user id, e.g. @plugin_x:chat4000.com")
        .option("--access-token <token>", "Matrix bot access token")
        .option("--device-id <id>", "Matrix bot device id")
        .option("--self-redeem", "Self-onboard a bot identity via a kind=plugin registrar code")
        .option("--pairing-log-level <level>", "Pairing log level (info|debug)")
        .option("--runtime-log-level <level>", "Runtime log level (info|debug)")
        .option("--no-pair", "Configure identity without starting device pairing")
        .action(async (opts: SetupCommandOptions) => {
          await runSetup(api, opts).catch(handleCliError);
        });

      chat4000
        .command("pair")
        .description("Pair a chat4000 iOS/macOS device (prints a code + QR to redeem)")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option("--ttl <seconds>", "Pairing code lifetime in seconds", "300")
        .action(async (opts: PairCommandOptions) => {
          await runPair(api, opts).catch(handleCliError);
        });

      chat4000
        .command("status")
        .description("Show current chat4000 channel status")
        .option("--account <id>", "Account id", "default")
        .action(async (opts: { account?: string }) => {
          const cfg = loadConfig(api);
          const account = resolveChat4000Account({
            cfg: cfg as { channels?: Record<string, unknown> },
            accountId: opts.account,
          });
          const v1 = detectV1State(account.accountId);
          output.write(
            [
              `account: ${account.accountId}`,
              `homeserver: ${account.homeserver || "(missing)"}`,
              `user id: ${account.userId || "(missing)"}`,
              `device id: ${account.deviceId || "(missing)"}`,
              `plugin id: ${account.pluginId ?? "(unset)"}`,
              `credential source: ${account.credentialSource}`,
              `registrar: ${account.provisioning.url ?? "(unset)"}`,
              `configured: ${account.configured ? "yes" : "no"}`,
              ...(v1.present ? ['⚠ legacy v1 state detected — run "openclaw chat4000 migrate"'] : []),
            ].join("\n") + "\n",
          );
        });

      chat4000
        .command("migrate")
        .description("Upgrade a v1 (relay) install to v2 (Matrix). Snapshots v1 state first.")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option("--homeserver <url>", "Matrix homeserver URL (overrides env preset)")
        .action(async (opts: MigrateCommandOptions) => {
          await runMigrate(api, opts).catch(handleCliError);
        });

      chat4000
        .command("reset")
        .description("Wipe local Matrix credentials + crypto/sync state for an account. Re-run setup after.")
        .option("--account <id>", "Account id", "default")
        .action(async (opts: { account?: string }) => {
          runReset(opts.account);
        });

      const sessions = chat4000
        .command("sessions")
        .description("Inspect and bind chat4000 rooms to existing OpenClaw sessions");

      sessions
        .command("list")
        .description("List recent OpenClaw sessions that chat4000 can join")
        .option("--account <id>", "Account id", "default")
        .option("--limit <n>", "Max sessions to show", "20")
        .action(async (opts: { account?: string; limit?: string }) => {
          await runListSessions(api, opts).catch(handleCliError);
        });

      sessions
        .command("bind")
        .description("Bind a chat4000 room to an existing OpenClaw session key")
        .option("--account <id>", "Account id", "default")
        .option("--room <roomId>", "Matrix room id (e.g. !abc:chat4000.com)")
        .option("--session-key <value>", "Existing OpenClaw session key to join")
        .action(async (opts: SessionBindingOptions) => {
          await runBindSession(api, opts).catch(handleCliError);
        });

      sessions
        .command("current")
        .description("Show the chat4000 session binding for a room")
        .option("--account <id>", "Account id", "default")
        .option("--room <roomId>", "Matrix room id")
        .action(async (opts: SessionBindingOptions) => {
          await runShowBinding(api, opts).catch(handleCliError);
        });

      sessions
        .command("clear")
        .description("Clear the chat4000 session binding for a room")
        .option("--account <id>", "Account id", "default")
        .option("--room <roomId>", "Matrix room id")
        .action(async (opts: SessionBindingOptions) => {
          await runClearBinding(api, opts).catch(handleCliError);
        });

      const telemetry = chat4000
        .command("telemetry")
        .description("Manage anonymous error reporting");

      telemetry
        .command("status")
        .description("Show telemetry status")
        .action(() => {
          const status = getTelemetryStatus();
          output.write(`Telemetry: ${status.enabled ? "enabled" : "disabled"}\n`);
          if (status.enabled) {
            output.write("  Disable: openclaw chat4000 telemetry disable\n");
            output.write("  Or set CHAT4000_TELEMETRY_DISABLED=1\n");
          } else {
            output.write(`  Source: ${status.reason}\n`);
            output.write("  Enable: openclaw chat4000 telemetry enable\n");
          }
        });

      telemetry
        .command("disable")
        .description("Disable telemetry persistently")
        .action(() => {
          setTelemetryEnabled(false);
          output.write("Telemetry disabled. No data will be sent to chat4000.\n");
        });

      telemetry
        .command("enable")
        .description("Enable telemetry persistently")
        .action(() => {
          setTelemetryEnabled(true);
          output.write("Telemetry enabled. Anonymous error reports will be sent.\n");
          output.write("Privacy policy: https://chat4000.com/privacy\n");
        });

      telemetry
        .command("test-exception", { hidden: true })
        .description("Send a test exception to Sentry")
        .action(async () => {
          const sent = await captureChat4000TestException();
          output.write(sent ? "Telemetry test exception sent.\n" : "Telemetry test exception not sent.\n");
        });
    },
    {
      commands: ["chat4000"],
      descriptors: [
        {
          name: "chat4000",
          description: "Manage chat4000 (Matrix) setup, pairing, and migration",
          hasSubcommands: true,
        },
      ],
    },
  );
}

// ─── Endpoint resolution (env preset + overrides) ────────────────────────────

type EndpointOpts = {
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  homeserver?: string;
};

function resolveSelectedEnv(opts: EndpointOpts): Chat4000Env {
  return resolveEnv(opts.stage ? "stage" : opts.env);
}

function resolveRegistrar(
  account: ReturnType<typeof resolveChat4000Account>,
  opts: EndpointOpts,
): { client: RegistrarClient; url: string } {
  const env = resolveSelectedEnv(opts);
  const preset = endpointsForEnv(env);
  const url = opts.registrarUrl?.trim() || account.provisioning.url || preset.registrar;
  const serviceToken = opts.serviceToken?.trim() || account.provisioning.serviceToken;
  if (!serviceToken) {
    throw new Error(
      "Missing registrar SERVICE_TOKEN. Pass --service-token, set " +
        "channels.chat4000.provisioning.serviceToken, or CHAT4000_SERVICE_TOKEN.",
    );
  }
  return { client: new RegistrarClient({ baseUrl: url, serviceToken }), url };
}

function resolveHomeserver(
  account: ReturnType<typeof resolveChat4000Account>,
  opts: EndpointOpts,
): string {
  const env = resolveSelectedEnv(opts);
  return opts.homeserver?.trim() || account.homeserver || endpointsForEnv(env).homeserver;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function runSetup(api: PluginApiLike, opts: SetupCommandOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const env = resolveSelectedEnv(opts);
  const homeserver = resolveHomeserver(account, opts);

  // Bot identity: either operator-supplied direct credentials, or self-onboard
  // via a kind=plugin registrar code (PROTOCOL §3).
  const directUserId = opts.userId?.trim() || account.userId;
  const directToken = opts.accessToken?.trim() || account.accessToken;
  const directDeviceId = opts.deviceId?.trim() || account.deviceId;

  let credentials: MatrixCredentials;
  let credentialsPath: string;

  if (directUserId && directToken && directDeviceId) {
    const result = configureIdentity({
      accountId: account.accountId,
      credentials: {
        homeserver,
        userId: directUserId,
        accessToken: directToken,
        deviceId: directDeviceId,
        pluginId: account.pluginId ?? getOrCreatePluginId(account.accountId),
      },
    });
    credentials = result.credentials;
    credentialsPath = result.credentialsPath;
    output.write(`✓ Configured Matrix identity: ${credentials.userId}\n`);
  } else if (opts.selfRedeem) {
    const { client } = resolveRegistrar(account, opts);
    output.write(`Self-onboarding a Matrix bot identity via the registrar (${env})...\n`);
    const result = await selfRedeemIdentity({
      accountId: account.accountId,
      registrar: client,
      homeserver,
    });
    credentials = result.credentials;
    credentialsPath = result.credentialsPath;
    output.write(`✓ Matrix identity ready: ${credentials.userId}\n`);
  } else {
    throw new Error(
      "Provide either --self-redeem (with --service-token / --env), or direct bot " +
        "credentials: --user-id --access-token --device-id (and --homeserver or --env). " +
        "Env vars CHAT4000_USER_ID / CHAT4000_ACCESS_TOKEN / CHAT4000_DEVICE_ID also work.",
    );
  }
  output.write(`  Credentials: ${credentialsPath}\n`);

  await writeChannelConfig(api, {
    accountId: account.accountId,
    env,
    pairingLogLevel: normalizeLogLevel(opts.pairingLogLevel ?? account.pairingLogLevel),
    runtimeLogLevel: normalizeLogLevel(opts.runtimeLogLevel ?? account.runtimeLogLevel),
    homeserver: credentials.homeserver,
    userId: credentials.userId,
    deviceId: credentials.deviceId,
    registrarUrl: opts.registrarUrl?.trim() || account.provisioning.url || endpointsForEnv(env).registrar,
  });
  output.write("✓ Saved chat4000 channel config.\n");

  if (opts.noPair === true || opts.pair === false) {
    output.write('Skipped device pairing.\nNext step: "openclaw chat4000 pair"\n');
    return;
  }
  await runPair(api, { account: account.accountId, env: opts.env, stage: opts.stage });
}

async function runPair(api: PluginApiLike, opts: PairCommandOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  if (!account.configured) {
    throw new Error('No Matrix identity yet. Run "openclaw chat4000 setup" first.');
  }
  const { client, url } = resolveRegistrar(account, opts);
  const pluginId = account.pluginId ?? getOrCreatePluginId(account.accountId);
  const ttlSeconds = Math.max(1, Math.min(3600, Number.parseInt(opts.ttl ?? "300", 10) || 300));

  const pairing = await startHumanPairing({
    registrar: client,
    registrarUrl: url,
    pluginId,
    ttlSeconds,
  });
  output.write(`Pairing code: ${pairing.code}\n`);
  await renderQr(pairing.qrUri, (line) => output.write(`${line}\n`));
  output.write(`Redeem in the chat4000 app within ${ttlSeconds}s.\n`);

  // Poll /pair/status until completed or expired.
  const deadline = Date.now() + ttlSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const status = await client.getPairingStatus(pairing.code);
      if (status.status === "completed") {
        output.write(`✓ Device paired${status.userId ? ` (${status.userId})` : ""}.\n`);
        // PROTOCOL §3.3: on completion the plugin invites the user to a room.
        if (status.userId) {
          try {
            const room = await createPairedRoom({
              credentials: {
                homeserver: account.homeserver,
                userId: account.userId,
                accessToken: account.accessToken,
                deviceId: account.deviceId,
                pluginId: account.pluginId,
              },
              inviteUserId: status.userId,
              name: "chat4000",
            });
            output.write(`✓ Created room ${room.roomId} and invited ${status.userId}.\n`);
          } catch (err) {
            output.write(`⚠ Paired, but creating/inviting the room failed: ${String(err)}\n`);
            output.write("  The gateway will still see the user once they share a room.\n");
          }
        }
        return;
      }
      if (status.status === "expired") {
        output.write('Pairing code expired. Re-run "openclaw chat4000 pair".\n');
        return;
      }
    } catch {
      // transient; keep polling
    }
  }
  output.write('Pairing window elapsed. If the device didn\'t join, re-run "openclaw chat4000 pair".\n');
}

async function runMigrate(api: PluginApiLike, opts: MigrateCommandOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const env = resolveSelectedEnv(opts);
  const registrarUrl =
    opts.registrarUrl?.trim() || account.provisioning.url || endpointsForEnv(env).registrar;
  const homeserver = resolveHomeserver(account, opts);
  // Prefer credentials already resolvable (env/config/file); else self-onboard
  // via the registrar if a SERVICE_TOKEN is available.
  const existingCredentials: MatrixCredentials | null = account.configured
    ? {
        homeserver: account.homeserver,
        userId: account.userId,
        accessToken: account.accessToken,
        deviceId: account.deviceId,
        pluginId: account.pluginId,
      }
    : null;
  const serviceToken = opts.serviceToken?.trim() || account.provisioning.serviceToken;
  const registrar = serviceToken
    ? new RegistrarClient({ baseUrl: registrarUrl, serviceToken })
    : null;
  await runChat4000Migration({
    accountId: account.accountId,
    existingCredentials,
    registrar,
    homeserver,
    write: (line) => output.write(`${line}\n`),
    persistConfig: async (creds) => {
      await writeChannelConfig(api, {
        accountId: account.accountId,
        env,
        pairingLogLevel: account.pairingLogLevel,
        runtimeLogLevel: account.runtimeLogLevel,
        homeserver: creds.homeserver,
        userId: creds.userId,
        deviceId: creds.deviceId,
        registrarUrl,
      });
    },
  });
}

function runReset(accountArg?: string): void {
  const accountId = (accountArg ?? "default").trim() || "default";
  const removed: string[] = [];
  if (deleteMatrixCredentials(accountId)) {
    removed.push("credentials");
  }
  const stateDir = resolveChat4000AccountStateDir(accountId);
  try {
    rmSync(stateDir, { recursive: true, force: true });
    removed.push(stateDir);
  } catch {
    // ignore
  }
  if (removed.length === 0) {
    output.write(`No local chat4000 state for account "${accountId}".\n`);
    return;
  }
  output.write(`Reset chat4000 account "${accountId}". Removed: ${removed.join(", ")}\n`);
  output.write('Re-provision with: "openclaw chat4000 setup"\n');
}

async function runListSessions(
  api: PluginApiLike,
  opts: { account?: string; limit?: string },
): Promise<void> {
  const cfg = loadConfig(api);
  const limit = Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20);
  const sessions = listOpenClawSessionCandidates(cfg).slice(0, limit);
  if (sessions.length === 0) {
    output.write("No OpenClaw sessions found.\n");
    return;
  }
  for (const [index, session] of sessions.entries()) {
    output.write(
      [
        `[${index + 1}] ${session.sessionKey}`,
        `  channel: ${session.lastChannel ?? "unknown"} | label: ${session.label}`,
        ...(session.lastPreview ? [`  preview: ${session.lastPreview}`] : []),
      ].join("\n") + "\n",
    );
  }
  output.write(
    'Bind one with: openclaw chat4000 sessions bind --room "!room:hs" --session-key "<session-key>"\n',
  );
}

async function runBindSession(api: PluginApiLike, opts: SessionBindingOptions): Promise<void> {
  const room = opts.room?.trim();
  const sessionKey = opts.sessionKey?.trim();
  if (!room) throw new Error("missing --room <roomId>");
  if (!sessionKey) throw new Error("missing --session-key <value>");
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const candidate = findOpenClawSessionCandidate(sessionKey, cfg);
  if (!candidate) throw new Error(`session not found: ${sessionKey}`);
  const binding = setChat4000SessionBinding({
    accountId: account.accountId,
    groupId: room,
    target: candidate,
  });
  output.write(`Bound chat4000 room ${room} to ${binding.targetSessionKey} (agent ${binding.agentId}).\n`);
}

async function runShowBinding(api: PluginApiLike, opts: SessionBindingOptions): Promise<void> {
  const room = opts.room?.trim();
  if (!room) throw new Error("missing --room <roomId>");
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const binding = getChat4000SessionBinding({ accountId: account.accountId, groupId: room });
  if (!binding) {
    output.write("No binding for that room. chat4000 will use the default route.\n");
    return;
  }
  output.write(
    [
      `room: ${room}`,
      `target session: ${binding.targetSessionKey}`,
      `agent: ${binding.agentId}`,
      `label: ${binding.label}`,
    ].join("\n") + "\n",
  );
}

async function runClearBinding(api: PluginApiLike, opts: SessionBindingOptions): Promise<void> {
  const room = opts.room?.trim();
  if (!room) throw new Error("missing --room <roomId>");
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg: cfg as { channels?: Record<string, unknown> },
    accountId: opts.account,
  });
  const cleared = clearChat4000SessionBinding({ accountId: account.accountId, groupId: room });
  output.write(cleared ? "Cleared chat4000 room binding.\n" : "No binding was set for that room.\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadConfig(api: PluginApiLike): Record<string, unknown> {
  return api.runtime?.config?.loadConfig?.() ?? api.config ?? {};
}

function normalizeLogLevel(value: string | undefined): "info" | "debug" {
  return value?.trim().toLowerCase() === "debug" ? "debug" : "info";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeChannelConfig(
  api: PluginApiLike,
  params: ChannelConfigParams,
): Promise<void> {
  const current = loadConfig(api);
  const next = patchChannelConfig(current, params);
  if (api.runtime?.config?.writeConfigFile) {
    await api.runtime.config.writeConfigFile(next);
    return;
  }
  throw new Error("chat4000 setup cannot persist config in this runtime");
}

type ChannelConfigParams = {
  accountId: string;
  env: Chat4000Env;
  pairingLogLevel: "info" | "debug";
  runtimeLogLevel: "info" | "debug";
  homeserver: string;
  userId: string;
  deviceId: string;
  registrarUrl?: string;
};

export function patchChannelConfig(
  cfg: Record<string, unknown>,
  params: ChannelConfigParams,
): Record<string, unknown> {
  const channels = { ...((cfg.channels as Record<string, unknown> | undefined) ?? {}) };
  const currentChannel = { ...((channels.chat4000 as Record<string, unknown> | undefined) ?? {}) };
  const plugins = { ...((cfg.plugins as Record<string, unknown> | undefined) ?? {}) };
  const entries = {
    ...((plugins.entries as Record<string, Record<string, unknown>> | undefined) ?? {}),
  };
  entries.chat4000 = { ...(entries.chat4000 ?? {}), enabled: true };
  plugins.entries = entries;
  const currentAllow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : undefined;
  if (currentAllow) {
    plugins.allow = currentAllow.includes("chat4000") ? currentAllow : [...currentAllow, "chat4000"];
  }

  // Note: accessToken stays in the 0600 credentials file, NOT in config.
  const fields: Record<string, unknown> = {
    enabled: true,
    env: params.env,
    pairingLogLevel: params.pairingLogLevel,
    runtimeLogLevel: params.runtimeLogLevel,
    homeserver: params.homeserver,
    userId: params.userId,
    deviceId: params.deviceId,
  };
  const provisioning: Record<string, unknown> = {
    ...((currentChannel.provisioning as Record<string, unknown> | undefined) ?? {}),
  };
  if (params.registrarUrl) provisioning.url = params.registrarUrl;

  if (params.accountId === "default") {
    Object.assign(currentChannel, fields, { provisioning });
  } else {
    const accounts = {
      ...((currentChannel.accounts as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    accounts[params.accountId] = { ...(accounts[params.accountId] ?? {}), ...fields, provisioning };
    currentChannel.accounts = accounts;
    if (!currentChannel.defaultAccount) currentChannel.defaultAccount = params.accountId;
  }

  channels.chat4000 = currentChannel;
  return { ...cfg, channels, plugins };
}

function handleCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const logPath = dumpChat4000Trace("cli", error);
  output.write(`chat4000 error: ${message}\nTrace log: ${logPath}\n`);
}
