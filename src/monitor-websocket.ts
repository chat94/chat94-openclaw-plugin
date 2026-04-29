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
} from "./types.js";
import { attachWebSocketKeepalive } from "./ws-keepalive.js";

export type ConnectOnceOptions = {
  relayUrl: string;
  groupId: string;
  appVersion?: string;
  releaseChannel?: string;
  abortSignal?: AbortSignal;
  onWsOpen?: () => void;
  onHelloSent?: () => void;
  onHelloOk?: (payload: RelayHelloOkPayload) => void | Promise<void>;
  onMessage?: (msg: RelayMsgPayload) => void | Promise<void>;
  onTyping?: (type: "typing" | "typing_stop") => void | Promise<void>;
  onPairOpenOk?: (payload: RelayPairOpenOkPayload) => void | Promise<void>;
  onPairReady?: () => void | Promise<void>;
  onPairData?: (payload: RelayPairDataPayload) => void | Promise<void>;
  onPairCancel?: (payload: RelayPairCancelPayload) => void | Promise<void>;
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

    const send = (envelope: RelayEnvelope) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(envelope));
      }
    };

    ws.on("open", () => {
      opts.onWsOpen?.();
      const hello: RelayEnvelope = {
        version: 1,
        type: "hello",
        payload: {
          role: "plugin",
          group_id: opts.groupId,
          device_token: null,
          app_version: opts.appVersion ?? readPackageVersion(),
          release_channel: opts.releaseChannel ?? "production",
        } satisfies RelayHelloPayload as unknown as Record<string, unknown>,
      };

      ws.send(JSON.stringify(hello));
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
