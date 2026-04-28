import { deriveGroupId, parseGroupKey } from "./crypto.js";
import { loadStoredGroupKey, resolveChat94KeyFilePath } from "./key-store.js";
import type { ResolvedChat94Account, Chat94Config } from "./types.js";

const DEFAULT_RELAY_URL = "wss://relay.chat94.com/ws";

type ChannelConfigInput = { channels?: Record<string, unknown> } | undefined;

function getChannelConfig(cfg: ChannelConfigInput): Chat94Config {
  return ((cfg ?? {}).channels?.["chat94"] ?? {}) as Chat94Config;
}

export function listChat94AccountIds(cfg: ChannelConfigInput): string[] {
  const channelConfig = getChannelConfig(cfg);
  const accountIds = Object.keys(channelConfig.accounts ?? {});
  return accountIds.length > 0 ? accountIds : [channelConfig.defaultAccount ?? "default"];
}

export function getDefaultChat94AccountId(cfg: ChannelConfigInput): string {
  const channelConfig = getChannelConfig(cfg);
  const accountIds = Object.keys(channelConfig.accounts ?? {});
  if (channelConfig.defaultAccount && accountIds.includes(channelConfig.defaultAccount)) {
    return channelConfig.defaultAccount;
  }

  return accountIds[0] ?? channelConfig.defaultAccount ?? "default";
}

/**
 * Resolve a chat94 account from OpenClaw config.
 * Merges top-level + per-account config with the fixed production relay.
 */
export function resolveChat94Account(params: {
  cfg?: { channels?: Record<string, unknown> };
  accountId?: string | null;
}): ResolvedChat94Account {
  const channelConfig = getChannelConfig(params.cfg);
  const accountId = params.accountId ?? getDefaultChat94AccountId(params.cfg);

  const accountOverrides = channelConfig.accounts?.[accountId] ?? {};
  const merged = { ...channelConfig, ...accountOverrides };

  const relayUrl = DEFAULT_RELAY_URL;

  let groupKeyBytes: Buffer = Buffer.alloc(0);
  let groupId = "";
  let keySource: ResolvedChat94Account["keySource"] = "missing";
  const keyFilePath = resolveChat94KeyFilePath(accountId);

  const envGroupKeyRaw = process.env.CHAT94_GROUP_KEY?.trim() || "";
  const configGroupKeyRaw = merged.groupKey?.trim() || "";

  if (envGroupKeyRaw.length > 0) {
    try {
      groupKeyBytes = parseGroupKey(envGroupKeyRaw);
      groupId = deriveGroupId(groupKeyBytes);
      keySource = "env";
    } catch {
      groupKeyBytes = Buffer.alloc(0) as Buffer;
      groupId = "";
    }
  } else if (configGroupKeyRaw.length > 0) {
    try {
      groupKeyBytes = parseGroupKey(configGroupKeyRaw);
      groupId = deriveGroupId(groupKeyBytes);
      keySource = "config";
    } catch {
      groupKeyBytes = Buffer.alloc(0) as Buffer;
      groupId = "";
    }
  } else {
    const stored = loadStoredGroupKey(accountId);
    if (stored) {
      groupKeyBytes = Buffer.from(stored.groupKeyBytes);
      groupId = stored.groupId;
      keySource = "state-file";
    }
  }

  const configured = groupKeyBytes.length === 32;

  return {
    accountId,
    enabled: merged.enabled !== false,
    configured,
    relayUrl,
    pairingLogLevel: merged.pairingLogLevel === "debug" ? "debug" : "info",
    runtimeLogLevel: merged.runtimeLogLevel === "debug" ? "debug" : "info",
    groupId,
    groupKeyBytes,
    keyFilePath,
    keySource,
    config: merged,
  };
}

/**
 * Check if the channel has been configured via env vars alone
 * (used by setup wizard to detect pre-configuration)
 */
export function hasConfiguredState(env?: Record<string, string>): boolean {
  const groupKey = env?.CHAT94_GROUP_KEY?.trim();
  return Boolean(groupKey && groupKey.length > 0);
}
