import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Chat4000AckStore } from "../../src/ack-store.js";
import { RecvAckBatcher } from "../../src/recv-ack-batcher.js";

describe("recv-ack batcher", () => {
  let tmpDir: string;
  let store: Chat4000AckStore;
  const groupId = "g".repeat(64);

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "chat4000-batcher-"));
    store = new Chat4000AckStore(path.join(tmpDir, "default.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("flushes immediately when count threshold is reached", () => {
    const sent: any[] = [];
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: (env) => sent.push(env),
      countThreshold: 3,
      idleFlushMs: 9999,
    });

    batcher.recordPersisted(1);
    batcher.recordPersisted(2);
    expect(sent).toHaveLength(0);
    batcher.recordPersisted(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("recv_ack");
    expect(sent[0].payload.up_to_seq).toBe(3);
    expect(sent[0].payload.ranges).toBeUndefined();
    batcher.shutdown();
  });

  it("flushes after idle ms", async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: (env) => sent.push(env),
      countThreshold: 32,
      idleFlushMs: 50,
    });

    batcher.recordPersisted(1);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(60);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.up_to_seq).toBe(1);
    batcher.shutdown();
  });

  it("collapses out-of-order seqs into ranges", () => {
    const sent: any[] = [];
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: (env) => sent.push(env),
      countThreshold: 32,
      idleFlushMs: 10_000,
    });

    // seq 1 fills the watermark, then a gap (2 missing), 3-5 arrive, 7 arrives.
    batcher.recordPersisted(1);
    batcher.recordPersisted(3);
    batcher.recordPersisted(4);
    batcher.recordPersisted(5);
    batcher.recordPersisted(7);
    batcher.flushNow("manual");

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.up_to_seq).toBe(1);
    expect(sent[0].payload.ranges).toEqual([
      [3, 5],
      [7, 7],
    ]);
    batcher.shutdown();
  });

  it("folds gap-fillers into the cumulative high-water mark", () => {
    const sent: any[] = [];
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: (env) => sent.push(env),
      countThreshold: 32,
      idleFlushMs: 10_000,
    });

    batcher.recordPersisted(1);
    batcher.recordPersisted(3);
    batcher.recordPersisted(4);
    batcher.flushNow("manual");
    expect(sent.pop().payload).toEqual({ up_to_seq: 1, ranges: [[3, 4]] });

    batcher.recordPersisted(2); // closes the gap
    batcher.flushNow("manual");
    expect(sent.pop().payload).toEqual({ up_to_seq: 4 });
    batcher.shutdown();
  });

  it("persists the watermark to the store before shipping the frame", () => {
    let storeAtSendTime = -1;
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: () => {
        storeAtSendTime = store.getLastAckedSeq(groupId);
      },
      countThreshold: 1,
      idleFlushMs: 10_000,
    });

    // Use seq=1 so it folds straight into the cumulative high-water mark.
    batcher.recordPersisted(1);
    expect(storeAtSendTime).toBe(1);
    expect(store.getLastAckedSeq(groupId)).toBe(1);
    batcher.shutdown();
  });

  it("shutdown forces a final flush", () => {
    const sent: any[] = [];
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: (env) => sent.push(env),
      countThreshold: 99,
      idleFlushMs: 99_999,
    });

    // Out-of-order seq → reported via ranges; cumulative watermark stays 0
    // until the gap fills.
    batcher.recordPersisted(7);
    batcher.shutdown();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.up_to_seq).toBe(0);
    expect(sent[0].payload.ranges).toEqual([[7, 7]]);
  });

  it("nothing pending → no frame emitted on flush", () => {
    const sent: any[] = [];
    const batcher = new RecvAckBatcher({
      groupId,
      store,
      send: (env) => sent.push(env),
    });
    batcher.flushNow("manual");
    batcher.shutdown();
    expect(sent).toHaveLength(0);
  });
});
