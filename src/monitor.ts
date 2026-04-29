import { watch, type FSWatcher } from "node:fs";
import { resolveChat94Account } from "./accounts.js";
import { connectOnce } from "./monitor-websocket.js";
import { decrypt } from "./crypto.js";
import { dumpChat94Trace } from "./error-log.js";
import { runWithReconnect } from "./reconnect.js";
import { RuntimeLogger } from "./runtime-logger.js";
import type {
  RelayEnvelope,
  RelayMsgPayload,
  Chat94InboundMessage,
  InnerAudioBody,
  InnerDeltaBody,
  InnerImageBody,
  InnerMessage,
  InnerStatusBody,
  InnerTextBody,
} from "./types.js";

export type MonitorOptions = {
  accountId?: string;
  config: { channels?: Record<string, unknown> };
  abortSignal?: AbortSignal;
  onMessage?: (message: Chat94InboundMessage, send: (envelope: RelayEnvelope) => void) => void | Promise<void>;
  onConnected?: (send: (envelope: RelayEnvelope) => void) => void;
  onDisconnected?: () => void;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
};

/**
 * Start monitoring the relay for inbound messages.
 * Handles reconnection with exponential backoff.
 * Returns when abortSignal fires.
 */
export async function monitorChat94Provider(opts: MonitorOptions): Promise<void> {
  const initialAccount = resolveChat94Account({
    cfg: opts.config,
    accountId: opts.accountId,
  });

  if (!initialAccount.configured) {
    throw new Error(
      `chat94 not configured for account "${initialAccount.accountId}". Run "openclaw chat94 pair".`,
    );
  }

  const runtimeLogger = new RuntimeLogger(initialAccount.runtimeLogLevel, {
    accountId: initialAccount.accountId,
    groupId: initialAccount.groupId,
  });

  let currentSend: ((envelope: RelayEnvelope) => void) | undefined;
  let activeReconnectAbort: AbortController | undefined;
  let lastSeenGroupId = initialAccount.groupId;

  // Watch the on-disk key file so an external `keys new` / re-pair flips the
  // active connection to the new room without requiring a gateway restart.
  let keyFileWatcher: FSWatcher | undefined;
  try {
    keyFileWatcher = watch(initialAccount.keyFilePath, () => {
      try {
        const refreshed = resolveChat94Account({
          cfg: opts.config,
          accountId: opts.accountId,
        });
        if (!refreshed.configured) return;
        if (refreshed.groupId === lastSeenGroupId) return;
        runtimeLogger.info("runtime.key_changed", {
          old_group_id: lastSeenGroupId,
          new_group_id: refreshed.groupId,
        });
        opts.log?.info?.(
          `[${refreshed.accountId}] chat94 key changed → reconnecting (group ${refreshed.groupId.substring(0, 8)}...)`,
        );
        activeReconnectAbort?.abort();
      } catch {
        // Ignore — the next reconnect will surface real errors.
      }
    });
  } catch {
    // File watcher is best-effort; absence just means manual restart on key change.
  }

  opts.abortSignal?.addEventListener(
    "abort",
    () => {
      keyFileWatcher?.close();
    },
    { once: true },
  );

  const createConnectOnce = () => {
    // Re-resolve account on every connect attempt so reconnects (after key
    // rotation, file watcher, or transient errors) pick up the latest key.
    const account = resolveChat94Account({
      cfg: opts.config,
      accountId: opts.accountId,
    });
    if (!account.configured) {
      throw new Error(
        `chat94 not configured for account "${account.accountId}". Run "openclaw chat94 pair".`,
      );
    }
    lastSeenGroupId = account.groupId;

    // Per-connection abort: parent abort still tears everything down, but the
    // key-file watcher can also fire this to force just one reconnect.
    const localAbort = new AbortController();
    activeReconnectAbort = localAbort;
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        localAbort.abort();
      } else {
        opts.abortSignal.addEventListener("abort", () => localAbort.abort(), { once: true });
      }
    }

    const connectOpts = {
      relayUrl: account.relayUrl,
      groupId: account.groupId,
      releaseChannel: account.config.releaseChannel,
      abortSignal: localAbort.signal,
      onWsOpen: () => {
        runtimeLogger.info("runtime.ws_open");
      },
      onHelloSent: () => {
        runtimeLogger.info("runtime.hello_sent");
      },
      onHelloOk: (payload: { current_terms_version?: number }) => {
        runtimeLogger.info("runtime.hello_ok", {
          current_terms_version: typeof payload.current_terms_version === "number"
            ? payload.current_terms_version
            : undefined,
        });
      },

      onMessage: async (msg: RelayMsgPayload) => {
        runtimeLogger.info("runtime.recv", {
          type: "msg",
          msg_id: msg.msg_id,
        });
        const plaintext = decrypt(msg.nonce, msg.ciphertext, account.groupKeyBytes);
        if (!plaintext) {
          runtimeLogger.info("runtime.msg_decrypt_error", { msg_id: msg.msg_id });
          opts.log?.warn?.(`[${account.accountId}] Failed to decrypt message ${msg.msg_id}`);
          return;
        }
        runtimeLogger.info("runtime.msg_decrypted", {
          msg_id: msg.msg_id,
          plaintext_len: plaintext.length,
        });

        const json = plaintext.toString("utf-8");
        let inner: InnerMessage;
        try {
          inner = JSON.parse(json) as InnerMessage;
        } catch {
          runtimeLogger.info("runtime.msg_parse_error", { msg_id: msg.msg_id });
          opts.log?.warn?.(`[${account.accountId}] Failed to parse inner message JSON`);
          return;
        }

        runtimeLogger.info("runtime.inner_parsed", {
          msg_id: msg.msg_id,
          inner_t: inner.t,
          from_role: inner.from?.role,
          from_device_id: inner.from?.device_id,
        });

        opts.log?.debug?.(`[${account.accountId}] Received inner message type=${inner.t} id=${inner.id}`);

        if (!currentSend) {
          runtimeLogger.info("runtime.msg_dropped", {
            msg_id: msg.msg_id,
            reason: "send channel not ready",
          });
          opts.log?.warn?.(`[${account.accountId}] Dropping inbound message before send channel was ready`);
          return;
        }

        if (inner.t === "text") {
          const inbound: Chat94InboundMessage = {
            messageId: inner.id,
            innerType: "text",
            text: (inner.body as InnerTextBody).text,
            timestamp: inner.ts,
            groupId: account.groupId,
            from: inner.from,
          };

          await opts.onMessage?.(inbound, currentSend);
          return;
        }

        if (inner.t === "image") {
          const body = inner.body as InnerImageBody;
          const dataBase64 = body.data_base64?.trim() ?? "";
          const mimeType = body.mime_type?.trim() ?? "";
          if (!dataBase64 || !mimeType) {
            runtimeLogger.info("runtime.image_dropped", {
              msg_id: msg.msg_id,
              reason: "missing image payload fields",
            });
            opts.log?.warn?.(`[${account.accountId}] Dropping inbound image with incomplete payload`);
            return;
          }

          const inbound: Chat94InboundMessage = {
            messageId: inner.id,
            innerType: "image",
            dataBase64,
            mimeType,
            timestamp: inner.ts,
            groupId: account.groupId,
            from: inner.from,
          };

          runtimeLogger.info("runtime.recv", {
            type: "msg",
            msg_id: msg.msg_id,
            inner_t: "image",
          });
          runtimeLogger.info("runtime.image_received", {
            msg_id: msg.msg_id,
            mime_type: mimeType,
            bytes_base64_len: dataBase64.length,
          });
          await opts.onMessage?.(inbound, currentSend);
          return;
        }

        if (inner.t === "audio") {
          const body = inner.body as InnerAudioBody;
          const dataBase64 = body.data_base64?.trim() ?? "";
          const mimeType = body.mime_type?.trim() ?? "";
          const durationMs = Number.isFinite(body.duration_ms) ? Math.max(0, body.duration_ms) : 0;
          const waveform = Array.isArray(body.waveform)
            ? body.waveform
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value))
            : [];

          if (!dataBase64 || !mimeType) {
            runtimeLogger.info("runtime.audio_dropped", {
              msg_id: msg.msg_id,
              reason: "missing audio payload fields",
            });
            opts.log?.warn?.(`[${account.accountId}] Dropping inbound audio with incomplete payload`);
            return;
          }

          const inbound: Chat94InboundMessage = {
            messageId: inner.id,
            innerType: "audio",
            dataBase64,
            mimeType,
            durationMs,
            waveform,
            timestamp: inner.ts,
            groupId: account.groupId,
            from: inner.from,
          };

          runtimeLogger.info("runtime.recv", {
            type: "msg",
            msg_id: msg.msg_id,
            inner_t: "audio",
          });
          runtimeLogger.info("runtime.audio_received", {
            msg_id: msg.msg_id,
            mime_type: mimeType,
            duration_ms: durationMs,
            bytes_base64_len: dataBase64.length,
            waveform_samples: waveform.length,
          });
          await opts.onMessage?.(inbound, currentSend);
          return;
        }

        if (inner.t === "text_delta") {
          const delta = (inner.body as InnerDeltaBody).delta;
          opts.log?.debug?.(`[${account.accountId}] Ignoring inbound text_delta: ${delta.length} chars`);
          return;
        }

        if (inner.t === "text_end") {
          const text = (inner.body as InnerTextBody).text;
          opts.log?.debug?.(`[${account.accountId}] Ignoring inbound text_end: ${text.length} chars`);
          return;
        }

        if (inner.t === "status") {
          const status = (inner.body as InnerStatusBody).status;
          opts.log?.debug?.(`[${account.accountId}] Received status update: ${status}`);
          return;
        }

        runtimeLogger.info("runtime.msg_dropped", {
          msg_id: msg.msg_id,
          reason: "unsupported_inner_type",
          inner_t: inner.t,
        });
        opts.log?.warn?.(
          `[${account.accountId}] Dropping unsupported inner message type=${String(inner.t)}`,
        );
      },

      onConnected: (send: (envelope: RelayEnvelope) => void) => {
        opts.log?.info?.(`[${account.accountId}] Connected to relay`);
        currentSend = send;
        opts.onConnected?.(send);
      },

      onDisconnected: () => {
        opts.log?.info?.(`[${account.accountId}] Disconnected from relay`);
        currentSend = undefined;
        opts.onDisconnected?.();
      },
      onTyping: async (type: "typing" | "typing_stop") => {
        runtimeLogger.info("runtime.recv", { type });
      },
    };

    return connectOnce(connectOpts);
  };

  try {
    await runWithReconnect(createConnectOnce, {
      abortSignal: opts.abortSignal,
      onError: (err) => {
        dumpChat94Trace("relay-monitor", err, {
          accountId: initialAccount.accountId,
        });
        opts.log?.error?.(`[${initialAccount.accountId}] Relay error: ${err}`);
      },
      onReconnect: (delayMs) => {
        opts.log?.info?.(
          `[${initialAccount.accountId}] Reconnecting in ${Math.round(delayMs)}ms...`,
        );
      },
    });
  } finally {
    keyFileWatcher?.close();
  }
}
