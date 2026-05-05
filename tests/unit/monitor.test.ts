import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Chat4000AckStore } from "../../src/ack-store.js";
import { encrypt, decrypt, deriveGroupId } from "../../src/crypto.js";
import { registerSender, unregisterSender } from "../../src/send.js";
import type { InnerMessage, RelayEnvelope, RelayMsgPayload } from "../../src/types.js";

// Capture the connect options the monitor passes to connectOnce so we can
// drive its onMessage / onConnected hooks without a real WebSocket.
let capturedConnectOpts: any = undefined;

vi.mock("../../src/monitor-websocket.js", () => ({
  connectOnce: vi.fn((opts: any) => {
    capturedConnectOpts = opts;
    return new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }),
}));

vi.mock("../../src/reconnect.js", () => ({
  runWithReconnect: async (connectFn: () => Promise<void>) => {
    await connectFn();
  },
}));

import { monitorChat4000Provider } from "../../src/monitor.js";

describe("monitor — Flow A & Flow B", () => {
  let tmpDir: string;
  let ackStore: Chat4000AckStore;
  const groupKeyBytes = Buffer.alloc(32, 0x42);
  const groupKey = groupKeyBytes.toString("base64url");
  const groupId = deriveGroupId(groupKeyBytes);

  const buildEncryptedInner = (inner: InnerMessage): { nonce: string; ciphertext: string } => {
    const plaintext = Buffer.from(JSON.stringify(inner), "utf-8");
    return encrypt(plaintext, groupKeyBytes);
  };

  const fromApp = {
    role: "app" as const,
    device_id: "iphone-1",
    device_name: "Demo iPhone",
    app_version: "1.2.3",
    bundle_id: "com.neonnode.chat4000app",
  };

  let abortController: AbortController;
  let monitorPromise: Promise<void>;
  let sentEnvelopes: RelayEnvelope[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "chat4000-mon-"));
    ackStore = new Chat4000AckStore(path.join(tmpDir, "default.sqlite"));
    capturedConnectOpts = undefined;
    sentEnvelopes = [];
    abortController = new AbortController();

    monitorPromise = monitorChat4000Provider({
      accountId: "default",
      config: {
        channels: {
          chat4000: { groupKey },
        },
      },
      abortSignal: abortController.signal,
      ackStore,
    });

    // Wait one microtask so the mocked connectOnce captures opts.
    await new Promise((r) => setImmediate(r));
    expect(capturedConnectOpts).toBeDefined();

    // Simulate "hello_ok received": fire onConnected with our send capture
    // and register the sender so sendInnerAck can ride the path.
    const sendCapture = (env: RelayEnvelope) => sentEnvelopes.push(env);
    capturedConnectOpts.onConnected(sendCapture);
    registerSender(
      { accountId: "default", groupId, groupKeyBytes, runtimeLogLevel: "info" },
      sendCapture,
    );
  });

  afterEach(async () => {
    abortController.abort();
    unregisterSender(groupId);
    ackStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      await monitorPromise;
    } catch {
      // expected
    }
  });

  function decryptInner(env: RelayEnvelope): InnerMessage | null {
    const payload = env.payload as { nonce?: string; ciphertext?: string };
    if (!payload?.nonce || !payload?.ciphertext) {
      return null;
    }
    const plaintext = decrypt(payload.nonce, payload.ciphertext, groupKeyBytes);
    if (!plaintext) {
      return null;
    }
    return JSON.parse(plaintext.toString("utf-8")) as InnerMessage;
  }

  it("emits inner ack received for app-origin text and recv_acks the seq", async () => {
    const inner: InnerMessage = {
      t: "text",
      id: "app-msg-1",
      from: fromApp,
      body: { text: "hello agent" },
      ts: Date.now(),
    };
    const enc = buildEncryptedInner(inner);
    const msg: RelayMsgPayload = {
      msg_id: "outer-1",
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
      seq: 100,
    };

    await capturedConnectOpts.onMessage(msg);

    // One inner ack envelope should have been encrypted+sent
    const ackEnv = sentEnvelopes.find((e) => {
      try {
        return decryptInner(e)?.t === "ack";
      } catch {
        return false;
      }
    });
    expect(ackEnv).toBeDefined();
    const innerAck = decryptInner(ackEnv!);
    expect(innerAck.t).toBe("ack");
    expect((innerAck.body as any).refs).toBe("app-msg-1");
    expect((innerAck.body as any).stage).toBe("received");
    expect(innerAck.from?.role).toBe("plugin");
    expect(innerAck.from?.bundle_id).toBe("@chat4000/openclaw-plugin");

    // recv_ack should be queued; force the batcher to flush by aborting.
    // Force a deterministic flush of the recv_ack batcher.
    capturedConnectOpts.onDisconnected();
    // For the very first inbound seq we observe (no prior watermark), seq=100
    // becomes a range, not the cumulative high-water mark — relay still
    // evicts that exact entry but the cumulative mark is 0 until we see 1..99.
    const recvAcks = sentEnvelopes.filter((e) => e.type === "recv_ack");
    expect(recvAcks.length).toBeGreaterThan(0);
    const last = recvAcks[recvAcks.length - 1]!.payload as { up_to_seq: number; ranges?: number[][] };
    const seqWasAcked =
      last.up_to_seq >= 100 ||
      (last.ranges?.some(([lo, hi]) => 100 >= lo && 100 <= hi) ?? false);
    expect(seqWasAcked).toBe(true);
  });

  it("does NOT emit inner ack for malformed audio (still recv_acks the seq)", async () => {
    const inner: InnerMessage = {
      t: "audio",
      id: "audio-bad",
      from: fromApp,
      body: { data_base64: "", mime_type: "" }, // malformed
      ts: Date.now(),
    } as any;
    const enc = buildEncryptedInner(inner);
    const msg: RelayMsgPayload = {
      msg_id: "outer-bad",
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
      seq: 200,
    };

    await capturedConnectOpts.onMessage(msg);

    const ackEnvs = sentEnvelopes.filter((e) => {
      try {
        return decryptInner(e)?.t === "ack";
      } catch {
        return false;
      }
    });
    expect(ackEnvs).toHaveLength(0);

    capturedConnectOpts.onDisconnected();

    // Frame is unrecoverable but we did persist it (so we dedupe redrives)
    // and we did Flow-A-ack the outer seq (as a range above the watermark).
    expect(ackStore.hasInboundMessage("outer-bad")).toBe(true);
    const recvAcks = sentEnvelopes.filter((e) => e.type === "recv_ack");
    expect(recvAcks.length).toBeGreaterThan(0);
    const last = recvAcks[recvAcks.length - 1]!.payload as { up_to_seq: number; ranges?: number[][] };
    const seqWasAcked =
      last.up_to_seq >= 200 ||
      (last.ranges?.some(([lo, hi]) => 200 >= lo && 200 <= hi) ?? false);
    expect(seqWasAcked).toBe(true);
  });

  it("redrive of an already-processed msg_id does NOT re-emit inner ack", async () => {
    const inner: InnerMessage = {
      t: "text",
      id: "app-msg-dup",
      from: fromApp,
      body: { text: "first" },
      ts: Date.now(),
    };
    const enc1 = buildEncryptedInner(inner);
    const msg1: RelayMsgPayload = {
      msg_id: "outer-dup",
      nonce: enc1.nonce,
      ciphertext: enc1.ciphertext,
      seq: 300,
    };
    await capturedConnectOpts.onMessage(msg1);

    const before = sentEnvelopes.length;
    expect(before).toBeGreaterThan(0);

    // Relay redrives the same outer payload after a reconnect (different seq
    // is also possible; here we keep it the same to simulate exact replay).
    await capturedConnectOpts.onMessage(msg1);

    // Still no NEW ack (idempotency table prevents duplicate emission).
    const acks = sentEnvelopes.filter((e) => {
      try {
        return decryptInner(e)?.t === "ack";
      } catch {
        return false;
      }
    });
    expect(acks).toHaveLength(1);
  });

  it("pre-ack mode (no seq on inbound msg) does not emit inner ack and does not move watermark", async () => {
    const inner: InnerMessage = {
      t: "text",
      id: "preack-msg-1",
      from: fromApp,
      body: { text: "hello legacy" },
      ts: Date.now(),
    };
    const enc = buildEncryptedInner(inner);
    const msg: RelayMsgPayload = {
      msg_id: "outer-preack",
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
      // intentionally NO seq → pre-ack relay
    };

    await capturedConnectOpts.onMessage(msg);

    const acks = sentEnvelopes.filter((e) => {
      try {
        return decryptInner(e)?.t === "ack";
      } catch {
        return false;
      }
    });
    expect(acks).toHaveLength(0);

    abortController.abort();
    await new Promise((r) => setImmediate(r));

    expect(ackStore.getLastAckedSeq(groupId)).toBe(0);
  });
});
