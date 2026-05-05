/**
 * Persistent ack/dedupe store for the chat4000 plugin.
 *
 * Backed by `node-sqlite3-wasm` — pure WebAssembly SQLite with a Node-fs
 * VFS that translates SQLite's OS interface to `fs.openSync` / `readSync` /
 * `writeSync` / `fsyncSync`. This gives us full WAL durability on disk
 * (`<dbPath>` + `<dbPath>-wal` + `<dbPath>-shm`) without a native binary,
 * without any postinstall script, and without depending on Node version
 * features (works on Node ≥18 unchanged; survives OpenClaw's
 * `npm install --ignore-scripts` plugin install policy).
 *
 * Each account gets its own database at
 * `<openclaw-state>/plugins/chat4000/state/<accountId>.sqlite` so that
 * pairing rotations or multi-account setups never share watermarks.
 *
 * Stored data:
 *   - `meta`: per `(group_id, role)` cumulative `last_acked_seq` for Flow A
 *     reconnect replay.
 *   - `messages`: idempotent application-layer log keyed by inner `msg_id`.
 *     Used to dedupe relay redrives (§6.6.9).
 *   - `inner_acks`: enforces "at most one inner ack per (refs, stage)" so
 *     duplicate inbound msgs from a redrive don't double-emit Flow B acks.
 */
import { Database, type Statement } from "node-sqlite3-wasm";
import { existsSync, mkdirSync, statSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawHome } from "./key-store.js";

export type AckStoreRole = "plugin" | "app";

export type RecordInboundResult = {
  /** True when this msg_id was inserted; false when it was already present (duplicate redrive). */
  isNew: boolean;
};

export type MarkInnerAckResult = {
  /** True if this is the first time we are emitting an ack for (refs, stage). */
  isNew: boolean;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  group_id TEXT NOT NULL,
  role TEXT NOT NULL,
  last_acked_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, role)
);

CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT NOT NULL PRIMARY KEY,
  group_id TEXT NOT NULL,
  seq INTEGER,
  inner_t TEXT,
  ts INTEGER,
  persisted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_group_seq
  ON messages(group_id, seq);

CREATE TABLE IF NOT EXISTS inner_acks (
  group_id TEXT NOT NULL,
  refs TEXT NOT NULL,
  stage TEXT NOT NULL,
  emitted_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, refs, stage)
);
`;

function sanitizeAccountId(accountId: string): string {
  const value = accountId.trim() || "default";
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveStateDir(): string {
  return path.join(resolveOpenClawHome(), "plugins", "chat4000", "state");
}

export function resolveAckStorePath(accountId: string): string {
  return path.join(resolveStateDir(), `${sanitizeAccountId(accountId)}.sqlite`);
}

/**
 * Remove a stale lock directory left behind by a previously-killed process.
 *
 * `node-sqlite3-wasm` uses `<dbPath>.lock/` as its mkdir-based lock primitive
 * (its WASM VFS can't use OS file locks the way native SQLite can). The
 * library `fs.mkdirSync`s to acquire and `fs.rmdirSync`s to release. When the
 * previous process is killed (-9, OOM, container restart, gateway upgrade,
 * etc.) between those two calls, the lock dir is left behind. The next open
 * then throws SQLITE_BUSY ("database is locked") and the channel auto-restart
 * loop never recovers.
 *
 * The plugin is single-process (one OpenClaw gateway, one chat4000 channel
 * per account). Any pre-existing lock dir at construction time is by
 * definition stale — we haven't acquired anything yet. Remove it.
 *
 * Returns true if a stale lock was removed, so the caller can log/audit.
 */
export function cleanupStaleAckStoreLock(dbPath: string): boolean {
  const lockDir = `${dbPath}.lock`;
  if (!existsSync(lockDir)) {
    return false;
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    // Best effort. If removal fails the next open will throw with the
    // canonical "database is locked" error and the caller surfaces it.
    return false;
  }
}

const cache = new Map<string, Chat4000AckStore>();

export class Chat4000AckStore {
  private readonly db: Database;

  private readonly stmtGetWatermark: Statement;

  private readonly stmtUpsertWatermark: Statement;

  private readonly stmtInsertMessage: Statement;

  private readonly stmtHasMessage: Statement;

  private readonly stmtInsertInnerAck: Statement;

  constructor(
    public readonly dbPath: string,
    opts?: {
      /** Test-only: skip stale-lock recovery so the test can simulate "another
       *  live process holds the lock" by manually creating the lock dir. */
      _skipStaleLockCleanup?: boolean;
    },
  ) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!opts?._skipStaleLockCleanup) {
      cleanupStaleAckStoreLock(dbPath);
    }
    this.db = new Database(dbPath);
    // Request WAL but accept whatever the WASM VFS supports. node-sqlite3-wasm
    // can't expose the shared-memory primitives WAL needs, so SQLite silently
    // falls back to DELETE journal mode. DELETE + synchronous=FULL is still
    // ACID across crashes — every commit fsyncs the rollback journal before
    // touching the main file. The watermark/dedupe contract holds either way.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(SCHEMA_SQL);
    try {
      // Tighten file permissions; best-effort.
      const st = statSync(dbPath);
      if ((st.mode & 0o777) !== 0o600) {
        chmodSync(dbPath, 0o600);
      }
    } catch {
      // ignore
    }

    this.stmtGetWatermark = this.db.prepare(
      "SELECT last_acked_seq FROM meta WHERE group_id = ? AND role = ?",
    );
    this.stmtUpsertWatermark = this.db.prepare(
      `INSERT INTO meta (group_id, role, last_acked_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, role) DO UPDATE SET
         last_acked_seq = MAX(meta.last_acked_seq, excluded.last_acked_seq),
         updated_at = excluded.updated_at`,
    );
    this.stmtInsertMessage = this.db.prepare(
      `INSERT OR IGNORE INTO messages (msg_id, group_id, seq, inner_t, ts, persisted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtHasMessage = this.db.prepare(
      "SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1",
    );
    this.stmtInsertInnerAck = this.db.prepare(
      `INSERT OR IGNORE INTO inner_acks (group_id, refs, stage, emitted_at)
       VALUES (?, ?, ?, ?)`,
    );
  }

  /**
   * High-water mark to send on `hello.last_acked_seq` for the given recipient
   * triple. Returns 0 when no successful ack has been persisted yet — which is
   * a valid value: ack-aware relays will redrive the entire current queue,
   * pre-ack relays will ignore the field.
   */
  getLastAckedSeq(groupId: string, role: AckStoreRole = "plugin"): number {
    const row = this.stmtGetWatermark.get([groupId, role]) as
      | { last_acked_seq: number }
      | null;
    return row?.last_acked_seq ?? 0;
  }

  /**
   * Advance the cumulative high-water mark. Monotonic: never decreases.
   */
  setLastAckedSeq(groupId: string, seq: number, role: AckStoreRole = "plugin"): void {
    if (!Number.isFinite(seq) || seq < 0) {
      return;
    }
    this.stmtUpsertWatermark.run([groupId, role, Math.floor(seq), Date.now()]);
  }

  /**
   * Idempotent application-layer record of an inbound message. Returns
   * `isNew=false` when the relay redrove a `msg_id` we have already
   * processed — caller should still ack the (new) seq but must not
   * re-dispatch the prompt.
   */
  recordInboundMessage(params: {
    msgId: string;
    groupId: string;
    seq?: number;
    innerT?: string;
    ts?: number;
  }): RecordInboundResult {
    const result = this.stmtInsertMessage.run([
      params.msgId,
      params.groupId,
      params.seq ?? null,
      params.innerT ?? null,
      params.ts ?? null,
      Date.now(),
    ]);
    return { isNew: Number(result.changes) === 1 };
  }

  hasInboundMessage(msgId: string): boolean {
    return this.stmtHasMessage.get([msgId]) != null;
  }

  /**
   * Returns `isNew=true` only the first time we mark `(groupId, refs, stage)`.
   * Used by Flow B emission to enforce "at most one ack per stage per msg_id"
   * even across redrives and process restarts.
   */
  markInnerAckEmitted(params: {
    groupId: string;
    refs: string;
    stage: string;
  }): MarkInnerAckResult {
    const result = this.stmtInsertInnerAck.run([
      params.groupId,
      params.refs,
      params.stage,
      Date.now(),
    ]);
    return { isNew: Number(result.changes) === 1 };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Lazily open (and cache) the per-account ack store. Multiple monitors for
 * the same account share one DB handle.
 */
export function openAckStore(accountId: string): Chat4000AckStore {
  const dbPath = resolveAckStorePath(accountId);
  const cached = cache.get(dbPath);
  if (cached) {
    return cached;
  }
  const store = new Chat4000AckStore(dbPath);
  cache.set(dbPath, store);
  return store;
}

/** Test-only: drop the cache so tests can use isolated DB paths. */
export function _resetAckStoreCacheForTests(): void {
  for (const store of cache.values()) {
    store.close();
  }
  cache.clear();
}
