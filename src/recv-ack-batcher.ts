/**
 * Flow A (`recv_ack`) batcher.
 *
 * The plugin tells the relay "I have stably persisted the message identified
 * by `seq` to my local durable store" via an outer `recv_ack` frame. Relay
 * uses this to evict messages from the per-recipient queue.
 *
 * Per protocol §6.6.3, we flush whichever fires first:
 *   - 32 newly persisted seqs are pending
 *   - 50 ms since the most recent persistence
 *   - clean shutdown / explicit `flushNow()`
 *
 * `up_to_seq` is the cumulative high-water mark — the highest seq for which
 * EVERY lower seq has also been persisted. Out-of-order arrivals above the
 * watermark are reported as `[low, high]` ranges. Once the gap fills, ranges
 * are folded into the high-water mark.
 */
import type { Chat4000AckStore, AckStoreRole } from "./ack-store.js";
import type { RuntimeLogger } from "./runtime-logger.js";
import type { RelayRecvAckPayload } from "./types.js";

export type RecvAckBatcherOptions = {
  groupId: string;
  role?: AckStoreRole;
  store: Chat4000AckStore;
  /** Sends an outer relay envelope. Must be wired to the live WebSocket. */
  send: (envelope: { version: number; type: string; payload: Record<string, unknown> }) => void;
  runtimeLogger?: RuntimeLogger;
  /** Number of pending persisted seqs that triggers an immediate flush. Default 32. */
  countThreshold?: number;
  /** Idle ms after the most recent record before forcing a flush. Default 50. */
  idleFlushMs?: number;
  /** Hard cap on number of selective ranges in a single recv_ack. Default 32. */
  maxRanges?: number;
};

export class RecvAckBatcher {
  private readonly opts: Required<Omit<RecvAckBatcherOptions, "runtimeLogger">> & {
    runtimeLogger?: RuntimeLogger;
  };

  /** Sorted array of distinct persisted seqs strictly above the persisted watermark. */
  private pendingHighwater = 0;

  private readonly pending: number[] = [];

  /** Count of seqs persisted since the last flush (drives the count threshold). */
  private pendingCount = 0;

  private timer: NodeJS.Timeout | undefined;

  private closed = false;

  constructor(options: RecvAckBatcherOptions) {
    this.opts = {
      role: "plugin",
      countThreshold: 32,
      idleFlushMs: 50,
      maxRanges: 32,
      runtimeLogger: undefined,
      ...options,
    };
    this.pendingHighwater = options.store.getLastAckedSeq(options.groupId, this.opts.role);
  }

  /**
   * Record that `seq` has been durably persisted locally. Schedules a flush.
   * Idempotent: duplicate seqs collapse into a single ack.
   */
  recordPersisted(seq: number): void {
    if (this.closed) return;
    if (!Number.isFinite(seq) || seq <= 0) return;
    if (seq <= this.pendingHighwater) {
      // Already covered by the high-water mark — re-emit cumulative ack so
      // the relay (which may have lost track during a reconnect dance) drops
      // the duplicate from its queue. Idempotent on the relay side.
      this.scheduleFlush();
      return;
    }
    // Insertion sort into the small pending buffer; reject exact duplicates.
    const idx = this.lowerBound(seq);
    if (this.pending[idx] === seq) {
      return;
    }
    this.pending.splice(idx, 0, seq);
    this.pendingCount += 1;

    // Fold any contiguous run starting at watermark+1 into the watermark.
    while (this.pending.length > 0 && this.pending[0] === this.pendingHighwater + 1) {
      this.pendingHighwater = this.pending.shift()!;
    }

    if (this.pendingCount >= this.opts.countThreshold) {
      this.flushNow("count");
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow("idle");
    }, this.opts.idleFlushMs);
  }

  /**
   * Flush immediately. Safe to call when nothing pending — no-ops cleanly.
   * `reason` is for telemetry only.
   */
  flushNow(reason: "count" | "idle" | "shutdown" | "manual" = "manual"): void {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const persistedWatermark = this.opts.store.getLastAckedSeq(
      this.opts.groupId,
      this.opts.role,
    );
    if (
      this.pendingHighwater <= persistedWatermark &&
      this.pending.length === 0 &&
      this.pendingCount === 0
    ) {
      // Nothing new to ack.
      return;
    }
    this.pendingCount = 0;

    // Build optional ranges: collapse `pending` into [low, high] runs.
    const ranges: [number, number][] = [];
    if (this.pending.length > 0) {
      let runStart = this.pending[0]!;
      let runEnd = runStart;
      for (let i = 1; i < this.pending.length; i++) {
        const s = this.pending[i]!;
        if (s === runEnd + 1) {
          runEnd = s;
        } else {
          ranges.push([runStart, runEnd]);
          runStart = s;
          runEnd = s;
        }
      }
      ranges.push([runStart, runEnd]);
    }

    // Bound the ranges array (protocol allows up to 256, we cap at maxRanges).
    const trimmed = ranges.length > this.opts.maxRanges
      ? ranges.slice(0, this.opts.maxRanges)
      : ranges;

    const payload: RelayRecvAckPayload = { up_to_seq: this.pendingHighwater };
    if (trimmed.length > 0) {
      payload.ranges = trimmed;
    }

    // Persist watermark BEFORE emitting the frame so a crash between send-and-fsync
    // never leaves us re-acking a seq we may not have persisted.
    this.opts.store.setLastAckedSeq(
      this.opts.groupId,
      this.pendingHighwater,
      this.opts.role,
    );

    try {
      this.opts.send({
        version: 1,
        type: "recv_ack",
        payload: payload as unknown as Record<string, unknown>,
      });
      this.opts.runtimeLogger?.info("runtime.recv_ack_emit", {
        up_to_seq: this.pendingHighwater,
        range_count: trimmed.length,
        reason,
      });
    } catch (err) {
      this.opts.runtimeLogger?.info("runtime.recv_ack_send_error", {
        up_to_seq: this.pendingHighwater,
        error: String(err),
      });
    }
  }

  /**
   * Flush + stop scheduling. The store is owned by the caller and not closed.
   */
  shutdown(): void {
    this.flushNow("shutdown");
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Test-only inspection of pending state. */
  _stateForTests(): { highwater: number; pending: number[] } {
    return { highwater: this.pendingHighwater, pending: [...this.pending] };
  }

  private lowerBound(seq: number): number {
    let lo = 0;
    let hi = this.pending.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.pending[mid]! < seq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}
