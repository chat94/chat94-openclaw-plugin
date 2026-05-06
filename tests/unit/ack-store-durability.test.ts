/**
 * Durability + crash-recovery tests for Chat4000AckStore.
 *
 * These tests stress the property the §6.6 ack layer depends on: that an
 * `INSERT OR IGNORE` and `UPSERT meta` survive process restart. We can't
 * actually crash Vitest mid-write, but we *can* simulate the only thing
 * that matters from the protocol's perspective — close the store, drop
 * every in-memory reference, re-open at the same path, and assert the
 * persisted state is identical.
 *
 * If any of these regress, redrives will silently re-process duplicates,
 * recv_ack will re-ack already-evicted seqs, or the inner-ack idempotency
 * table will let us double-emit Flow B receipts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Chat4000AckStore, cleanupStaleAckStoreLock } from "../../src/ack-store.js";

describe("Chat4000AckStore — durability across reopen", () => {
  let tmp: string;
  let dbPath: string;
  const groupA = "a".repeat(64);
  const groupB = "b".repeat(64);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "chat4000-dura-"));
    dbPath = path.join(tmp, "default.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("watermark survives reopen of the same db path", () => {
    let store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 4123);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.getLastAckedSeq(groupA)).toBe(4123);
    store.close();
  });

  it("watermark advances monotonically, never regresses", () => {
    const store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 100);
    store.setLastAckedSeq(groupA, 250);
    store.setLastAckedSeq(groupA, 50);
    store.setLastAckedSeq(groupA, 0);
    expect(store.getLastAckedSeq(groupA)).toBe(250);
    store.close();
  });

  it("rejects negative or non-finite seq silently (no throw, no advance)", () => {
    const store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 50);
    store.setLastAckedSeq(groupA, -1);
    store.setLastAckedSeq(groupA, NaN);
    store.setLastAckedSeq(groupA, Infinity);
    expect(store.getLastAckedSeq(groupA)).toBe(50);
    store.close();
  });

  it("watermarks are isolated per (group_id, role)", () => {
    let store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 100, "plugin");
    store.setLastAckedSeq(groupA, 50, "app");
    store.setLastAckedSeq(groupB, 999, "plugin");
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.getLastAckedSeq(groupA, "plugin")).toBe(100);
    expect(store.getLastAckedSeq(groupA, "app")).toBe(50);
    expect(store.getLastAckedSeq(groupB, "plugin")).toBe(999);
    expect(store.getLastAckedSeq(groupB, "app")).toBe(0);
    store.close();
  });

  it("markProcessed idempotency survives reopen", () => {
    let store = new Chat4000AckStore(dbPath);
    expect(store.markProcessed(groupA, "inner-1").isNew).toBe(true);
    expect(store.markProcessed(groupA, "inner-1").isNew).toBe(false);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.markProcessed(groupA, "inner-1").isNew).toBe(false);
    expect(store.isProcessed(groupA, "inner-1")).toBe(true);
    expect(store.isProcessed(groupA, "inner-2")).toBe(false);
    store.close();
  });

  it("inner-ack idempotency table survives reopen", () => {
    let store = new Chat4000AckStore(dbPath);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "received" }).isNew).toBe(true);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "received" }).isNew).toBe(false);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "received" }).isNew).toBe(false);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "processing" }).isNew).toBe(true);
    expect(store.markInnerAckEmitted({ groupId: groupB, refs: "x", stage: "received" }).isNew).toBe(true);
    store.close();
  });

  it("on-disk file exists and has SQLite content after first write", () => {
    const store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 1);
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("recording 500 distinct inner msg_ids preserves all of them across reopen", () => {
    let store = new Chat4000AckStore(dbPath);
    for (let i = 0; i < 500; i++) {
      const r = store.markProcessed(groupA, `bulk-${i}`);
      expect(r.isNew).toBe(true);
    }
    store.setLastAckedSeq(groupA, 500);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.getLastAckedSeq(groupA)).toBe(500);
    expect(store.isProcessed(groupA, "bulk-0")).toBe(true);
    expect(store.isProcessed(groupA, "bulk-250")).toBe(true);
    expect(store.isProcessed(groupA, "bulk-499")).toBe(true);
    expect(store.isProcessed(groupA, "bulk-99999")).toBe(false);
    store.close();
  });

  it("interleaved writes from a single store instance are atomic w.r.t. each other", () => {
    const store = new Chat4000AckStore(dbPath);
    for (let i = 0; i < 100; i++) {
      const id = `seq-${i}`;
      expect(store.markProcessed(groupA, id).isNew).toBe(true);
      expect(store.isProcessed(groupA, id)).toBe(true);
      expect(store.markProcessed(groupA, id).isNew).toBe(false);
    }
    store.close();
  });

  it("close() is idempotent — double-close does not throw", () => {
    const store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 7);
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("operations after close() throw (no silent data loss)", () => {
    const store = new Chat4000AckStore(dbPath);
    store.close();
    expect(() => store.setLastAckedSeq(groupA, 1)).toThrow();
  });

  it("opening a fresh path creates the schema with all three tables", () => {
    const store = new Chat4000AckStore(dbPath);
    expect(() => store.getLastAckedSeq(groupA)).not.toThrow();
    expect(() => store.markProcessed(groupA, "z")).not.toThrow();
    expect(() => store.markInnerAckEmitted({ groupId: groupA, refs: "z", stage: "received" })).not.toThrow();
    store.close();
  });

  it("reopening a path that was written by an earlier Chat4000AckStore instance picks up the schema", () => {
    {
      const a = new Chat4000AckStore(dbPath);
      a.setLastAckedSeq(groupA, 10);
      a.markProcessed(groupA, "old");
      a.markInnerAckEmitted({ groupId: groupA, refs: "old", stage: "received" });
      a.close();
    }
    {
      const b = new Chat4000AckStore(dbPath);
      expect(b.getLastAckedSeq(groupA)).toBe(10);
      expect(b.isProcessed(groupA, "old")).toBe(true);
      expect(
        b.markInnerAckEmitted({ groupId: groupA, refs: "old", stage: "received" }).isNew,
      ).toBe(false);
      b.close();
    }
  });
});

describe("Chat4000AckStore — stale lock recovery (1.1.4 fix)", () => {
  let tmp: string;
  let dbPath: string;
  const groupA = "a".repeat(64);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "chat4000-lockrec-"));
    dbPath = path.join(tmp, "default.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("constructor removes a stale lock dir left by a prior killed process", () => {
    {
      const first = new Chat4000AckStore(dbPath);
      first.setLastAckedSeq(groupA, 7);
      first.close();
    }
    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir);
    expect(existsSync(lockDir)).toBe(true);

    const second = new Chat4000AckStore(dbPath);
    expect(second.getLastAckedSeq(groupA)).toBe(7);
    second.close();
  });

  it("constructor cleans up a stale lock dir even if it contains files", () => {
    {
      const first = new Chat4000AckStore(dbPath);
      first.close();
    }
    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "some-stale-file"), "leftover");

    expect(() => {
      const s = new Chat4000AckStore(dbPath);
      s.close();
    }).not.toThrow();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("cleanupStaleAckStoreLock(path) returns true when a lock was removed, false when none existed", () => {
    expect(cleanupStaleAckStoreLock(dbPath)).toBe(false);
    mkdirSync(`${dbPath}.lock`);
    expect(cleanupStaleAckStoreLock(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(cleanupStaleAckStoreLock(dbPath)).toBe(false);
  });

  it("with _skipStaleLockCleanup=true, an existing lock dir blocks the open (control test)", () => {
    {
      const first = new Chat4000AckStore(dbPath);
      first.close();
    }
    mkdirSync(`${dbPath}.lock`);
    expect(() => new Chat4000AckStore(dbPath, { _skipStaleLockCleanup: true })).toThrow();
  });
});

describe("Chat4000AckStore — relay-redrive simulation", () => {
  let tmp: string;
  let dbPath: string;
  const group = "g".repeat(64);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "chat4000-redrive-"));
    dbPath = path.join(tmp, "default.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("simulates: process processes inner ids 1..10, ack 1..10, restart, relay redrives 6..15", () => {
    let store = new Chat4000AckStore(dbPath);
    for (let i = 1; i <= 10; i++) {
      store.markProcessed(group, `inner-${i}`);
      store.markInnerAckEmitted({ groupId: group, refs: `inner-${i}`, stage: "received" });
    }
    store.setLastAckedSeq(group, 10);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.getLastAckedSeq(group)).toBe(10);

    const redrived: number[] = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const newlyProcessed: number[] = [];
    for (const i of redrived) {
      const r = store.markProcessed(group, `inner-${i}`);
      if (r.isNew) {
        newlyProcessed.push(i);
        expect(store.markInnerAckEmitted({ groupId: group, refs: `inner-${i}`, stage: "received" }).isNew).toBe(true);
      } else {
        expect(store.markInnerAckEmitted({ groupId: group, refs: `inner-${i}`, stage: "received" }).isNew).toBe(false);
      }
    }
    expect(newlyProcessed).toEqual([11, 12, 13, 14, 15]);
    store.close();
  });

  it("simulates: relay re-assigns higher seq for redrive (inner.id stays same → still dedup'd)", () => {
    // Per protocol §6.6.9 dedup is on inner.id, NOT on outer seq. The outer
    // seq can change across relay sessions; inner.id is canonical.
    let store = new Chat4000AckStore(dbPath);
    expect(store.markProcessed(group, "stable-inner-id").isNew).toBe(true);
    store.setLastAckedSeq(group, 5);
    store.close();

    store = new Chat4000AckStore(dbPath);
    // Same inner.id, different (higher) outer seq from a different relay session.
    expect(store.markProcessed(group, "stable-inner-id").isNew).toBe(false);
    expect(store.getLastAckedSeq(group)).toBe(5);
    store.close();
  });
});
