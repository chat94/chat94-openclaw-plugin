import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deriveGroupId, parseGroupKey } from "./crypto.js";

type StoredChat4000KeyFile = {
  version: 1;
  accountId: string;
  groupKey: string;
  groupId: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredChat4000Key = {
  groupKeyBytes: Buffer;
  groupId: string;
  path: string;
};

type StoredChat4000InstanceFile = {
  version: 1;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  updatedAt: string;
};

export type Chat4000InstanceIdentity = {
  deviceId: string;
  deviceName: string;
  path: string;
};

let cachedInstanceIdentity: Chat4000InstanceIdentity | null = null;

type Chat4000StateAccess = {
  stateDir: string;
  pluginDir: string;
  keysDir: string;
  keyFilePath: string;
  currentUid?: number;
  currentGid?: number;
  preferredOwnerUid?: number;
  preferredOwnerGid?: number;
  preferredOwnerPath?: string;
  canAutoRepairOwnership: boolean;
  hasOwnershipMismatch: boolean;
};

function sanitizeAccountId(accountId: string): string {
  const value = accountId.trim() || "default";
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function resolveOpenClawHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENCLAW_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return os.homedir();
}

export function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromStateEnv = env.OPENCLAW_STATE_DIR?.trim();
  if (fromStateEnv) {
    return fromStateEnv;
  }
  return path.join(resolveOpenClawHomeDir(env), ".openclaw");
}

function resolveChat4000PluginDir(): string {
  return path.join(resolveOpenClawStateDir(), "plugins", "chat4000");
}

function resolvePreferredOwner(targetPath: string): {
  uid?: number;
  gid?: number;
  path?: string;
} {
  let current = path.resolve(path.dirname(targetPath));
  while (true) {
    if (existsSync(current)) {
      try {
        const stat = statSync(current);
        return {
          uid: stat.uid,
          gid: stat.gid,
          path: current,
        };
      } catch {
        return {};
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return {};
    }
    current = parent;
  }
}

function applyOwnerIfNeeded(paths: string[], owner: { uid?: number; gid?: number }): void {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return;
  }
  if (typeof owner.uid !== "number" || typeof owner.gid !== "number") {
    return;
  }
  for (const entryPath of paths) {
    try {
      if (existsSync(entryPath)) {
        chownSync(entryPath, owner.uid, owner.gid);
      }
    } catch {
      // Best-effort ownership repair.
    }
  }
}

export function inspectChat4000StateAccess(accountId: string): Chat4000StateAccess {
  const stateDir = resolveOpenClawStateDir();
  const pluginDir = resolveChat4000PluginDir();
  const keysDir = path.join(pluginDir, "keys");
  const keyFilePath = path.join(keysDir, `${sanitizeAccountId(accountId)}.json`);
  const owner = resolvePreferredOwner(keyFilePath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : undefined;
  const hasOwnershipMismatch =
    typeof currentUid === "number" &&
    typeof owner.uid === "number" &&
    currentUid !== owner.uid;
  return {
    stateDir,
    pluginDir,
    keysDir,
    keyFilePath,
    currentUid,
    currentGid,
    preferredOwnerUid: owner.uid,
    preferredOwnerGid: owner.gid,
    preferredOwnerPath: owner.path,
    canAutoRepairOwnership: currentUid === 0 && typeof owner.uid === "number",
    hasOwnershipMismatch,
  };
}

export function resolveOpenClawHome(): string {
  return resolveOpenClawStateDir();
}

export function resolveChat4000KeyFilePath(accountId: string): string {
  return inspectChat4000StateAccess(accountId).keyFilePath;
}

function resolveChat4000InstanceFilePath(): string {
  return path.join(resolveChat4000PluginDir(), "instance.json");
}

export function loadStoredGroupKey(accountId: string): StoredChat4000Key | null {
  const filePath = resolveChat4000KeyFilePath(accountId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredChat4000KeyFile>;
    if (parsed.version !== 1 || typeof parsed.groupKey !== "string") {
      return null;
    }
    const groupKeyBytes = parseGroupKey(parsed.groupKey);
    return {
      groupKeyBytes,
      groupId:
        typeof parsed.groupId === "string" && parsed.groupId.length > 0
          ? parsed.groupId
          : deriveGroupId(groupKeyBytes),
      path: filePath,
    };
  } catch {
    return null;
  }
}

export function saveStoredGroupKey(accountId: string, groupKeyBytes: Buffer): StoredChat4000Key {
  const access = inspectChat4000StateAccess(accountId);
  const filePath = access.keyFilePath;
  mkdirSync(access.keysDir, { recursive: true });

  const now = new Date().toISOString();
  const existing = loadStoredGroupKey(accountId);
  const next: StoredChat4000KeyFile = {
    version: 1,
    accountId: sanitizeAccountId(accountId),
    groupKey: groupKeyBytes.toString("base64url"),
    groupId: deriveGroupId(groupKeyBytes),
    createdAt: existing ? now : now,
    updatedAt: now,
  };

  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission tightening.
  }
  applyOwnerIfNeeded([access.pluginDir, access.keysDir, filePath], {
    uid: access.preferredOwnerUid,
    gid: access.preferredOwnerGid,
  });

  return {
    groupKeyBytes,
    groupId: next.groupId,
    path: filePath,
  };
}

export function resolveChat4000InstanceIdentity(): Chat4000InstanceIdentity {
  if (cachedInstanceIdentity) {
    return cachedInstanceIdentity;
  }
  const filePath = resolveChat4000InstanceFilePath();
  const preferredOwner = resolvePreferredOwner(filePath);
  const defaultName = os.hostname() || "OpenClaw Plugin";

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredChat4000InstanceFile>;
      if (parsed.version === 1 && typeof parsed.deviceId === "string" && parsed.deviceId.length > 0) {
        cachedInstanceIdentity = {
          deviceId: parsed.deviceId,
          deviceName:
            typeof parsed.deviceName === "string" && parsed.deviceName.trim().length > 0
              ? parsed.deviceName
              : defaultName,
          path: filePath,
        };
        return cachedInstanceIdentity;
      }
    } catch {
      // Fall through to rewrite.
    }
  }

  const now = new Date().toISOString();
  const next: StoredChat4000InstanceFile = {
    version: 1,
    deviceId: randomUUID(),
    deviceName: defaultName,
    createdAt: now,
    updatedAt: now,
  };
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort permission tightening.
    }
    applyOwnerIfNeeded([resolveChat4000PluginDir(), filePath], preferredOwner);
  } catch {
    // Fall back to process-local identity when persistent storage is unavailable.
  }

  cachedInstanceIdentity = {
    deviceId: next.deviceId,
    deviceName: next.deviceName,
    path: filePath,
  };
  return cachedInstanceIdentity;
}
