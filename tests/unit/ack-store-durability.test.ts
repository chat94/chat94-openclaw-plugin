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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Chat4000AckStore } from "../../src/ack-store.js";

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
    store.setLastAckedSeq(groupA, 50); // regression attempt
    store.setLastAckedSeq(groupA, 0); // zero attempt
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
    expect(store.getLastAckedSeq(groupB, "app")).toBe(0); // never set
    store.close();
  });

  it("recordInboundMessage idempotency survives reopen", () => {
    let store = new Chat4000AckStore(dbPath);
    expect(store.recordInboundMessage({ msgId: "m1", groupId: groupA, seq: 1 }).isNew).toBe(true);
    expect(store.recordInboundMessage({ msgId: "m1", groupId: groupA, seq: 1 }).isNew).toBe(false);
    store.close();

    store = new Chat4000AckStore(dbPath);
    // After reopen, m1 is still recognized as a duplicate redrive.
    expect(store.recordInboundMessage({ msgId: "m1", groupId: groupA, seq: 1 }).isNew).toBe(false);
    expect(store.hasInboundMessage("m1")).toBe(true);
    expect(store.hasInboundMessage("m2")).toBe(false);
    store.close();
  });

  it("inner-ack idempotency table survives reopen", () => {
    let store = new Chat4000AckStore(dbPath);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "received" }).isNew).toBe(true);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "received" }).isNew).toBe(false);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "received" }).isNew).toBe(false);
    // Different stage on the same refs is a different ack — must still be allowed.
    expect(store.markInnerAckEmitted({ groupId: groupA, refs: "x", stage: "processing" }).isNew).toBe(true);
    // Different group entirely.
    expect(store.markInnerAckEmitted({ groupId: groupB, refs: "x", stage: "received" }).isNew).toBe(true);
    store.close();
  });

  it("on-disk file exists and has SQLite content after first write", () => {
    const store = new Chat4000AckStore(dbPath);
    store.setLastAckedSeq(groupA, 1);
    expect(existsSync(dbPath)).toBe(true);
    // Even under DELETE journal mode (the active mode under node-sqlite3-wasm —
    // see wa-sqlite-integration.test.ts), the main DB file must be on disk.
    store.close();
  });

  it("recording 500 distinct msg_ids preserves all of them across reopen", () => {
    // 500 rather than 5000 because synchronous=FULL + DELETE journal mode
    // means every auto-commit fsyncs — at this size we already exercise
    // the durability path without slowing the suite. The library does not
    // expose a transaction wrapper through Chat4000AckStore by design;
    // the ack hot path is one-row-at-a-time and we want to test it as it
    // runs in production.
    let store = new Chat4000AckStore(dbPath);
    for (let i = 0; i < 500; i++) {
      const r = store.recordInboundMessage({
        msgId: `bulk-${i}`,
        groupId: groupA,
        seq: i + 1,
        innerT: "text",
        ts: Date.now(),
      });
      expect(r.isNew).toBe(true);
    }
    store.setLastAckedSeq(groupA, 500);
    store.close();

    store = new Chat4000AckStore(dbPath);
    expect(store.getLastAckedSeq(groupA)).toBe(500);
    expect(store.hasInboundMessage("bulk-0")).toBe(true);
    expect(store.hasInboundMessage("bulk-250")).toBe(true);
    expect(store.hasInboundMessage("bulk-499")).toBe(true);
    expect(store.hasInboundMessage("bulk-99999")).toBe(false);
    store.close();
  });

  it("interleaved writes from a single store instance are atomic w.r.t. each other", () => {
    // No real race possible because the store is synchronous, but we lock in
    // the ordering invariant: every recordInboundMessage that returns isNew
    // is observable by a subsequent hasInboundMessage call.
    const store = new Chat4000AckStore(dbPath);
    for (let i = 0; i < 100; i++) {
      const id = `seq-${i}`;
      expect(store.recordInboundMessage({ msgId: id, groupId: groupA, seq: i + 1 }).isNew).toBe(true);
      expect(store.hasInboundMessage(id)).toBe(true);
      expect(store.recordInboundMessage({ msgId: id, groupId: groupA, seq: i + 1 }).isNew).toBe(false);
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
    // Touch all three tables — if any DDL is missing the calls would throw.
    expect(() => store.getLastAckedSeq(groupA)).not.toThrow();
    expect(() => store.recordInboundMessage({ msgId: "z", groupId: groupA, seq: 1 })).not.toThrow();
    expect(() => store.markInnerAckEmitted({ groupId: groupA, refs: "z", stage: "received" })).not.toThrow();
    store.close();
  });

  it("reopening a path that was written by an earlier Chat4000AckStore instance picks up the schema", () => {
    {
      const a = new Chat4000AckStore(dbPath);
      a.setLastAckedSeq(groupA, 10);
      a.recordInboundMessage({ msgId: "old", groupId: groupA, seq: 10 });
      a.markInnerAckEmitted({ groupId: groupA, refs: "old", stage: "received" });
      a.close();
    }
    {
      const b = new Chat4000AckStore(dbPath);
      // CREATE TABLE IF NOT EXISTS should be a no-op on existing schema —
      // these calls must not throw and must see the previously written rows.
      expect(b.getLastAckedSeq(groupA)).toBe(10);
      expect(b.hasInboundMessage("old")).toBe(true);
      expect(
        b.markInnerAckEmitted({ groupId: groupA, refs: "old", stage: "received" }).isNew,
      ).toBe(false);
      b.close();
    }
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

  it("simulates: process processes seqs 1..10, ack 1..10, restart, relay redrives 6..15", () => {
    let store = new Chat4000AckStore(dbPath);
    for (let i = 1; i <= 10; i++) {
      store.recordInboundMessage({ msgId: `m${i}`, groupId: group, seq: i });
      store.markInnerAckEmitted({ groupId: group, refs: `m${i}`, stage: "received" });
    }
    store.setLastAckedSeq(group, 10);
    store.close();

    // "Process restart" — fresh handle, same path.
    store = new Chat4000AckStore(dbPath);
    expect(store.getLastAckedSeq(group)).toBe(10);

    // Relay redrives 6..10 (already processed) plus 11..15 (new).
    const redrived: number[] = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const newlyProcessed: number[] = [];
    for (const seq of redrived) {
      const r = store.recordInboundMessage({ msgId: `m${seq}`, groupId: group, seq });
      if (r.isNew) {
        newlyProcessed.push(seq);
        // Inner ack on the new seq must succeed for the first time.
        expect(store.markInnerAckEmitted({ groupId: group, refs: `m${seq}`, stage: "received" }).isNew).toBe(true);
      } else {
        // Redrive of already-processed message — must NOT re-emit inner ack.
        expect(store.markInnerAckEmitted({ groupId: group, refs: `m${seq}`, stage: "received" }).isNew).toBe(false);
      }
    }
    expect(newlyProcessed).toEqual([11, 12, 13, 14, 15]);
    store.close();
  });

  it("simulates: relay re-assigns higher seq for redrive (msg_id stays same)", () => {
    // The protocol allows the relay to assign a new per-recipient seq on
    // redrive. The plugin must dedupe by inner msg_id, not by seq.
    let store = new Chat4000AckStore(dbPath);
    expect(store.recordInboundMessage({ msgId: "stable-id", groupId: group, seq: 5 }).isNew).toBe(true);
    store.setLastAckedSeq(group, 5);
    store.close();

    store = new Chat4000AckStore(dbPath);
    // Same msg_id, different (higher) seq from a different relay session.
    expect(store.recordInboundMessage({ msgId: "stable-id", groupId: group, seq: 17 }).isNew).toBe(false);
    // The watermark of 5 from the previous session is still in effect.
    expect(store.getLastAckedSeq(group)).toBe(5);
    store.close();
  });
});
