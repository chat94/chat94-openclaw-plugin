import WebSocket from "ws";
import { dumpChat4000Trace } from "./error-log.js";
import { readPackageVersion } from "./package-info.js";
import type {
  RelayEnvelope,
  RelayHelloOkPayload,
  RelayHelloPayload,
  RelayMsgPayload,
  RelayPairDataPayload,
  RelayPairOpenOkPayload,
  RelayPairCancelPayload,
  RelayRecvSenderAckPayload,
} from "./types.js";
import { attachWebSocketKeepalive } from "./ws-keepalive.js";

/** Per protocol §6.5: app-layer ping every 25s of socket-idle time. */
const APP_PING_INTERVAL_MS = 25_000;
/** Reconnect if no app-layer pong is observed within this window after a ping. */
const APP_PONG_TIMEOUT_MS = 15_000;

export type ConnectOnceOptions = {
  relayUrl: string;
  groupId: string;
  appVersion?: string;
  releaseChannel?: string;
  abortSignal?: AbortSignal;
  /**
   * Ack-aware reconnect replay marker (§6.6.8). Sent on hello so the relay
   * redrives only `seq > lastAckedSeq` for this `(group_id, role=plugin)`
   * pair. Omit / pass 0 on first connect; pre-ack relays ignore it.
   */
  lastAckedSeq?: number;
  onWsOpen?: () => void;
  onHelloSent?: () => void;
  onHelloOk?: (payload: RelayHelloOkPayload) => void | Promise<void>;
  onMessage?: (msg: RelayMsgPayload) => void | Promise<void>;
  onTyping?: (type: "typing" | "typing_stop") => void | Promise<void>;
  onPairOpenOk?: (payload: RelayPairOpenOkPayload) => void | Promise<void>;
  onPairReady?: () => void | Promise<void>;
  onPairData?: (payload: RelayPairDataPayload) => void | Promise<void>;
  onPairCancel?: (payload: RelayPairCancelPayload) => void | Promise<void>;
  /**
   * Relay-emitted "your message was queued/fanned out" hint for an outbound
   * msg. Optional in v1 — drives the `sent` tick if the plugin ever exposes a
   * UI; safe to ignore.
   */
  onRelayRecvAck?: (payload: RelayRecvSenderAckPayload) => void | Promise<void>;
  onConnected?: (send: (envelope: RelayEnvelope) => void) => void;
  onDisconnected?: () => void;
};

/**
 * Connect to the relay server once. Returns a promise that:
 * - Resolves when the connection closes normally
 * - Rejects when the connection fails
 *
 * The caller (runWithReconnect) handles retry logic.
 */
export function connectOnce(opts: ConnectOnceOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let opened = false;
    const ws = new WebSocket(opts.relayUrl);
    const stopKeepalive = attachWebSocketKeepalive(ws);

    let appPingTimer: NodeJS.Timeout | undefined;
    let appPongTimer: NodeJS.Timeout | undefined;
    let lastSendAt = Date.now();

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
      // App-layer ping, distinct from WS frame-level ping in ws-keepalive.ts.
      // Only this proves the receiving side's app process is pumping its
      // receive loop (§6.5).
      appPingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const idleMs = Date.now() - lastSendAt;
        if (idleMs < APP_PING_INTERVAL_MS - 1000) {
          // Recent send already exercised the path; skip this tick.
          return;
        }
        try {
          ws.send(JSON.stringify({ version: 1, type: "ping", payload: null }));
          lastSendAt = Date.now();
        } catch {
          // Close handler will own recovery.
          return;
        }
        if (appPongTimer) clearTimeout(appPongTimer);
        appPongTimer = setTimeout(() => {
          // Missed pong → drop the socket; runWithReconnect will retry.
          try {
            ws.close();
          } catch {
            // Already closing.
          }
        }, APP_PONG_TIMEOUT_MS);
      }, APP_PING_INTERVAL_MS);
    };

    ws.on("open", () => {
      opts.onWsOpen?.();
      const helloPayload: RelayHelloPayload = {
        role: "plugin",
        group_id: opts.groupId,
        device_token: null,
        app_version: opts.appVersion ?? readPackageVersion(),
        release_channel: opts.releaseChannel ?? "production",
      };
      // Per §6.6.8: include cumulative high-water mark on every reconnect.
      // Pre-ack relays simply ignore unknown fields.
      if (typeof opts.lastAckedSeq === "number" && opts.lastAckedSeq > 0) {
        helloPayload.last_acked_seq = opts.lastAckedSeq;
      }
      const hello: RelayEnvelope = {
        version: 1,
        type: "hello",
        payload: helloPayload satisfies RelayHelloPayload as unknown as Record<string, unknown>,
      };

      ws.send(JSON.stringify(hello));
      lastSendAt = Date.now();
      opts.onHelloSent?.();
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
        const payload = envelope.payload && typeof envelope.payload === "object"
          ? envelope.payload as RelayHelloOkPayload
          : {};
        await opts.onHelloOk?.(payload);
        startAppKeepalive();
        opts.onConnected?.(send);
        return;
      }

      if (envelope.type === "hello_error") {
        const payload = envelope.payload as { code?: string; message?: string };
        reject(new Error(`Relay rejected hello: ${payload.code} — ${payload.message}`));
        ws.close();
        return;
      }

      if (envelope.type === "msg") {
        await opts.onMessage?.(envelope.payload as RelayMsgPayload);
        return;
      }

      if (envelope.type === "ping") {
        // Relay-initiated app-layer ping (§6.5): respond with pong on the same connection.
        try {
          ws.send(JSON.stringify({ version: 1, type: "pong", payload: null }));
          lastSendAt = Date.now();
        } catch {
          // Best-effort.
        }
        return;
      }

      if (envelope.type === "pong") {
        // Our app-layer ping was answered; cancel the disconnect timer.
        if (appPongTimer) {
          clearTimeout(appPongTimer);
          appPongTimer = undefined;
        }
        return;
      }

      if (envelope.type === "relay_recv_ack") {
        await opts.onRelayRecvAck?.(envelope.payload as RelayRecvSenderAckPayload);
        return;
      }

      if (envelope.type === "pair_open_ok") {
        await opts.onPairOpenOk?.(envelope.payload as RelayPairOpenOkPayload);
        return;
      }

      if (envelope.type === "pair_ready") {
        await opts.onPairReady?.();
        return;
      }

      if (envelope.type === "pair_data") {
        await opts.onPairData?.(envelope.payload as RelayPairDataPayload);
        return;
      }

      if (envelope.type === "pair_cancel") {
        await opts.onPairCancel?.(envelope.payload as RelayPairCancelPayload);
        return;
      }

      if (envelope.type === "typing" || envelope.type === "typing_stop") {
        await opts.onTyping?.(envelope.type);
        return;
      }
    });

    ws.on("close", () => {
      stopKeepalive();
      stopAppKeepalive();
      opts.onDisconnected?.();
      if (!opened) {
        const error = new Error("WebSocket closed before hello_ok");
        dumpChat4000Trace("relay-connect-close", error, {
          groupId: opts.groupId,
        });
        reject(error);
      } else {
        resolve();
      }
    });

    ws.on("error", (err) => {
      stopKeepalive();
      stopAppKeepalive();
      opts.onDisconnected?.();
      dumpChat4000Trace("relay-connect-error", err, {
        groupId: opts.groupId,
      });
      if (!opened) {
        reject(new Error(`WebSocket error: ${err.message}`));
      }
    });

    opts.abortSignal?.addEventListener("abort", () => {
      ws.close();
    }, { once: true });
  });
}
