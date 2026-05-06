/**
 * Wire-format regression tests.
 *
 * Pin the on-the-wire JSON shapes that the iPhone / Mac apps depend on.
 * These tests catch the production failure mode from 2026-05-06: a sender
 * that reuses `inner.id` across streaming frames trips §6.6.9 dedup on the
 * receiver side, and only the first frame renders.
 *
 * Approach: drive `RelayMessageTransport.send(...)` against a captured
 * outbound envelope, decrypt it locally, and assert the inner JSON shape
 * field-by-field. We bypass the real WebSocket via `_attachForTests`
 * because the unit-test boundary stops at the encrypted frame — the WS
 * itself is exercised by contract tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Chat4000AckStore } from "../../src/ack-store.js";
import { decrypt, deriveGroupId } from "../../src/crypto.js";
import { RelayMessageTransport } from "../../src/transport/relay.js";
import type { RelayEnvelope } from "../../src/types.js";

type WireInner = {
  t: string;
  id: string;
  from?: { role: string; bundle_id?: string; app_version?: string };
  body: Record<string, unknown>;
  ts: number;
};

describe("wire format — outbound envelope shapes", () => {
  let tmp: string;
  let store: Chat4000AckStore;
  let captured: RelayEnvelope[];
  let transport: RelayMessageTransport;
  const groupKeyBytes = Buffer.alloc(32, 0x42);
  const groupId = deriveGroupId(groupKeyBytes);

  function decodeInner(env: RelayEnvelope): WireInner {
    const payload = env.payload as { nonce: string; ciphertext: string };
    const plaintext = decrypt(payload.nonce, payload.ciphertext, groupKeyBytes);
    if (!plaintext) throw new Error("decrypt failed");
    return JSON.parse(plaintext.toString("utf-8")) as WireInner;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "chat4000-wire-"));
    store = new Chat4000AckStore(path.join(tmp, "default.sqlite"));
    captured = [];
    transport = new RelayMessageTransport({ ackStore: store });
    transport._attachForTests({
      config: { accountId: "default", groupId, groupKeyBytes },
      store,
      capture: (env) => captured.push(env),
    });
  });

  afterEach(() => {
    transport.disconnect();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("text", () => {
    it("emits t='text', body.text, fresh inner.id, notify_if_offline=true", () => {
      transport.send({ kind: "text", text: "hello agent" });
      expect(captured).toHaveLength(1);
      const env = captured[0]!;
      expect(env.payload.notify_if_offline).toBe(true);
      const inner = decodeInner(env);
      expect(inner.t).toBe("text");
      expect(inner.body).toEqual({ text: "hello agent" });
      expect(inner.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(env.payload.msg_id).toBe(inner.id);
      expect(inner.from?.role).toBe("plugin");
      expect(inner.from?.bundle_id).toBe("@chat4000/openclaw-plugin");
    });
  });

  describe("text_delta — protocol §6.4.2 (post-2026-05-06)", () => {
    it("each frame has a fresh inner.id; stream_id lives in body", () => {
      const streamId = "stream-abc-123";
      transport.send({ kind: "textDelta", streamId, delta: "Hello" });
      transport.send({ kind: "textDelta", streamId, delta: " world" });
      transport.send({ kind: "textDelta", streamId, delta: "!" });

      expect(captured).toHaveLength(3);
      const inners = captured.map(decodeInner);

      // All three are text_delta on the same stream_id.
      for (const inner of inners) {
        expect(inner.t).toBe("text_delta");
        expect(inner.body.stream_id).toBe(streamId);
      }
      // ...but each has a UNIQUE inner.id (the production bug fix).
      const innerIds = new Set(inners.map((i) => i.id));
      expect(innerIds.size).toBe(3);
      // outer msg_id matches inner.id per frame, also unique.
      const outerIds = new Set(captured.map((e) => e.payload.msg_id as string));
      expect(outerIds.size).toBe(3);
      expect(outerIds).toEqual(innerIds);
      // No notify_if_offline on streaming partials.
      for (const env of captured) {
        expect(env.payload.notify_if_offline).toBeUndefined();
      }
      // Deltas are preserved in arrival order.
      expect((inners[0]!.body as { delta: string }).delta).toBe("Hello");
      expect((inners[1]!.body as { delta: string }).delta).toBe(" world");
      expect((inners[2]!.body as { delta: string }).delta).toBe("!");
    });

    it("inner.id is NOT equal to streamId (the §6.4.2 fix)", () => {
      const streamId = "stream-xyz";
      transport.send({ kind: "textDelta", streamId, delta: "a" });
      const inner = decodeInner(captured[0]!);
      expect(inner.id).not.toBe(streamId);
      expect(inner.body.stream_id).toBe(streamId);
    });
  });

  describe("text_end — protocol §6.4.2 (post-2026-05-06)", () => {
    it("fresh inner.id; body carries text + stream_id; notify_if_offline=true", () => {
      const streamId = "stream-final-1";
      transport.send({ kind: "textEnd", streamId, text: "Hello world" });
      const env = captured[0]!;
      const inner = decodeInner(env);
      expect(inner.t).toBe("text_end");
      expect(inner.body).toEqual({ text: "Hello world", stream_id: streamId });
      expect(inner.id).not.toBe(streamId);
      expect(env.payload.notify_if_offline).toBe(true);
    });

    it("reset:true propagates and suppresses notify_if_offline", () => {
      const streamId = "stream-reset-1";
      transport.send({
        kind: "textEnd",
        streamId,
        text: "Hello there, how",
        reset: true,
      });
      const env = captured[0]!;
      const inner = decodeInner(env);
      expect(inner.body).toEqual({
        text: "Hello there, how",
        reset: true,
        stream_id: streamId,
      });
      expect(env.payload.notify_if_offline).toBeUndefined();
    });

    it("dedup: second textEnd on the same streamId is a no-op", () => {
      const streamId = "stream-dup";
      const a = transport.send({ kind: "textEnd", streamId, text: "first" });
      const b = transport.send({ kind: "textEnd", streamId, text: "second" });
      expect(a).toBe(b);
      expect(captured).toHaveLength(1);
      const inner = decodeInner(captured[0]!);
      expect(inner.body.text).toBe("first");
    });
  });

  describe("ack — protocol §6.6.5", () => {
    it("emits t='ack', body.refs, body.stage; persists idempotency across sends", () => {
      const a = transport.send({
        kind: "ack",
        refs: "msg-from-app-1",
        stage: "received",
      });
      const b = transport.send({
        kind: "ack",
        refs: "msg-from-app-1",
        stage: "received",
      });
      expect(a).toBe(b);
      expect(captured).toHaveLength(1);
      const inner = decodeInner(captured[0]!);
      expect(inner.t).toBe("ack");
      expect(inner.body).toEqual({ refs: "msg-from-app-1", stage: "received" });
      // Different stage on same refs is a different ack.
      transport.send({ kind: "ack", refs: "msg-from-app-1", stage: "processing" });
      expect(captured).toHaveLength(2);
    });
  });

  describe("status — protocol §6.5", () => {
    it("emits t='status', body.status, no notify_if_offline", () => {
      transport.send({ kind: "status", status: "typing" });
      const env = captured[0]!;
      const inner = decodeInner(env);
      expect(inner.t).toBe("status");
      expect(inner.body).toEqual({ status: "typing" });
      expect(env.payload.notify_if_offline).toBeUndefined();
    });
  });

  describe("end-to-end stream — production failure-mode regression", () => {
    it("4 deltas + 1 end on one streamId produce 5 distinct outer msg_ids and 5 distinct inner.ids", () => {
      const streamId = "agent-reply-stream-A";
      transport.send({ kind: "textDelta", streamId, delta: "Hello" });
      transport.send({ kind: "textDelta", streamId, delta: " " });
      transport.send({ kind: "textDelta", streamId, delta: "world" });
      transport.send({ kind: "textDelta", streamId, delta: "!" });
      transport.send({ kind: "textEnd", streamId, text: "Hello world!" });

      expect(captured).toHaveLength(5);
      const innerIds = captured.map((e) => decodeInner(e).id);
      const outerIds = captured.map((e) => e.payload.msg_id as string);

      // The §6.6.9 dedup requirement: every wire frame has a unique msg_id.
      expect(new Set(innerIds).size).toBe(5);
      expect(new Set(outerIds).size).toBe(5);
      expect(outerIds).toEqual(innerIds);

      // The §6.4.2 stream correlation: all 5 carry the same body.stream_id.
      const streamIdsFromBody = captured.map(
        (e) => decodeInner(e).body.stream_id,
      );
      expect(new Set(streamIdsFromBody)).toEqual(new Set([streamId]));
    });
  });
});
