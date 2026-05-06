/**
 * Regression tests for the StreamDispatcher class.
 *
 * Pins the §6.4.2 stream-id invariants and the two production failure
 * modes from 2026-05-05:
 *
 *   - Bug A: two `deliver(final)` calls on one agent run produce two
 *     `text_end` frames on a single stream_id.
 *   - Bug B: a non-monotonic partial mid-stream produces a fresh
 *     `text_delta` with backwards content instead of closing the
 *     current stream and opening a new one.
 *
 * Drives the dispatcher directly against a MockMessageTransport so
 * assertions speak in protocol terms (kind / streamId / reset) instead
 * of implementation terms.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamDispatcher } from "../../src/stream-dispatcher.js";
import { MockMessageTransport } from "../../src/transport/mock.js";
import type { OutboundMessage } from "../../src/transport/index.js";

describe("StreamDispatcher", () => {
  let transport: MockMessageTransport;
  let dispatcher: StreamDispatcher;

  beforeEach(() => {
    transport = new MockMessageTransport();
    transport.connect({
      accountId: "default",
      groupId: "g".repeat(64),
      groupKeyBytes: Buffer.alloc(32),
    });
    // Force synchronous flushing so timer-driven flushes don't hide bugs.
    dispatcher = new StreamDispatcher({ transport, flushMinChars: 0, flushDelayMs: 0 });
  });

  afterEach(() => {
    dispatcher.dispose();
  });

  function sent(): OutboundMessage[] {
    return transport.sent.map((s) => s.message);
  }

  describe("Bug A — multiple onFinal calls (agent's reply array has >1 element)", () => {
    it("two onFinal calls produce two distinct stream_ids, each with exactly one text_end", () => {
      dispatcher.onPartial("It is sunny");
      dispatcher.onPartial("It is sunny, 72°F");
      dispatcher.onFinal("It is sunny, 72°F.");

      dispatcher.onPartial("The time is 3:14pm");
      dispatcher.onFinal("The time is 3:14pm.");

      const textEnds = sent().filter(
        (m): m is Extract<OutboundMessage, { kind: "textEnd" }> => m.kind === "textEnd",
      );
      const distinct = new Set(textEnds.map((e) => e.streamId));
      expect(textEnds).toHaveLength(2);
      expect(distinct.size).toBe(2);
      for (const e of textEnds) {
        expect(e.reset).toBeUndefined();
      }
    });

    it("each stream_id receives at most one text_end", () => {
      for (const text of ["Reply one", "Reply two", "Reply three"]) {
        dispatcher.onPartial(text);
        dispatcher.onFinal(`${text}.`);
      }
      const counts = new Map<string, number>();
      for (const m of sent()) {
        if (m.kind === "textEnd") counts.set(m.streamId, (counts.get(m.streamId) ?? 0) + 1);
      }
      for (const [, c] of counts) expect(c).toBe(1);
      expect(counts.size).toBe(3);
    });

    it("a second onFinal immediately after the first does not re-finalize the previous stream_id", () => {
      dispatcher.onPartial("Hello");
      const firstStreamId = dispatcher.currentStreamId();
      dispatcher.onFinal("Hello.");
      // No partial between the two finals — rotation must still occur.
      dispatcher.onFinal("World.");

      const textEnds = sent().filter(
        (m): m is Extract<OutboundMessage, { kind: "textEnd" }> => m.kind === "textEnd",
      );
      // The first text_end is on firstStreamId.
      expect(textEnds[0]!.streamId).toBe(firstStreamId);
      // The second onFinal had no streaming state, so it returns "empty"
      // and emits no text_end. The point of Bug A is that it does NOT
      // double-end firstStreamId.
      expect(textEnds.filter((e) => e.streamId === firstStreamId)).toHaveLength(1);
    });
  });

  describe("Bug B — non-monotonic partial mid-stream (rewrite via reset:true + new stream_id)", () => {
    it("non-monotonic partial closes current stream with reset:true and opens a fresh stream_id", () => {
      dispatcher.onPartial("It's sunny");
      dispatcher.onPartial("It's sunny, 72°F");
      const streamA = dispatcher.currentStreamId();
      dispatcher.onPartial("Sorry let me check");
      const streamB = dispatcher.currentStreamId();
      dispatcher.onFinal("The time is 3:14pm.");

      const textEnds = sent().filter(
        (m): m is Extract<OutboundMessage, { kind: "textEnd" }> => m.kind === "textEnd",
      );
      const resets = textEnds.filter((e) => e.reset === true);
      const finals = textEnds.filter((e) => !e.reset);

      expect(resets).toHaveLength(1);
      expect(resets[0]!.streamId).toBe(streamA);
      expect(finals).toHaveLength(1);
      expect(finals[0]!.streamId).toBe(streamB);
      expect(streamA).not.toBe(streamB);
    });

    it("monotonic-extending partials never trigger a rewrite", () => {
      const streamId = dispatcher.currentStreamId();
      dispatcher.onPartial("Hello");
      dispatcher.onPartial("Hello there");
      dispatcher.onPartial("Hello there, friend");
      dispatcher.onFinal("Hello there, friend.");

      const resets = sent().filter(
        (m) => m.kind === "textEnd" && m.reset === true,
      );
      expect(resets).toHaveLength(0);
      const ids = new Set(
        sent()
          .filter((m) => m.kind === "textDelta" || m.kind === "textEnd")
          .map((m) =>
            m.kind === "textDelta" ? m.streamId : (m as { streamId: string }).streamId,
          ),
      );
      expect(ids).toEqual(new Set([streamId]));
    });

    it("identical-text repeat partial is a no-op (no extra delta, no reset)", () => {
      dispatcher.onPartial("Hi");
      dispatcher.onPartial("Hi");
      dispatcher.onFinal("Hi.");
      const deltas = sent().filter((m) => m.kind === "textDelta");
      expect(deltas).toHaveLength(1);
    });

    it("multiple non-monotonic rewrites each produce their own reset+new stream", () => {
      dispatcher.onPartial("Try one");
      const a = dispatcher.currentStreamId();
      dispatcher.onPartial("Different");
      const b = dispatcher.currentStreamId();
      dispatcher.onPartial("Yet another");
      const c = dispatcher.currentStreamId();
      dispatcher.onFinal("Final answer.");

      const resets = sent().filter(
        (m): m is Extract<OutboundMessage, { kind: "textEnd" }> =>
          m.kind === "textEnd" && m.reset === true,
      );
      expect(resets).toHaveLength(2);
      expect(resets.map((r) => r.streamId)).toEqual([a, b]);
      expect(new Set([a, b, c]).size).toBe(3);
    });
  });

  describe("integration — Bug A + Bug B together (the production failure shape)", () => {
    it("rewrite mid-stream + multi-reply array: 1 reset + 2 normal finals on 3 distinct stream_ids", () => {
      dispatcher.onPartial("Reply one start");
      dispatcher.onPartial("Reply one start, here it is.");
      dispatcher.onFinal("Reply one start, here it is.");

      dispatcher.onPartial("Reply two trying");
      dispatcher.onPartial("Reply two trying again");
      dispatcher.onPartial("Different content");
      dispatcher.onPartial("Different content, finalized.");
      dispatcher.onFinal("Different content, finalized.");

      const textEnds = sent().filter(
        (m): m is Extract<OutboundMessage, { kind: "textEnd" }> => m.kind === "textEnd",
      );
      const resets = textEnds.filter((e) => e.reset === true);
      const finals = textEnds.filter((e) => !e.reset);

      expect(resets).toHaveLength(1);
      expect(finals).toHaveLength(2);
      expect(new Set(textEnds.map((e) => e.streamId)).size).toBe(3);
    });
  });

  describe("onFinal return value", () => {
    it("returns 'streamed' when a stream was active", () => {
      dispatcher.onPartial("hello");
      expect(dispatcher.onFinal("hello.")).toBe("streamed");
    });

    it("returns 'oneshot' when no streaming happened but final text was provided", () => {
      expect(dispatcher.onFinal("a single shot")).toBe("oneshot");
    });

    it("returns 'empty' when no streaming happened and final text was empty", () => {
      expect(dispatcher.onFinal("")).toBe("empty");
      expect(dispatcher.onFinal("   ")).toBe("empty");
    });

    it("rotates state after every onFinal (including empty/oneshot)", () => {
      const before = dispatcher.currentStreamId();
      dispatcher.onFinal("");
      const after = dispatcher.currentStreamId();
      expect(after).not.toBe(before);
    });
  });

  describe("dispose semantics", () => {
    it("dispose drops pending state; subsequent onPartial / onFinal are no-ops", () => {
      dispatcher.onPartial("partial");
      dispatcher.dispose();
      dispatcher.onPartial("more");
      dispatcher.onFinal("done");
      // Anything after dispose() must be a no-op.
      const sentAfterDispose = transport.sent.filter(
        (s) => s.message.kind === "textEnd",
      );
      expect(sentAfterDispose).toHaveLength(0);
    });
  });
});
