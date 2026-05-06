/**
 * `MessageTransport` — the chat4000 plugin's wire-protocol facade.
 *
 * Everything that touches the relay (WebSocket lifecycle, encryption, the
 * §6.6 ack flow, sequence numbers, redrive dedup, app-layer ping/pong,
 * reconnect with backoff) lives behind this interface. Consumers (agent
 * runner, channel.ts) call only `send`, observe `onReceive` /
 * `onStatus` / `onConnectionState`, and never see `seq`, never call
 * `recv_ack`, never open a socket.
 *
 * Scope:
 *   - This interface assumes the group is already paired and a stable
 *     32-byte group key is available. **Pairing is not part of this
 *     transport.** It runs before any group key exists, uses a different
 *     relay frame family (pair_open / pair_data / pair_complete) that
 *     never carries `msg`, and dies the moment the room is closed. Pairing
 *     stays in `src/pairing.ts` as `joinPairingSession()` /
 *     `hostPairingSession()`. Construct a `MessageTransport` only after
 *     pairing has produced a group key.
 *
 *   - This interface assumes a single account / single group at a time.
 *     Multi-account hosts construct one transport per account.
 *
 * Invariants the default impl enforces (so consumers don't have to):
 *   - `onReceive` fires once per inner `msg_id`, in send order, after
 *     decrypt + dedup. A relay redrive of an already-processed inner.id
 *     is silently swallowed (and its outer `seq` is still ack'd so the
 *     relay queue evicts).
 *   - At most one outbound inner `ack` per `(refs, stage)`. A second call
 *     to `send({kind:'ack', refs:X, stage:'received'})` for the same `X`
 *     is a no-op.
 *   - At most one outbound `textEnd` per `streamId`. A second call to
 *     `send({kind:'textEnd', streamId:X, ...})` for the same `X` is a
 *     no-op (and emits a runtime warning in non-production builds, since
 *     it's a consumer bug).
 *   - Each outbound `textDelta` / `textEnd` frame gets a **fresh** wire-level
 *     `inner.id` (UUID v4) per protocol §6.4.2. The consumer-supplied
 *     `streamId` lives in `body.stream_id` on the wire, NOT in `inner.id`.
 *     Consumers must not assume `send` returns the `streamId`; for streaming
 *     frames it returns the fresh per-frame wire id.
 *   - `notify_if_offline` is set on `text`, `image`, `audio`, and final
 *     (non-`reset`) `textEnd` frames; never on `textDelta` / `status` /
 *     `ack` / `reset:true`-`textEnd` / pairing.
 *   - The transport never exposes `seq` or the outer envelope to consumers.
 */
import type { Buffer } from "node:buffer";

// ─── Outbound (consumer → transport) ────────────────────────────────────────

export type OutboundMessage =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      data: Buffer;
      mimeType: string;
    }
  | {
      kind: "audio";
      data: Buffer;
      mimeType: string;
      durationMs: number;
      waveform: number[];
    }
  | {
      kind: "textDelta";
      streamId: string;
      delta: string;
    }
  | {
      kind: "textEnd";
      streamId: string;
      text: string;
      /**
       * Per protocol §6.4.2: when true, the receiver should delete the
       * bubble for this stream_id. Use this when the agent abandons a
       * partial reply and starts a new stream_id. `notify_if_offline` is
       * automatically suppressed on `reset: true` frames.
       */
      reset?: boolean;
    }
  | {
      kind: "status";
      status: "thinking" | "typing" | "idle";
    }
  | {
      kind: "ack";
      refs: string;
      stage: "received" | "processing" | "displayed";
    };

// ─── Inbound (transport → consumer) ─────────────────────────────────────────
// Mirrors the shape of the inner JSON SQLite-store-and-deliver-once envelope.
// The transport has already decrypted, parsed, and dedup'd by the time the
// consumer's `onReceive` fires.

export type InnerMessageFrom = {
  role: "app" | "plugin";
  deviceId?: string;
  deviceName?: string;
  appVersion?: string;
  bundleId?: string;
};

export type InnerTextBody = { kind: "text"; text: string };
export type InnerImageBody = {
  kind: "image";
  dataBase64: string;
  mimeType: string;
};
export type InnerAudioBody = {
  kind: "audio";
  dataBase64: string;
  mimeType: string;
  durationMs: number;
  waveform: number[];
};
export type InnerTextDeltaBody = {
  kind: "textDelta";
  delta: string;
  /**
   * Per protocol §6.4.2 (post-2026-05-06): stream correlator lives in the body.
   * Older senders that still reuse `inner.id == stream_id` will not set this;
   * consumers should fall back to the parent `InnerMessage.id` when missing.
   */
  streamId?: string;
};
export type InnerTextEndBody = {
  kind: "textEnd";
  text: string;
  reset?: boolean;
  streamId?: string;
};
export type InnerStatusBody = {
  kind: "status";
  status: "thinking" | "typing" | "idle";
};
export type InnerAckBody = {
  kind: "ack";
  refs: string;
  stage: "received" | "processing" | "displayed";
};
export type InnerUnknownBody = { kind: "unknown"; rawType: string };

export type InnerMessageBody =
  | InnerTextBody
  | InnerImageBody
  | InnerAudioBody
  | InnerTextDeltaBody
  | InnerTextEndBody
  | InnerStatusBody
  | InnerAckBody
  | InnerUnknownBody;

export type InnerMessage = {
  /** The inner `msg_id` per protocol §6.6.9 — canonical app-layer dedup key. */
  id: string;
  /** Sender metadata; absent on legacy peers. */
  from?: InnerMessageFrom;
  /** Discriminated by `body.kind`. */
  body: InnerMessageBody;
  /** Sender's wall-clock timestamp (ms since epoch). */
  ts: number;
};

// ─── Transport-layer status (NOT delivery / Flow B) ─────────────────────────
// Per protocol §6.6.7: `sent` (✓) is driven by `relay_recv_ack`; `delivered`
// (✓✓) is driven by an inner `ack` from the peer. The transport surfaces
// `sent` here. `delivered` is an application-layer concern: the consumer
// observes inner `ack` frames in `onReceive` and decides what to do.

export type StatusUpdate = {
  /** The wire id returned from a prior `send()` call. */
  msgId: string;
  status: "sent" | "failed";
  /** Optional human-readable reason on `failed`. */
  reason?: string;
};

// ─── Connection state ───────────────────────────────────────────────────────

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | { kind: "failed"; reason: string };

// ─── Configuration ──────────────────────────────────────────────────────────

export type GroupConfig = {
  /** Account id used for log fields, durable state path, runtime logger. */
  accountId: string;
  /** SHA-256 hex of `groupKeyBytes`; used for relay routing. */
  groupId: string;
  /** Raw 32-byte group key for XChaCha20-Poly1305 inner encryption. */
  groupKeyBytes: Buffer;
  /** Override of the default `wss://relay.chat4000.com/ws`. */
  relayUrl?: string;
  /** Plugin's release channel surfaced in `hello.release_channel`. */
  releaseChannel?: string;
  /** Optional log level for the underlying runtime logger. */
  runtimeLogLevel?: "info" | "debug";
};

// ─── The interface itself ───────────────────────────────────────────────────

/**
 * Subscription handle — call to unsubscribe.
 */
export type Unsubscribe = () => void;

export interface MessageTransport {
  /**
   * Fire-and-forget. Returns the wire `id` (the inner `msg_id`)
   * synchronously so the consumer can correlate later `StatusUpdate`s.
   *
   * For `kind: "ack"`, returns the wire id of the ack inner message
   * (which is its own `id`, not `refs`). The transport silently
   * deduplicates: a second call for the same `(refs, stage)` returns
   * the original wire id and emits nothing on the wire.
   *
   * For `kind: "textDelta"` and `kind: "textEnd"`: returns a fresh per-frame
   * wire id (UUID v4). The consumer-supplied `streamId` is propagated in
   * `body.stream_id` per §6.4.2 — it is **not** the wire id. A second
   * `textEnd` for the same `streamId` is a no-op and returns the wire id
   * of the original frame.
   *
   * Network failure surfaces async via `onStatus({status: "failed"})`.
   * Disposed/never-connected sends are not thrown — they emit a `failed`
   * status asynchronously and return a synthetic wire id.
   */
  send(msg: OutboundMessage): string;

  /**
   * Subscribe to inbound inner messages. Fires once per inner `msg_id`,
   * in arrival order, after decrypt + dedup.
   *
   * Inner `ack` frames from peers (apps) flow through here unchanged —
   * the transport does NOT interpret them; consumer is responsible for
   * matching `refs` to its outbound state if it cares.
   */
  onReceive(handler: (msg: InnerMessage) => void): Unsubscribe;

  /**
   * Outbound transport-level status updates: `sent` when the relay
   * acknowledges (`relay_recv_ack`), `failed` on a local error or
   * timeout. **Never emits `delivered`** — that's Flow B / inner ack
   * territory and is the consumer's job to interpret from `onReceive`.
   */
  onStatus(handler: (update: StatusUpdate) => void): Unsubscribe;

  onConnectionState(handler: (state: ConnectionState) => void): Unsubscribe;

  /**
   * Open the WebSocket and start the keepalive + reconnect loop. Idempotent:
   * a second `connect` call while already connected is a no-op.
   */
  connect(config: GroupConfig): void;

  /**
   * Cleanly close. Flushes any pending `recv_ack` durably before tearing
   * down the socket. Future `send` calls throw.
   */
  disconnect(): void;
}
