/**
 * Behavioral pinning tests for `MockMessageTransport`.
 *
 * The mock backs every consumer-side test in the suite, so the invariants
 * it claims to enforce (inbound dedup by inner.id, at-most-one ack per
 * (refs, stage), at-most-one textEnd per streamId) MUST mirror the real
 * `RelayMessageTransport`. These tests pin those invariants.
 */
import { describe, expect, it } from "vitest";
import { MockMessageTransport } from "../../src/transport/mock.js";
import type { InnerMessage } from "../../src/transport/index.js";

function textInner(id: string, text: string): InnerMessage {
  return {
    id,
    from: { role: "app" },
    body: { kind: "text", text },
    ts: Date.now(),
  };
}

describe("MockMessageTransport", () => {
  it("onReceive fires once per inner.id; duplicate simulateReceive is a no-op", () => {
    const t = new MockMessageTransport();
    const seen: string[] = [];
    t.onReceive((m) => seen.push(m.id));

    const m = textInner("id-1", "hi");
    t.simulateReceive(m);
    t.simulateReceive(m);
    t.simulateReceive(textInner("id-1", "different body, same id"));
    t.simulateReceive(textInner("id-2", "second"));

    expect(seen).toEqual(["id-1", "id-2"]);
  });

  it("simulateReceiveUnchecked bypasses dedup", () => {
    const t = new MockMessageTransport();
    const seen: string[] = [];
    t.onReceive((m) => seen.push(m.id));
    t.simulateReceiveUnchecked(textInner("id-1", "a"));
    t.simulateReceiveUnchecked(textInner("id-1", "b"));
    expect(seen).toEqual(["id-1", "id-1"]);
  });

  it("at most one outbound ack per (refs, stage); second call returns the same wire id", () => {
    const t = new MockMessageTransport();
    const a = t.send({ kind: "ack", refs: "msg-1", stage: "received" });
    const b = t.send({ kind: "ack", refs: "msg-1", stage: "received" });
    expect(a).toBe(b);
    expect(t.sent.filter((s) => s.message.kind === "ack")).toHaveLength(1);

    // Different stage on the same refs is a different ack.
    t.send({ kind: "ack", refs: "msg-1", stage: "processing" });
    expect(t.sent.filter((s) => s.message.kind === "ack")).toHaveLength(2);
  });

  it("at most one outbound textEnd per streamId", () => {
    const t = new MockMessageTransport();
    t.send({ kind: "textEnd", streamId: "s1", text: "hello" });
    t.send({ kind: "textEnd", streamId: "s1", text: "duplicate" });
    expect(t.sent.filter((s) => s.message.kind === "textEnd")).toHaveLength(1);

    t.send({ kind: "textEnd", streamId: "s2", text: "different stream" });
    expect(t.sent.filter((s) => s.message.kind === "textEnd")).toHaveLength(2);
  });

  it("textDelta is not deduped by streamId — multiple deltas per stream are normal", () => {
    const t = new MockMessageTransport();
    t.send({ kind: "textDelta", streamId: "s1", delta: "hello" });
    t.send({ kind: "textDelta", streamId: "s1", delta: " world" });
    expect(t.sent.filter((s) => s.message.kind === "textDelta")).toHaveLength(2);
  });

  it("connect → connecting → connected fires onConnectionState in order", () => {
    const t = new MockMessageTransport();
    const states: unknown[] = [];
    t.onConnectionState((s) => states.push(s));
    t.connect({
      accountId: "default",
      groupId: "g".repeat(64),
      groupKeyBytes: Buffer.alloc(32),
    });
    expect(states).toEqual(["disconnected", "connecting", "connected"]);
  });

  it("send after disconnect throws", () => {
    const t = new MockMessageTransport();
    t.connect({
      accountId: "default",
      groupId: "g".repeat(64),
      groupKeyBytes: Buffer.alloc(32),
    });
    t.disconnect();
    expect(() => t.send({ kind: "text", text: "no" })).toThrow();
  });

  it("status / state subscriptions can be unsubscribed", () => {
    const t = new MockMessageTransport();
    const events: string[] = [];
    const off = t.onStatus((u) => events.push(u.msgId));
    t.simulateStatus({ msgId: "x", status: "sent" });
    off();
    t.simulateStatus({ msgId: "y", status: "sent" });
    expect(events).toEqual(["x"]);
  });
});
