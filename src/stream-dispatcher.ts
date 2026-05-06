/**
 * StreamDispatcher — translates the OpenClaw reply pipeline's `onPartialReply`
 * + `deliver(final)` callback shape into protocol-correct `text_delta` /
 * `text_end` frames on a `MessageTransport`.
 *
 * This is the part of `channel.ts` that carries all the §6.4.2 invariants:
 *
 *   - A `stream_id` is append-only. Once `text_end` is sent for a stream_id,
 *     no further `text_delta` may go on that stream_id.
 *   - To rewrite mid-stream (the agent backtracks): close the current
 *     stream_id with `text_end{reset:true}` and mint a fresh stream_id.
 *   - Each agent reply payload (one element of OpenClaw's `replies` array)
 *     gets its own stream_id. After `onFinal`, the next stream rotates
 *     automatically — so a second `onFinal` does not double-`text_end` the
 *     previous stream.
 *
 * The dispatcher buffers small partial deltas and flushes them in batches
 * (200 chars or 100 ms idle) to keep the wire from getting hammered with
 * one-token frames. `flush()` and `dispose()` drain pending state cleanly.
 *
 * Production bugs this layer pins down:
 *
 *   - **Bug A** (2026-05-05): two `deliver(final)` calls on the same agent
 *     run produced two `text_end` frames on a single stream_id. Pinned by
 *     `onFinal()` rotating state at the end of every call.
 *   - **Bug B** (2026-05-05): a non-monotonic partial mid-stream caused a
 *     fresh `text_delta` with backwards content. Pinned by detecting
 *     non-monotonic input and emitting `text_end{reset:true}` before
 *     opening a new stream_id.
 */
import { randomUUID } from "node:crypto";
import type { MessageTransport } from "./transport/index.js";

/** Flush buffered deltas once we've accumulated this many chars. */
const STREAM_FLUSH_MIN_CHARS = 200;

/** Flush buffered deltas this many ms after the last partial. */
const STREAM_FLUSH_DELAY_MS = 100;

export type StreamDispatcherOptions = {
  transport: MessageTransport;
  /** Hook for runtime-log "stream_reset" events. Optional. */
  onStreamReset?: (info: { streamId: string; abandonedChars: number }) => void;
  /** Override flush thresholds (test-only). */
  flushMinChars?: number;
  flushDelayMs?: number;
};

/**
 * One dispatcher per **agent run** (i.e. per inbound user prompt). Holds the
 * currently-active stream's state. Reusable across multiple `replies` array
 * elements within that run — `onFinal` rotates state, so the next `onPartial`
 * starts a fresh stream_id.
 */
export class StreamDispatcher {
  private streamId = randomUUID();

  private streamActive = false;

  private lastText = "";

  /** Most recent `onPartialReply` text. Used to detect monotonic-extending
   *  vs rewrite-mid-stream input. Cleared on every stream rotation. */
  private lastPartialText = "";

  private buffer = "";

  private firstChunkSent = false;

  private flushTimer: NodeJS.Timeout | undefined;

  private disposed = false;

  private readonly transport: MessageTransport;

  private readonly onStreamReset?: StreamDispatcherOptions["onStreamReset"];

  private readonly flushMinChars: number;

  private readonly flushDelayMs: number;

  constructor(opts: StreamDispatcherOptions) {
    this.transport = opts.transport;
    this.onStreamReset = opts.onStreamReset;
    this.flushMinChars = opts.flushMinChars ?? STREAM_FLUSH_MIN_CHARS;
    this.flushDelayMs = opts.flushDelayMs ?? STREAM_FLUSH_DELAY_MS;
  }

  /** The currently-active stream_id. Surfaced for diagnostics + tests. */
  currentStreamId(): string {
    return this.streamId;
  }

  /** True if at least one delta has been emitted on the current stream. */
  isActive(): boolean {
    return this.streamActive;
  }

  /**
   * Forward a partial reply from the agent. Implements:
   *   - first chunk → emit immediately (no buffering on the leading edge)
   *   - exact repeat → no-op
   *   - prefix-extending → emit only the appended slice
   *   - non-monotonic (the agent backtracked) → close current stream with
   *     reset:true, mint a fresh stream_id, replay the new text on it
   */
  onPartial(text: string): void {
    if (this.disposed || !text) {
      return;
    }
    if (!this.lastPartialText) {
      this.lastPartialText = text;
      this.queueDelta(text);
      return;
    }
    if (text === this.lastPartialText) {
      return;
    }
    if (text.startsWith(this.lastPartialText)) {
      const delta = text.slice(this.lastPartialText.length);
      this.lastPartialText = text;
      this.queueDelta(delta);
      return;
    }
    this.lastPartialText = text;
    this.resetForRewrite(text);
  }

  /**
   * Forward a `deliver(kind:"final")` payload. Emits a normal `text_end` for
   * the active stream (if any), then rotates state so the next `onPartial`
   * starts a fresh stream_id.
   *
   * Returns `"streamed"` if a `text_end` was emitted on the active stream,
   * `"empty"` if there was no active stream and `text` was empty (caller
   * should treat as "agent produced nothing"), `"oneshot"` if `text` was
   * present but no streaming had happened (caller should send the full
   * text as a single `text` message instead).
   */
  onFinal(text: string): "streamed" | "oneshot" | "empty" {
    if (this.disposed) {
      return "empty";
    }
    if (this.streamActive) {
      this.flushBuffer();
      const finalText = text || this.lastText;
      if (finalText.length > 0) {
        this.transport.send({
          kind: "textEnd",
          streamId: this.streamId,
          text: finalText,
        });
      }
      this.rotate();
      return "streamed";
    }
    if (!text.trim()) {
      this.rotate();
      return "empty";
    }
    this.rotate();
    return "oneshot";
  }

  /**
   * Drain any pending buffered delta. Caller invokes between
   * `onPartial`/`onFinal` only when explicitly needed (the buffer flushes
   * itself on count + idle thresholds).
   */
  flush(): void {
    if (this.disposed) return;
    this.flushBuffer();
  }

  /**
   * Stop scheduling flushes. Pending buffer is dropped; an in-flight
   * `text_end` is the caller's responsibility (call `onFinal` first).
   * Idempotent.
   */
  dispose(): void {
    this.disposed = true;
    this.clearFlushTimer();
    this.buffer = "";
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private queueDelta(delta: string): void {
    if (!delta) return;
    if (!this.firstChunkSent) {
      this.firstChunkSent = true;
      this.streamActive = true;
      this.lastText += delta;
      this.transport.send({
        kind: "textDelta",
        streamId: this.streamId,
        delta,
      });
      return;
    }
    this.buffer += delta;
    if (this.buffer.length >= this.flushMinChars) {
      this.flushBuffer();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushBuffer();
      }, this.flushDelayMs);
    }
  }

  private flushBuffer(): void {
    this.clearFlushTimer();
    if (!this.buffer) {
      return;
    }
    const delta = this.buffer;
    this.buffer = "";
    this.streamActive = true;
    this.lastText += delta;
    this.transport.send({
      kind: "textDelta",
      streamId: this.streamId,
      delta,
    });
  }

  /**
   * Per protocol §6.4.2: a stream_id is append-only. To abandon a partial
   * stream and continue with different text, end the old one with
   * `reset:true` (so the iPhone deletes that bubble) and mint a fresh
   * stream_id for the continuation.
   */
  private resetForRewrite(nextText: string): void {
    this.clearFlushTimer();
    this.buffer = "";
    if (this.streamActive && this.lastText.length > 0) {
      const abandonedStreamId = this.streamId;
      const abandonedChars = this.lastText.length;
      this.transport.send({
        kind: "textEnd",
        streamId: abandonedStreamId,
        text: this.lastText,
        reset: true,
      });
      this.onStreamReset?.({ streamId: abandonedStreamId, abandonedChars });
    }
    this.streamId = randomUUID();
    this.streamActive = false;
    this.lastText = "";
    this.firstChunkSent = false;
    if (nextText) {
      this.queueDelta(nextText);
    }
  }

  /**
   * Rotate state so the NEXT deliver(final) — fired once per element of the
   * agent's `replies` array (see openclaw `dispatch-from-config.ts:1499–1525`)
   * — starts on a fresh stream_id with its own `text_end`. Without this,
   * multiple replies in the array would all collide on the same stream_id
   * and emit multiple `text_end` frames against it (Bug A).
   */
  private rotate(): void {
    this.clearFlushTimer();
    this.streamId = randomUUID();
    this.streamActive = false;
    this.lastText = "";
    this.lastPartialText = "";
    this.buffer = "";
    this.firstChunkSent = false;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}
