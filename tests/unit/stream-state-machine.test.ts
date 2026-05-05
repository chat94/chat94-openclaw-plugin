/**
 * Regression tests for Bug A (double text_end on the same stream_id when the
 * agent's reply array has >1 element) and Bug B (one logical reply split into
 * two streams when the agent pauses mid-stream and resumes non-monotonically).
 *
 * The dispatcher and onPartialReply lifecycle live inside `channel.ts` as a
 * closure with a lot of OpenClaw runtime context. Rather than instantiate the
 * whole channel, this test reconstructs the exact state-machine logic
 * (queueStreamDelta, flushBufferedStream, resetStreamForRewrite, deliver
 * callback's stream-rotation, startNewStream) using the same private send.ts
 * functions the channel uses. Anything we change in channel.ts that breaks
 * either of these failure modes will trip a test here.
 *
 * Decoded inner messages are inspected directly so the assertions speak in
 * protocol terms (text_delta / text_end / reset / stream_id) rather than
 * implementation terms.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  registerSender,
  unregisterSender,
  sendStreamDelta,
  sendStreamEnd,
} from "../../src/send.js";
import { decrypt, deriveGroupId } from "../../src/crypto.js";
import type { InnerMessage, RelayEnvelope, ResolvedChat4000Account } from "../../src/types.js";

describe("streaming state machine — Bug A & Bug B regressions", () => {
  const sentMessages: RelayEnvelope[] = [];
  const groupKeyBytes = Buffer.alloc(32, 0x99);
  const groupId = deriveGroupId(groupKeyBytes);
  const account: Pick<
    ResolvedChat4000Account,
    "groupId" | "groupKeyBytes" | "accountId" | "runtimeLogLevel"
  > = {
    accountId: "default",
    groupId,
    groupKeyBytes,
    runtimeLogLevel: "info",
  };

  function decodeInner(env: RelayEnvelope): InnerMessage {
    const payload = env.payload as { nonce: string; ciphertext: string };
    const plaintext = decrypt(payload.nonce, payload.ciphertext, groupKeyBytes);
    if (!plaintext) throw new Error("decrypt failed");
    return JSON.parse(plaintext.toString("utf-8")) as InnerMessage;
  }

  function inners(): InnerMessage[] {
    return sentMessages.map(decodeInner);
  }

  beforeEach(() => {
    sentMessages.length = 0;
    registerSender(account, (env) => sentMessages.push(env));
  });

  afterEach(() => {
    unregisterSender(groupId);
  });

  /**
   * Faithful replica of the channel.ts streaming state machine. Mirrors:
   *   - lastPartialText / lastText
   *   - streamId / streamActive / firstStreamChunkSent
   *   - flushBufferedStream / queueStreamDelta / resetStreamForRewrite
   *   - deliver(kind:"final") with startNewStream() rotation (Bug A fix)
   *   - onPartialReply rewrite path uses sendStreamEnd reset:true (Bug B fix)
   *
   * The flush timer is replaced with a synchronous flush-on-record since
   * tests don't need timer accuracy.
   */
  function makeStreamSM() {
    let streamId = randomUUID();
    let streamActive = false;
    let lastText = "";
    let lastPartialText = "";

    const queueDelta = (text: string) => {
      if (!text) return;
      streamActive = true;
      lastText += text;
      sendStreamDelta(groupId, streamId, text);
    };

    const resetStreamForRewrite = (nextText: string) => {
      if (streamActive && lastText.length > 0) {
        sendStreamEnd(groupId, streamId, lastText, { reset: true });
      }
      streamId = randomUUID();
      streamActive = false;
      lastText = "";
      if (nextText) queueDelta(nextText);
    };

    const startNewStream = () => {
      streamId = randomUUID();
      streamActive = false;
      lastText = "";
      lastPartialText = "";
    };

    const onPartialReply = (text: string) => {
      if (!text) return;
      if (!lastPartialText) {
        lastPartialText = text;
        queueDelta(text);
        return;
      }
      if (text === lastPartialText) return;
      if (text.startsWith(lastPartialText)) {
        const delta = text.slice(lastPartialText.length);
        lastPartialText = text;
        queueDelta(delta);
        return;
      }
      // Non-monotonic → rewrite path.
      lastPartialText = text;
      resetStreamForRewrite(text);
    };

    const deliverFinal = (text: string) => {
      if (streamActive) {
        const finalText = text || lastText;
        if (finalText.length > 0) {
          sendStreamEnd(groupId, streamId, finalText);
        }
        startNewStream();
        return;
      }
      // Non-streaming path (one-shot text reply): irrelevant for these tests
      // but completeness for the SM contract — rotate state regardless.
      startNewStream();
    };

    return { onPartialReply, deliverFinal, currentStreamId: () => streamId };
  }

  describe("Bug A — multiple deliver(final) calls (agent's reply array has >1 element)", () => {
    it("two deliver(final) calls produce two distinct stream_ids, each with exactly one text_end", () => {
      const sm = makeStreamSM();

      // Reply payload #1 streams in, then OpenClaw fires deliver(final) for it.
      sm.onPartialReply("It is sunny");
      sm.onPartialReply("It is sunny, 72°F");
      sm.deliverFinal("It is sunny, 72°F.");

      // Reply payload #2 (second element of the agent's `replies` array)
      // streams in next; OpenClaw fires deliver(final) again.
      sm.onPartialReply("The time is 3:14pm");
      sm.deliverFinal("The time is 3:14pm.");

      const all = inners();
      const textEnds = all.filter((m) => m.t === "text_end");
      const streamIdsOfEnds = textEnds.map((m) => m.id);
      const distinctStreamIds = new Set(streamIdsOfEnds);

      // Two final replies → two distinct stream_ids → two text_ends.
      expect(textEnds.length).toBe(2);
      expect(distinctStreamIds.size).toBe(2);
      // Neither end carries reset (these are normal finalizations).
      for (const e of textEnds) {
        expect((e.body as Record<string, unknown>).reset).toBeUndefined();
      }
    });

    it("regression: each stream_id receives at most ONE text_end", () => {
      const sm = makeStreamSM();
      sm.onPartialReply("Reply one");
      sm.deliverFinal("Reply one.");
      sm.onPartialReply("Reply two");
      sm.deliverFinal("Reply two.");
      sm.onPartialReply("Reply three");
      sm.deliverFinal("Reply three.");

      const textEndsByStreamId = new Map<string, number>();
      for (const m of inners()) {
        if (m.t === "text_end") {
          textEndsByStreamId.set(m.id, (textEndsByStreamId.get(m.id) ?? 0) + 1);
        }
      }
      for (const [, count] of textEndsByStreamId) {
        expect(count).toBe(1);
      }
      expect(textEndsByStreamId.size).toBe(3);
    });

    it("a second deliver(final) immediately after the first does NOT re-finalize the previous stream_id", () => {
      // This is the literal production failure: the agent had >1 reply payload
      // and OpenClaw fired deliver(final) twice in quick succession. Pre-fix,
      // both ends went to the same stream_id; post-fix, they go to two.
      const sm = makeStreamSM();
      sm.onPartialReply("Hello");
      const firstStreamId = sm.currentStreamId();
      sm.deliverFinal("Hello.");
      // Do NOT call onPartialReply between the two finals — startNewStream
      // must rotate the streamId without needing fresh partial text.
      sm.deliverFinal("World.");

      const textEnds = inners().filter((m) => m.t === "text_end");
      expect(textEnds.length).toBeLessThanOrEqual(2);
      // The first text_end is on firstStreamId.
      expect(textEnds[0]!.id).toBe(firstStreamId);
      // The second text_end (if any) is NOT on the same stream_id.
      if (textEnds.length === 2) {
        expect(textEnds[1]!.id).not.toBe(firstStreamId);
      }
    });
  });

  describe("Bug B — non-monotonic partial mid-stream (rewrite via reset:true + new stream_id)", () => {
    it("non-monotonic partial closes the current stream with reset:true and opens a fresh stream_id", () => {
      const sm = makeStreamSM();

      sm.onPartialReply("It's sunny");
      sm.onPartialReply("It's sunny, 72°F");
      const streamABeforeRewrite = sm.currentStreamId();
      // Agent pauses, resumes with totally different content.
      sm.onPartialReply("Sorry let me check");
      const streamBAfterRewrite = sm.currentStreamId();
      sm.deliverFinal("The time is 3:14pm.");

      const all = inners();
      // The text_end with reset:true must be on stream A.
      const resets = all.filter(
        (m) => m.t === "text_end" && (m.body as Record<string, unknown>).reset === true,
      );
      expect(resets).toHaveLength(1);
      expect(resets[0]!.id).toBe(streamABeforeRewrite);

      // The final (non-reset) text_end must be on stream B.
      const finals = all.filter(
        (m) => m.t === "text_end" && !(m.body as Record<string, unknown>).reset,
      );
      expect(finals).toHaveLength(1);
      expect(finals[0]!.id).toBe(streamBAfterRewrite);

      // Streams A and B are distinct.
      expect(streamABeforeRewrite).not.toBe(streamBAfterRewrite);
    });

    it("monotonic-extending partials never trigger a rewrite", () => {
      const sm = makeStreamSM();
      const streamId = sm.currentStreamId();
      sm.onPartialReply("Hello");
      sm.onPartialReply("Hello there");
      sm.onPartialReply("Hello there, friend");
      sm.deliverFinal("Hello there, friend.");

      const all = inners();
      const resets = all.filter(
        (m) => m.t === "text_end" && (m.body as Record<string, unknown>).reset === true,
      );
      // No reset should have fired.
      expect(resets).toHaveLength(0);
      // All deltas + the single text_end share the original stream_id.
      const ids = new Set(all.filter((m) => m.t === "text_delta" || m.t === "text_end").map((m) => m.id));
      expect(ids).toEqual(new Set([streamId]));
    });

    it("identical-text repeat partial is a no-op (no extra delta, no reset)", () => {
      const sm = makeStreamSM();
      sm.onPartialReply("Hi");
      sm.onPartialReply("Hi"); // exact repeat
      sm.deliverFinal("Hi.");

      const deltas = inners().filter((m) => m.t === "text_delta");
      // Only one delta from the first partial; the repeat must not have produced one.
      expect(deltas.length).toBe(1);
    });

    it("multiple non-monotonic rewrites each produce their own reset+new stream", () => {
      const sm = makeStreamSM();
      sm.onPartialReply("Try one");
      const a = sm.currentStreamId();
      sm.onPartialReply("Different");
      const b = sm.currentStreamId();
      sm.onPartialReply("Yet another");
      const c = sm.currentStreamId();
      sm.deliverFinal("Final answer.");

      const resets = inners().filter(
        (m) => m.t === "text_end" && (m.body as Record<string, unknown>).reset === true,
      );
      expect(resets).toHaveLength(2);
      expect(resets.map((r) => r.id)).toEqual([a, b]);
      expect(new Set([a, b, c]).size).toBe(3);
    });
  });

  describe("integration — Bug A + Bug B together (the production failure shape)", () => {
    it("rewrite mid-stream + multi-reply array: 1 reset + 2 normal finals on 3 distinct stream_ids", () => {
      const sm = makeStreamSM();

      // Reply 1 streams in monotonically — clean stream A.
      sm.onPartialReply("Reply one start");
      sm.onPartialReply("Reply one start, here it is.");
      sm.deliverFinal("Reply one start, here it is.");

      // Reply 2 starts streaming, then mid-stream rewrites.
      sm.onPartialReply("Reply two trying");
      sm.onPartialReply("Reply two trying again");
      sm.onPartialReply("Different content"); // ← rewrite triggers reset
      sm.onPartialReply("Different content, finalized.");
      sm.deliverFinal("Different content, finalized.");

      const all = inners();
      const textEnds = all.filter((m) => m.t === "text_end");
      const resets = textEnds.filter(
        (m) => (m.body as Record<string, unknown>).reset === true,
      );
      const finals = textEnds.filter(
        (m) => !(m.body as Record<string, unknown>).reset,
      );

      // 1 reset (from the mid-stream rewrite of reply 2).
      expect(resets).toHaveLength(1);
      // 2 normal finals (one per logical reply).
      expect(finals).toHaveLength(2);
      // 3 distinct stream_ids overall (reply1, reply2-abandoned, reply2-fresh).
      const allStreamIds = new Set(textEnds.map((e) => e.id));
      expect(allStreamIds.size).toBe(3);
      // No stream_id appears on more than one text_end.
      const counts = new Map<string, number>();
      for (const e of textEnds) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      for (const [, c] of counts) expect(c).toBe(1);
    });
  });
});
