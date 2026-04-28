import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolveChat94Account, hasConfiguredState } from "../../src/accounts.js";
import { deriveGroupId } from "../../src/crypto.js";
import { saveStoredGroupKey } from "../../src/key-store.js";

describe("accounts", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];
  const groupKey = Buffer.alloc(32, 0x61);
  const groupKeyB64 = groupKey.toString("base64url");
  const groupId = deriveGroupId(groupKey);

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeOpenClawHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat94-accounts-"));
    tempDirs.push(dir);
    process.env.OPENCLAW_HOME = dir;
    return dir;
  }

  it("derives group id from config key", () => {
    const account = resolveChat94Account({
      cfg: {
        channels: {
          chat94: {
            groupKey: groupKeyB64,
          },
        },
      },
    });
    expect(account.configured).toBe(true);
    expect(account.relayUrl).toBe("wss://relay.chat94.com/ws");
    expect(account.groupId).toBe(groupId);
    expect(account.groupKeyBytes.equals(groupKey)).toBe(true);
  });

  it("missing groupKey means not configured", () => {
    const account = resolveChat94Account({
      cfg: {
        channels: {
          chat94: {},
        },
      },
    });
    expect(account.configured).toBe(false);
  });

  it("invalid groupKey means not configured", () => {
    const account = resolveChat94Account({
      cfg: {
        channels: {
          chat94: { groupKey: "bad-key" },
        },
      },
    });
    expect(account.configured).toBe(false);
    expect(account.groupId).toBe("");
    expect(account.groupKeyBytes).toHaveLength(0);
  });

  it("group key env vars override config", () => {
    const envKey = Buffer.alloc(32, 0x62);
    process.env.CHAT94_GROUP_KEY = envKey.toString("base64url");

    const account = resolveChat94Account({
      cfg: {
        channels: {
          chat94: {
            groupKey: groupKeyB64,
          },
        },
      },
    });
    expect(account.relayUrl).toBe("wss://relay.chat94.com/ws");
    expect(account.groupId).toBe(deriveGroupId(envKey));
  });

  it("account-level config overrides top-level", () => {
    const topKey = Buffer.alloc(32, 0x63).toString("base64url");
    const accountKey = Buffer.alloc(32, 0x64).toString("base64url");
    const account = resolveChat94Account({
      cfg: {
        channels: {
          chat94: {
            groupKey: topKey,
            accounts: {
              myaccount: {
                groupKey: accountKey,
              },
            },
          },
        },
      },
      accountId: "myaccount",
    });
    expect(account.relayUrl).toBe("wss://relay.chat94.com/ws");
    expect(account.groupId).toBe(deriveGroupId(Buffer.from(accountKey, "base64url")));
  });

  it("hasConfiguredState checks env vars", () => {
    expect(hasConfiguredState({})).toBe(false);
    expect(hasConfiguredState({
      CHAT94_GROUP_KEY: groupKeyB64,
    })).toBe(true);
  });

  it("empty config returns default relay URL", () => {
    const account = resolveChat94Account({ cfg: {} });
    expect(account.relayUrl).toBe("wss://relay.chat94.com/ws");
    expect(account.configured).toBe(false);
  });

  it("loads the long-lived key from the plugin state file", () => {
    makeOpenClawHome();
    saveStoredGroupKey("default", groupKey);

    const account = resolveChat94Account({
      cfg: {
        channels: {
          chat94: {},
        },
      },
    });

    expect(account.configured).toBe(true);
    expect(account.keySource).toBe("state-file");
    expect(account.groupKeyBytes.equals(groupKey)).toBe(true);
    expect(account.keyFilePath).toContain("plugins/chat94/keys/default.json");
  });
});
