/**
 * RelayMessageTransport — the default `MessageTransport` implementation.
 *
 * Owns:
 *   - WebSocket lifecycle (`wss://relay.chat4000.com/ws`)
 *   - hello / hello_ok with `last_acked_seq` reconnect replay (§6.6.8)
 *   - XChaCha20-Poly1305 encryption / decryption with the group key
 *   - outer envelope construction + parsing
 *   - Flow A inbound: parse `seq`, dedupe by inner.id (§6.6.9), debounce
 *     cumulative `recv_ack` (§6.6.3), durable watermark
 *   - Flow A outbound: track outbound msg_ids, surface `relay_recv_ack`
 *     as a `sent` `StatusUpdate`
 *   - 25 s app-layer ping / 15 s pong-timeout reconnect (§6.5)
 *   - reconnect with exponential backoff + jitter
 *   - outbound `ack` dedup by `(refs, stage)` (idempotency table survives
 *     restart)
 *   - outbound `textEnd` dedup by `streamId`
 *
 * Hides:
 *   - the entire wire vocabulary (`msg`, `recv_ack`, `relay_recv_ack`,
 *     `ping`, `pong`, `hello`, `hello_ok`)
 *   - `seq` numbers
 *   - encryption / nonce handling
 *   - reconnect bookkeeping
 *
 * Pairing is OUT of scope. A `RelayMessageTransport` is constructed only
 * after pairing has produced a stable group key. Pairing uses a different
 * relay frame family (`pair_*`) and a different connection lifecycle, and
 * lives in `src/pairing.ts`.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { decrypt, encrypt } from "../crypto.js";
import { dumpChat4000Trace } from "../error-log.js";
import { resolveChat4000InstanceIdentity } from "../key-store.js";
import { readPackageVersion } from "../package-info.js";
import { runWithReconnect } from "../reconnect.js";
import { RuntimeLogger } from "../runtime-logger.js";
import { attachWebSocketKeepalive } from "../ws-keepalive.js";
import { openAckStore, type Chat4000AckStore } from "../ack-store.js";
import { RecvAckBatcher } from "../recv-ack-batcher.js";
import type {
  ConnectionState,
  GroupConfig,
  InnerMessage,
  InnerMessageBody,
  InnerMessageFrom,
  MessageTransport,
  OutboundMessage,
  StatusUpdate,
  Unsubscribe,
} from "./index.js";
import type {
  InnerMessage as WireInnerMessage,
  InnerMessageType,
  RelayEnvelope,
  RelayHelloOkPayload,
  RelayHelloPayload,
  RelayMsgPayload,
  RelayRecvSenderAckPayload,
} from "../types.js";

const DEFAULT_RELAY_URL = "wss://relay.chat4000.com/ws";
const APP_PING_INTERVAL_MS = 25_000;
const APP_PONG_TIMEOUT_MS = 15_000;

const PLUGIN_BUNDLE_ID = "@chat4000/openclaw-plugin";

export type RelayMessageTransportOptions = {
  /** Override the singleton ack store. Test-only. */
  ackStore?: Chat4000AckStore;
  /** Hook to override how the abort signal terminates the run loop. */
  abortSignal?: AbortSignal;
};

export class RelayMessageTransport implements MessageTransport {
  private readonly receiveHandlers = new Set<(msg: InnerMessage) => void>();

  private readonly statusHandlers = new Set<(update: StatusUpdate) => void>();

  private readonly stateHandlers = new Set<(state: ConnectionState) => void>();

  private connectionState: ConnectionState = "disconnected";

  /** Outbound dedup: `(refs, stage)` → wire id of the first ack we sent. */
  private readonly ackDedup = new Map<string, string>();

  /** Outbound dedup: `streamId` → fresh wire id we used to close that stream. */
  private readonly streamEndedWireId = new Map<string, string>();

  private config: GroupConfig | undefined;

  private store: Chat4000AckStore | undefined;

  private from: InnerMessageFrom | undefined;

  private currentSend: ((envelope: RelayEnvelope) => void) | undefined;

  private currentBatcher: RecvAckBatcher | undefined;

  private runtimeLogger: RuntimeLogger | undefined;

  private abortController: AbortController | undefined;

  private runLoop: Promise<void> | undefined;

  private disposed = false;

  private storeOverride: Chat4000AckStore | undefined;

  private externalAbort: AbortSignal | undefined;

  constructor(opts?: RelayMessageTransportOptions) {
    this.storeOverride = opts?.ackStore;
    this.externalAbort = opts?.abortSignal;
  }

  /**
   * Test-only seam: bypass the WebSocket lifecycle so wire-format tests
   * can capture the exact outbound `RelayEnvelope` without spinning up a
   * relay or a `WebSocket`. After calling, `send(...)` will encrypt and
   * forward the envelope to `capture` synchronously.
   *
   * Not part of the `MessageTransport` contract — any consumer that touches
   * this method outside of tests is doing it wrong.
   */
  _attachForTests(params: {
    config: GroupConfig;
    store: Chat4000AckStore;
    capture: (env: RelayEnvelope) => void;
  }): void {
    this.config = params.config;
    this.store = params.store;
    this.runtimeLogger = new RuntimeLogger(params.config.runtimeLogLevel ?? "info", {
      accountId: params.config.accountId,
      groupId: params.config.groupId,
    });
    this.currentSend = (env) => params.capture(env);
    this.connectionState = "connected";
  }

  // ─── MessageTransport surface ────────────────────────────────────────────

  send(msg: OutboundMessage): string {
    if (this.disposed || !this.config) {
      // Disposed/never-connected sends are a no-op rather than a throw.
      // A consumer mid-reply can race with a config-reload that tears the
      // transport down underneath it; throwing here would crash the agent
      // reply pipeline. Surface as a failed status instead.
      const wireId = randomUUID();
      const reason = this.disposed ? "disposed" : "not_connected";
      queueMicrotask(() => {
        this.emitStatus({ msgId: wireId, status: "failed", reason });
      });
      this.runtimeLogger?.info("runtime.send_dropped", {
        msg_id: wireId,
        reason,
      });
      return wireId;
    }

    if (msg.kind === "ack") {
      const key = `${msg.refs}::${msg.stage}`;
      const cached = this.ackDedup.get(key);
      if (cached) {
        return cached;
      }
      const persisted = this.store?.markInnerAckEmitted({
        groupId: this.config.groupId,
        refs: msg.refs,
        stage: msg.stage,
      });
      if (persisted && !persisted.isNew) {
        // Already emitted in a previous process. Suppress the wire frame but
        // give the caller a stable id.
        const wireId = randomUUID();
        this.ackDedup.set(key, wireId);
        return wireId;
      }
      const wireId = this.shipInnerMessage("ack", { refs: msg.refs, stage: msg.stage });
      this.ackDedup.set(key, wireId);
      this.runtimeLogger?.info("runtime.inner_ack_emit", {
        type: "ack",
        msg_id: wireId,
        refs: msg.refs,
        stage: msg.stage,
      });
      return wireId;
    }

    if (msg.kind === "textEnd") {
      const cached = this.streamEndedWireId.get(msg.streamId);
      if (cached) {
        return cached;
      }
      // Per protocol §6.4.2: the wire-level inner.id MUST be a fresh UUID v4
      // per frame. The stream correlator lives in body.stream_id. Reusing
      // inner.id across frames trips §6.6.9 dedup on the receiver and only
      // the first frame renders. (Production bug 2026-05-06.)
      const body: Record<string, unknown> = {
        text: msg.text,
        stream_id: msg.streamId,
      };
      if (msg.reset) body.reset = true;
      const wireId = this.shipInnerMessage("text_end", body, undefined, {
        notifyIfOffline: !msg.reset,
      });
      this.streamEndedWireId.set(msg.streamId, wireId);
      return wireId;
    }

    if (msg.kind === "textDelta") {
      // Fresh inner.id per frame; stream_id rides in body. See §6.4.2.
      return this.shipInnerMessage(
        "text_delta",
        { delta: msg.delta, stream_id: msg.streamId },
        undefined,
      );
    }

    if (msg.kind === "status") {
      const wireId = this.shipInnerMessage("status", { status: msg.status });
      this.runtimeLogger?.info("runtime.send", {
        type: "status",
        msg_id: wireId,
        status: msg.status,
      });
      return wireId;
    }

    if (msg.kind === "text") {
      return this.shipInnerMessage(
        "text",
        { text: msg.text },
        undefined,
        { notifyIfOffline: true },
      );
    }

    if (msg.kind === "image") {
      return this.shipInnerMessage(
        "image",
        {
          data_base64: msg.data.toString("base64"),
          mime_type: msg.mimeType,
        },
        undefined,
        { notifyIfOffline: true },
      );
    }

    if (msg.kind === "audio") {
      return this.shipInnerMessage(
        "audio",
        {
          data_base64: msg.data.toString("base64"),
          mime_type: msg.mimeType,
          duration_ms: msg.durationMs,
          waveform: msg.waveform,
        },
        undefined,
        { notifyIfOffline: true },
      );
    }

    // Exhaustiveness — TypeScript will surface a never-mismatch if a new
    // OutboundMessage variant is added without handling.
    const _exhaust: never = msg;
    void _exhaust;
    throw new Error("RelayMessageTransport: unsupported OutboundMessage");
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
    if (this.disposed) {
      throw new Error("RelayMessageTransport: connect() after disconnect()");
    }
    if (this.config) {
      // Idempotent — already connected/connecting.
      return;
    }
    this.config = config;
    this.runtimeLogger = new RuntimeLogger(config.runtimeLogLevel ?? "info", {
      accountId: config.accountId,
      groupId: config.groupId,
    });
    this.store = this.storeOverride ?? openAckStore(config.accountId);
    this.abortController = new AbortController();
    if (this.externalAbort) {
      if (this.externalAbort.aborted) {
        this.abortController.abort();
      } else {
        this.externalAbort.addEventListener(
          "abort",
          () => this.abortController?.abort(),
          { once: true },
        );
      }
    }
    this.runLoop = this.startRunLoop();
  }

  disconnect(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.currentBatcher?.shutdown();
    this.currentBatcher = undefined;
    this.abortController?.abort();
    this.setState("disconnected");
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private resolveFrom(): InnerMessageFrom {
    if (!this.from) {
      const instance = resolveChat4000InstanceIdentity();
      this.from = {
        role: "plugin",
        deviceId: instance.deviceId,
        deviceName: instance.deviceName,
        appVersion: readPackageVersion(),
        bundleId: PLUGIN_BUNDLE_ID,
      };
    }
    return this.from;
  }

  /**
   * Build an inner JSON envelope, encrypt it, and ship the outer
   * `msg`-typed RelayEnvelope on the active socket. Returns the wire id.
   */
  private shipInnerMessage(
    t: InnerMessageType,
    body: Record<string, unknown>,
    messageId?: string,
    opts?: { notifyIfOffline?: boolean },
  ): string {
    if (!this.config || !this.store) {
      throw new Error("RelayMessageTransport: not connected");
    }
    const wireId = messageId ?? randomUUID();
    const from = this.resolveFrom();
    const inner: WireInnerMessage = {
      t,
      id: wireId,
      from: {
        role: from.role,
        device_id: from.deviceId,
        device_name: from.deviceName,
        app_version: from.appVersion,
        bundle_id: from.bundleId,
      },
      body,
      ts: Date.now(),
    };

    const plaintext = Buffer.from(JSON.stringify(inner), "utf-8");
    const { nonce, ciphertext } = encrypt(plaintext, this.config.groupKeyBytes);

    const payload: Record<string, unknown> = {
      msg_id: wireId,
      nonce,
      ciphertext,
    };
    if (opts?.notifyIfOffline) {
      payload.notify_if_offline = true;
    }

    const envelope: RelayEnvelope = {
      version: 1,
      type: "msg",
      payload,
    };

    const send = this.currentSend;
    if (!send) {
      // Not connected. Surface as a `failed` status; caller already has the id.
      queueMicrotask(() => {
        this.emitStatus({
          msgId: wireId,
          status: "failed",
          reason: "not connected",
        });
      });
      this.runtimeLogger?.info("runtime.send_dropped", {
        msg_id: wireId,
        inner_t: t,
        reason: "not_connected",
      });
      return wireId;
    }
    try {
      send(envelope);
    } catch (err) {
      queueMicrotask(() => {
        this.emitStatus({
          msgId: wireId,
          status: "failed",
          reason: String(err),
        });
      });
    }
    this.runtimeLogger?.info("runtime.send", {
      type: "msg",
      msg_id: wireId,
      inner_t: t,
    });
    return wireId;
  }

  private async startRunLoop(): Promise<void> {
    if (!this.config || !this.abortController || !this.store) return;
    const config = this.config;
    const store = this.store;

    const buildConnectFn = () => async (): Promise<void> => {
      const lastAckedSeq = store.getLastAckedSeq(config.groupId, "plugin");
      this.setState("connecting");
      await this.runOneConnection({
        relayUrl: config.relayUrl ?? DEFAULT_RELAY_URL,
        groupId: config.groupId,
        groupKeyBytes: config.groupKeyBytes,
        releaseChannel: config.releaseChannel ?? "production",
        lastAckedSeq,
        store,
      });
    };

    await runWithReconnect(buildConnectFn(), {
      abortSignal: this.abortController.signal,
      onError: (err) => {
        dumpChat4000Trace("relay-transport", err, {
          accountId: config.accountId,
        });
        this.runtimeLogger?.info("runtime.relay_error", {
          error: String(err),
        });
        this.setState("reconnecting");
      },
      onReconnect: (delayMs) => {
        this.runtimeLogger?.info("runtime.reconnect", {
          delay_ms: Math.round(delayMs),
        });
      },
    });
  }

  private runOneConnection(params: {
    relayUrl: string;
    groupId: string;
    groupKeyBytes: Buffer;
    releaseChannel: string;
    lastAckedSeq: number;
    store: Chat4000AckStore;
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(params.relayUrl);
      const stopWsKeepalive = attachWebSocketKeepalive(ws);
      let opened = false;
      let lastSendAt = Date.now();
      let appPingTimer: NodeJS.Timeout | undefined;
      let appPongTimer: NodeJS.Timeout | undefined;

      const send = (envelope: RelayEnvelope) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(envelope));
          lastSendAt = Date.now();
        }
      };

      const stopAppKeepalive = () => {
        if (appPingTimer) {
          clearInterval(appPingTimer);
          appPingTimer = undefined;
        }
        if (appPongTimer) {
          clearTimeout(appPongTimer);
          appPongTimer = undefined;
        }
      };

      const startAppKeepalive = () => {
        appPingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const idleMs = Date.now() - lastSendAt;
          if (idleMs < APP_PING_INTERVAL_MS - 1000) return;
          try {
            ws.send(JSON.stringify({ version: 1, type: "ping", payload: null }));
            lastSendAt = Date.now();
          } catch {
            return;
          }
          if (appPongTimer) clearTimeout(appPongTimer);
          appPongTimer = setTimeout(() => {
            try {
              ws.close();
            } catch {
              // already closing
            }
          }, APP_PONG_TIMEOUT_MS);
        }, APP_PING_INTERVAL_MS);
      };

      ws.on("open", () => {
        const helloPayload: RelayHelloPayload = {
          role: "plugin",
          group_id: params.groupId,
          device_token: null,
          app_version: readPackageVersion(),
          release_channel: params.releaseChannel,
        };
        if (params.lastAckedSeq > 0) {
          helloPayload.last_acked_seq = params.lastAckedSeq;
        }
        const hello: RelayEnvelope = {
          version: 1,
          type: "hello",
          payload: helloPayload satisfies RelayHelloPayload as unknown as Record<string, unknown>,
        };
        ws.send(JSON.stringify(hello));
        lastSendAt = Date.now();
        this.runtimeLogger?.info("runtime.hello_sent", {
          last_acked_seq: params.lastAckedSeq,
        });
      });

      ws.on("message", async (data) => {
        const raw = typeof data === "string" ? data : data.toString();
        if (!raw) return;
        let envelope: RelayEnvelope;
        try {
          envelope = JSON.parse(raw);
        } catch {
          return;
        }

        if (envelope.type === "hello_ok") {
          opened = true;
          this.currentSend = send;
          this.currentBatcher = new RecvAckBatcher({
            groupId: params.groupId,
            role: "plugin",
            store: params.store,
            send,
            runtimeLogger: this.runtimeLogger,
          });
          startAppKeepalive();
          this.setState("connected");
          this.runtimeLogger?.info("runtime.hello_ok", {
            current_terms_version:
              typeof (envelope.payload as RelayHelloOkPayload)?.current_terms_version === "number"
                ? (envelope.payload as RelayHelloOkPayload).current_terms_version
                : undefined,
          });
          return;
        }

        if (envelope.type === "hello_error") {
          const payload = envelope.payload as { code?: string; message?: string };
          const err = new Error(`Relay rejected hello: ${payload.code} — ${payload.message}`);
          try {
            ws.close();
          } catch {
            // already closing
          }
          reject(err);
          return;
        }

        if (envelope.type === "msg") {
          await this.handleInboundMsg(envelope.payload as RelayMsgPayload, params);
          return;
        }

        if (envelope.type === "ping") {
          try {
            ws.send(JSON.stringify({ version: 1, type: "pong", payload: null }));
            lastSendAt = Date.now();
          } catch {
            // best-effort
          }
          return;
        }

        if (envelope.type === "pong") {
          if (appPongTimer) {
            clearTimeout(appPongTimer);
            appPongTimer = undefined;
          }
          return;
        }

        if (envelope.type === "relay_recv_ack") {
          const payload = envelope.payload as RelayRecvSenderAckPayload;
          this.runtimeLogger?.info("runtime.relay_recv_ack", {
            msg_id: payload.msg_id,
          });
          if (typeof payload.msg_id === "string" && payload.msg_id.length > 0) {
            this.emitStatus({ msgId: payload.msg_id, status: "sent" });
          }
          return;
        }
      });

      ws.on("close", () => {
        stopWsKeepalive();
        stopAppKeepalive();
        this.currentBatcher?.shutdown();
        this.currentBatcher = undefined;
        this.currentSend = undefined;
        if (!opened) {
          const err = new Error("WebSocket closed before hello_ok");
          dumpChat4000Trace("relay-transport-close", err, {
            groupId: params.groupId,
          });
          this.setState("reconnecting");
          reject(err);
        } else {
          this.setState("reconnecting");
          resolve();
        }
      });

      ws.on("error", (err) => {
        stopWsKeepalive();
        stopAppKeepalive();
        if (!opened) {
          dumpChat4000Trace("relay-transport-error", err, {
            groupId: params.groupId,
          });
          reject(new Error(`WebSocket error: ${err.message}`));
        }
      });

      this.abortController?.signal.addEventListener(
        "abort",
        () => {
          try {
            ws.close();
          } catch {
            // already closing
          }
        },
        { once: true },
      );
    });
  }

  private async handleInboundMsg(
    msg: RelayMsgPayload,
    params: { groupId: string; groupKeyBytes: Buffer; store: Chat4000AckStore },
  ): Promise<void> {
    this.runtimeLogger?.info("runtime.recv", {
      type: "msg",
      msg_id: msg.msg_id,
      seq: msg.seq,
    });

    const plaintext = decrypt(msg.nonce, msg.ciphertext, params.groupKeyBytes);
    if (!plaintext) {
      this.runtimeLogger?.info("runtime.msg_decrypt_error", {
        msg_id: msg.msg_id,
        seq: msg.seq,
      });
      // Don't persist, don't ack — let relay redrive.
      return;
    }

    let inner: WireInnerMessage;
    try {
      inner = JSON.parse(plaintext.toString("utf-8")) as WireInnerMessage;
    } catch {
      this.runtimeLogger?.info("runtime.msg_parse_error", {
        msg_id: msg.msg_id,
        seq: msg.seq,
      });
      // Frame is unrecoverable; ack so the relay drops it.
      this.queueRecvAck(msg);
      return;
    }

    const innerId = inner.id;
    if (!innerId) {
      this.runtimeLogger?.info("runtime.msg_dropped", {
        msg_id: msg.msg_id,
        reason: "missing_inner_id",
      });
      this.queueRecvAck(msg);
      return;
    }

    // Per protocol §6.6.9: dedup is on inner.id, not outer msg_id.
    const recordResult = params.store.markProcessed(params.groupId, innerId);

    if (!recordResult.isNew) {
      this.runtimeLogger?.info("runtime.msg_dedup", {
        msg_id: msg.msg_id,
        inner_id: innerId,
        seq: msg.seq,
        inner_t: inner.t,
      });
      // Always ack the new outer seq so the relay queue evicts it. Skip the
      // onReceive emission — consumer already saw this inner.id once.
      this.queueRecvAck(msg);
      return;
    }

    const consumerInner = toConsumerInner(inner);
    if (!consumerInner) {
      this.runtimeLogger?.info("runtime.msg_dropped", {
        msg_id: msg.msg_id,
        inner_id: innerId,
        reason: "unrecognized_inner_t",
        inner_t: inner.t,
      });
      this.queueRecvAck(msg);
      return;
    }

    this.runtimeLogger?.info("runtime.inner_parsed", {
      msg_id: msg.msg_id,
      inner_id: innerId,
      inner_t: inner.t,
      from_role: inner.from?.role,
    });

    try {
      for (const h of this.receiveHandlers) {
        h(consumerInner);
      }
    } finally {
      this.queueRecvAck(msg);
    }
  }

  private queueRecvAck(msg: RelayMsgPayload): void {
    if (typeof msg.seq === "number" && msg.seq > 0) {
      this.currentBatcher?.recordPersisted(msg.seq);
    }
  }

  private emitStatus(update: StatusUpdate): void {
    for (const h of this.statusHandlers) h(update);
  }

  private setState(state: ConnectionState): void {
    this.connectionState = state;
    for (const h of this.stateHandlers) h(state);
  }
}

/** Map a wire inner-message to the consumer-facing InnerMessage shape. */
function toConsumerInner(wire: WireInnerMessage): InnerMessage | undefined {
  const body = bodyFromWire(wire);
  if (!body) return undefined;
  const from: InnerMessageFrom | undefined = wire.from
    ? {
        role: wire.from.role,
        deviceId: wire.from.device_id,
        deviceName: wire.from.device_name,
        appVersion: wire.from.app_version,
        bundleId: wire.from.bundle_id,
      }
    : undefined;
  return {
    id: wire.id,
    from,
    body,
    ts: typeof wire.ts === "number" ? wire.ts : Date.now(),
  };
}

function bodyFromWire(wire: WireInnerMessage): InnerMessageBody | undefined {
  const body = wire.body as Record<string, unknown> | undefined;
  if (!body) return undefined;
  switch (wire.t) {
    case "text":
      if (typeof body.text !== "string") return undefined;
      return { kind: "text", text: body.text };
    case "image": {
      const dataBase64 = String(body.data_base64 ?? "").trim();
      const mimeType = String(body.mime_type ?? "").trim();
      if (!dataBase64 || !mimeType) return undefined;
      return { kind: "image", dataBase64, mimeType };
    }
    case "audio": {
      const dataBase64 = String(body.data_base64 ?? "").trim();
      const mimeType = String(body.mime_type ?? "").trim();
      if (!dataBase64 || !mimeType) return undefined;
      const durationMs = Number.isFinite(body.duration_ms as number)
        ? Math.max(0, Number(body.duration_ms))
        : 0;
      const waveform = Array.isArray(body.waveform)
        ? (body.waveform as unknown[])
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v))
        : [];
      return { kind: "audio", dataBase64, mimeType, durationMs, waveform };
    }
    case "text_delta": {
      const streamId = typeof body.stream_id === "string" ? body.stream_id : undefined;
      return {
        kind: "textDelta",
        delta: String(body.delta ?? ""),
        ...(streamId ? { streamId } : {}),
      };
    }
    case "text_end": {
      const streamId = typeof body.stream_id === "string" ? body.stream_id : undefined;
      return {
        kind: "textEnd",
        text: String(body.text ?? ""),
        ...(body.reset === true ? { reset: true as const } : {}),
        ...(streamId ? { streamId } : {}),
      };
    }
    case "status": {
      const s = String(body.status ?? "");
      if (s !== "thinking" && s !== "typing" && s !== "idle") return undefined;
      return { kind: "status", status: s };
    }
    case "ack": {
      const refs = String(body.refs ?? "");
      const stage = String(body.stage ?? "");
      if (!refs) return undefined;
      if (stage !== "received" && stage !== "processing" && stage !== "displayed") {
        return undefined;
      }
      return { kind: "ack", refs, stage };
    }
    default:
      return { kind: "unknown", rawType: String(wire.t) };
  }
}
