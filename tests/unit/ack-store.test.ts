import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Chat4000AckStore } from "../../src/ack-store.js";

describe("ack-store", () => {
  let tmpDir: string;
  let store: Chat4000AckStore;
  const groupId = "g".repeat(64);

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "chat4000-ack-"));
    store = new Chat4000AckStore(path.join(tmpDir, "default.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with last_acked_seq = 0", () => {
    expect(store.getLastAckedSeq(groupId)).toBe(0);
  });

  it("setLastAckedSeq advances watermark monotonically", () => {
    store.setLastAckedSeq(groupId, 100);
    expect(store.getLastAckedSeq(groupId)).toBe(100);
    store.setLastAckedSeq(groupId, 50);
    expect(store.getLastAckedSeq(groupId)).toBe(100);
    store.setLastAckedSeq(groupId, 200);
    expect(store.getLastAckedSeq(groupId)).toBe(200);
  });

  it("markProcessed is idempotent on inner msg_id", () => {
    const a = store.markProcessed(groupId, "inner-1");
    const b = store.markProcessed(groupId, "inner-1");
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(store.isProcessed(groupId, "inner-1")).toBe(true);
    expect(store.isProcessed(groupId, "inner-2")).toBe(false);
  });

  it("markProcessed isolates per group_id", () => {
    const otherGroup = "h".repeat(64);
    expect(store.markProcessed(groupId, "shared-id").isNew).toBe(true);
    expect(store.markProcessed(otherGroup, "shared-id").isNew).toBe(true);
    expect(store.isProcessed(groupId, "shared-id")).toBe(true);
    expect(store.isProcessed(otherGroup, "shared-id")).toBe(true);
  });

  it("inner-ack idempotency keyed by (group, refs, stage)", () => {
    const first = store.markInnerAckEmitted({ groupId, refs: "msg-1", stage: "received" });
    const second = store.markInnerAckEmitted({ groupId, refs: "msg-1", stage: "received" });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);

    const otherStage = store.markInnerAckEmitted({ groupId, refs: "msg-1", stage: "processing" });
    expect(otherStage.isNew).toBe(true);
  });

  it("watermark survives close/reopen at the same path", () => {
    store.setLastAckedSeq(groupId, 4180);
    store.markProcessed(groupId, "persisted");
    store.close();

    const reopened = new Chat4000AckStore(path.join(tmpDir, "default.sqlite"));
    expect(reopened.getLastAckedSeq(groupId)).toBe(4180);
    expect(reopened.isProcessed(groupId, "persisted")).toBe(true);
    reopened.close();
  });

  it("separates watermarks per (group_id, role)", () => {
    store.setLastAckedSeq(groupId, 100, "plugin");
    store.setLastAckedSeq(groupId, 50, "app");
    expect(store.getLastAckedSeq(groupId, "plugin")).toBe(100);
    expect(store.getLastAckedSeq(groupId, "app")).toBe(50);
  });
});
