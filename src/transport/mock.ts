/**
 * MockMessageTransport — drives the consumer-side surface (`onReceive`,
 * `onStatus`, `onConnectionState`) in tests without spinning up a relay,
 * encryption, or sockets.
 *
 * Test code drives the inbound side via `simulateReceive(...)` and the
 * sender-status side via `simulateStatus(...)` / `simulateState(...)`. The
 * outbound side is captured into `sent[]` for assertion.
 *
 * Enforces the same invariants documented on the `MessageTransport`
 * interface so test-coverage of consumer code mirrors production behavior:
 *
 *   - `onReceive` fires once per inner `id` (subsequent `simulateReceive`
 *     calls with the same `id` are silently dropped).
 *   - At most one outbound `ack` per `(refs, stage)`.
 *   - At most one outbound `textEnd` per `streamId`.
 */
import { randomUUID } from "node:crypto";
import type {
  ConnectionState,
  GroupConfig,
  InnerMessage,
  MessageTransport,
  OutboundMessage,
  StatusUpdate,
  Unsubscribe,
} from "./index.js";

export type SentMessage = {
  /** Wire id returned to the caller. */
  wireId: string;
  message: OutboundMessage;
};

export class MockMessageTransport implements MessageTransport {
  /** Every successfully-sent outbound message, in send order. */
  readonly sent: SentMessage[] = [];

  /** Latest config passed to `connect`, or undefined if never called. */
  lastConfig: GroupConfig | undefined;

  private receiveHandlers = new Set<(msg: InnerMessage) => void>();

  private statusHandlers = new Set<(update: StatusUpdate) => void>();

  private stateHandlers = new Set<(state: ConnectionState) => void>();

  private connectionState: ConnectionState = "disconnected";

  private disposed = false;

  private readonly innerIdsSeen = new Set<string>();

  private readonly acksEmitted = new Set<string>();

  private readonly streamEndedWireId = new Map<string, string>();

  send(msg: OutboundMessage): string {
    if (this.disposed) {
      throw new Error("MockMessageTransport: send() after disconnect()");
    }

    if (msg.kind === "ack") {
      const key = `${msg.refs}::${msg.stage}`;
      const existing = this.findExistingAck(msg.refs, msg.stage);
      if (existing) {
        return existing;
      }
      const wireId = randomUUID();
      this.acksEmitted.add(key);
      this.sent.push({ wireId, message: msg });
      return wireId;
    }

    if (msg.kind === "textEnd") {
      const cached = this.streamEndedWireId.get(msg.streamId);
      if (cached) {
        return cached;
      }
      // Fresh per-frame wire id per protocol §6.4.2; streamId travels in
      // body.stream_id when this is shipped over a real transport.
      const wireId = randomUUID();
      this.streamEndedWireId.set(msg.streamId, wireId);
      this.sent.push({ wireId, message: msg });
      return wireId;
    }

    if (msg.kind === "textDelta") {
      const wireId = randomUUID();
      this.sent.push({ wireId, message: msg });
      return wireId;
    }

    const wireId = randomUUID();
    this.sent.push({ wireId, message: msg });
    return wireId;
  }

  onReceive(handler: (msg: InnerMessage) => void): Unsubscribe {
    this.receiveHandlers.add(handler);
    return () => {
      this.receiveHandlers.delete(handler);
    };
  }

  onStatus(handler: (update: StatusUpdate) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onConnectionState(handler: (state: ConnectionState) => void): Unsubscribe {
    this.stateHandlers.add(handler);
    handler(this.connectionState);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  connect(config: GroupConfig): void {
    this.lastConfig = config;
    this.simulateState("connecting");
    this.simulateState("connected");
  }

  disconnect(): void {
    this.simulateState("disconnected");
    this.disposed = true;
  }

  // ─── Test driver API ─────────────────────────────────────────────────────

  /**
   * Deliver an inbound inner message to all `onReceive` subscribers. Enforces
   * the inner.id dedup invariant — a second call with the same `id` is a
   * no-op (mirroring the relay-side dedup the real transport runs).
   */
  simulateReceive(msg: InnerMessage): void {
    if (this.innerIdsSeen.has(msg.id)) {
      return;
    }
    this.innerIdsSeen.add(msg.id);
    for (const h of this.receiveHandlers) h(msg);
  }

  /**
   * Bypass dedup and force-deliver — useful for tests asserting that
   * consumers tolerate double-delivery.
   */
  simulateReceiveUnchecked(msg: InnerMessage): void {
    for (const h of this.receiveHandlers) h(msg);
  }

  simulateStatus(update: StatusUpdate): void {
    for (const h of this.statusHandlers) h(update);
  }

  simulateState(state: ConnectionState): void {
    this.connectionState = state;
    for (const h of this.stateHandlers) h(state);
  }

  /** Drop captured outbound history (for tests that re-use one transport). */
  reset(): void {
    this.sent.length = 0;
    this.innerIdsSeen.clear();
    this.acksEmitted.clear();
    this.streamEndedWireId.clear();
  }

  private findExistingAck(refs: string, stage: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const entry = this.sent[i]!;
      if (
        entry.message.kind === "ack" &&
        entry.message.refs === refs &&
        entry.message.stage === stage
      ) {
        return entry.wireId;
      }
    }
    return undefined;
  }

}
