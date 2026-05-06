/**
 * Tests for `openclaw chat4000 reset` — destructive wipe of local state.
 *
 * The command resolves paths via `resolveChat4000KeyFilePath` and
 * `resolveAckStorePath`, both of which honor `OPENCLAW_HOME`. Tests point
 * the env var at a tmpdir so we're never touching the real
 * `~/.openclaw` tree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runResetCommand } from "../../src/cli.js";

describe("runResetCommand — destructive wipe", () => {
  let tmpHome: string;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), "chat4000-reset-"));
    process.env.OPENCLAW_STATE_DIR = tmpHome;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedAccount(accountId: string) {
    const keysDir = path.join(tmpHome, "plugins", "chat4000", "keys");
    const stateDir = path.join(tmpHome, "plugins", "chat4000", "state");
    mkdirSync(keysDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const keyPath = path.join(keysDir, `${accountId}.json`);
    const dbPath = path.join(stateDir, `${accountId}.sqlite`);
    writeFileSync(keyPath, JSON.stringify({ version: 1, accountId, groupKey: "fake" }));
    writeFileSync(dbPath, "SQLite-data");
    writeFileSync(`${dbPath}-wal`, "wal");
    writeFileSync(`${dbPath}-shm`, "shm");
    mkdirSync(`${dbPath}.lock`);
    return { keyPath, dbPath };
  }

  it("removes the key file, the SQLite db, its WAL/SHM siblings, and the lock dir", async () => {
    const { keyPath, dbPath } = seedAccount("default");
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);

    await runResetCommand({});

    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it("targets the requested account only — other accounts are untouched", async () => {
    const a = seedAccount("default");
    const b = seedAccount("work");

    await runResetCommand({ account: "default" });

    expect(existsSync(a.keyPath)).toBe(false);
    expect(existsSync(a.dbPath)).toBe(false);
    expect(existsSync(b.keyPath)).toBe(true);
    expect(existsSync(b.dbPath)).toBe(true);
  });

  it("is a no-op (and does not throw) when there is no local state", async () => {
    // No seed — fresh tmpHome with no files.
    await expect(runResetCommand({})).resolves.toBeUndefined();
  });

  it("treats missing/empty --account as 'default'", async () => {
    const { keyPath } = seedAccount("default");
    await runResetCommand({ account: "" });
    expect(existsSync(keyPath)).toBe(false);
  });

  it("sanitizes account ids the same way the rest of the plugin does", async () => {
    // resolveChat4000KeyFilePath / resolveAckStorePath both sanitize account
    // ids to a-zA-Z0-9._-. The reset command must hit the SAME sanitized
    // path so an "evil/../path" account id can't escape the keys dir.
    const { keyPath } = seedAccount("evil_._-");
    await runResetCommand({ account: "evil/../path" });
    // The seeded "evil_._-" file should NOT have been removed because the
    // sanitized form of "evil/../path" is different (e.g. "evil_.._path").
    expect(existsSync(keyPath)).toBe(true);
  });
});
