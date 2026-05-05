import { resolveChat4000Account } from "./accounts.js";
import { connectOnce } from "./monitor-websocket.js";
import { decrypt } from "./crypto.js";
import { dumpChat4000Trace } from "./error-log.js";
import { runWithReconnect } from "./reconnect.js";
import { RuntimeLogger } from "./runtime-logger.js";
import { openAckStore, type Chat4000AckStore } from "./ack-store.js";
import { RecvAckBatcher } from "./recv-ack-batcher.js";
import { sendInnerAck } from "./send.js";
import type {
  RelayEnvelope,
  RelayMsgPayload,
  Chat4000InboundMessage,
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
  onMessage?: (message: Chat4000InboundMessage, send: (envelope: RelayEnvelope) => void) => void | Promise<void>;
  onConnected?: (send: (envelope: RelayEnvelope) => void) => void;
  onDisconnected?: () => void;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** Test seam: override the ack store. */
  ackStore?: Chat4000AckStore;
};

/**
 * Start monitoring the relay for inbound messages.
 *
 * Owns the durable ack/dedupe layer for this account:
 *   - reads `last_acked_seq` from disk before every reconnect (§6.6.8)
 *   - dedupes inbound app messages by inner `msg_id` so relay redrives never
 *     double-process (§6.6.9)
 *   - emits cumulative `recv_ack` (Flow A) once any persisted seq is pending
 *   - emits inner `ack` stage=`received` (Flow B) for app-origin text/image/audio
 *   - flushes pending acks on clean shutdown
 */
export async function monitorChat4000Provider(opts: MonitorOptions): Promise<void> {
  const account = resolveChat4000Account({
    cfg: opts.config,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `chat4000 not configured for account "${account.accountId}". Run "openclaw chat4000 setup".`,
    );
  }

  const runtimeLogger = new RuntimeLogger(account.runtimeLogLevel, {
    accountId: account.accountId,
    groupId: account.groupId,
  });

  const ackStore = opts.ackStore ?? openAckStore(account.accountId);

  let currentSend: ((envelope: RelayEnvelope) => void) | undefined;
  let currentBatcher: RecvAckBatcher | undefined;

  const handleInboundMessage = async (msg: RelayMsgPayload): Promise<void> => {
    runtimeLogger.info("runtime.recv", {
      type: "msg",
      msg_id: msg.msg_id,
      seq: msg.seq,
    });

    // Decrypt failure: don't persist, don't ack — let relay redrive in case
    // the key situation resolves. Persisting would dedupe a later successful
    // decrypt and silently drop the message forever.
    const plaintext = decrypt(msg.nonce, msg.ciphertext, account.groupKeyBytes);
    if (!plaintext) {
      runtimeLogger.info("runtime.msg_decrypt_error", { msg_id: msg.msg_id, seq: msg.seq });
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
      runtimeLogger.info("runtime.msg_parse_error", { msg_id: msg.msg_id, seq: msg.seq });
      opts.log?.warn?.(`[${account.accountId}] Failed to parse inner message JSON`);
      // Frame is unrecoverable; persist + ack so the relay drops it.
      ackStore.recordInboundMessage({
        msgId: msg.msg_id,
        groupId: account.groupId,
        seq: msg.seq,
        innerT: undefined,
        ts: undefined,
      });
      if (typeof msg.seq === "number" && msg.seq > 0) {
        currentBatcher?.recordPersisted(msg.seq);
      }
      return;
    }

    runtimeLogger.info("runtime.inner_parsed", {
      msg_id: msg.msg_id,
      inner_t: inner.t,
      from_role: inner.from?.role,
      from_device_id: inner.from?.device_id,
    });

    opts.log?.debug?.(`[${account.accountId}] Received inner message type=${inner.t} id=${inner.id}`);

    // Persist the msg_id so a future redrive of the same `(msg_id)` is treated
    // as a duplicate. INSERT OR IGNORE — `isNew=false` means the relay redrove
    // a message we already processed; we still need to ack the new seq but
    // must not re-dispatch and must not re-emit the inner ack.
    const recordResult = ackStore.recordInboundMessage({
      msgId: msg.msg_id,
      groupId: account.groupId,
      seq: msg.seq,
      innerT: inner.t,
      ts: typeof inner.ts === "number" ? inner.ts : undefined,
    });

    const queueRecvAck = () => {
      if (typeof msg.seq === "number" && msg.seq > 0) {
        currentBatcher?.recordPersisted(msg.seq);
      }
    };

    if (!recordResult.isNew) {
      runtimeLogger.info("runtime.msg_dedup", {
        msg_id: msg.msg_id,
        seq: msg.seq,
        inner_t: inner.t,
      });
      // Always ack the redriven seq so the relay queue evicts it, even though
      // we skip both the inner-ack emission and the agent dispatch.
      queueRecvAck();
      return;
    }

    if (!currentSend) {
      runtimeLogger.info("runtime.msg_dropped", {
        msg_id: msg.msg_id,
        reason: "send channel not ready",
      });
      opts.log?.warn?.(`[${account.accountId}] Dropping inbound message before send channel was ready`);
      // Still ack — we've durably noted the msg_id; redrive would just be a
      // duplicate. The dropped agent dispatch is observable in the runtime log.
      queueRecvAck();
      return;
    }

    // Flow B (§6.6.5): emit inner ack stage=received for app-origin chat
    // messages, gated on:
    //   - the inbound came with a relay-assigned `seq` (ack-aware relay)
    //   - the body parses cleanly (`text` is always valid; image/audio require
    //     non-empty data_base64 + mime_type)
    //   - the (refs, stage) hasn't been acked before for this group
    //   - the message is from role=app (not from another plugin instance)
    // Emitted BEFORE the agent dispatch so the app's UI tick flips
    // immediately, not after the LLM produces tokens.
    const isAckEligibleType = inner.t === "text" || inner.t === "image" || inner.t === "audio";
    const isFromApp = inner.from?.role === "app";
    const ackAwareTransport = typeof msg.seq === "number" && msg.seq > 0;
    let bodyValid = true;
    if (inner.t === "image") {
      const body = inner.body as InnerImageBody;
      if (!body?.data_base64?.trim() || !body?.mime_type?.trim()) {
        bodyValid = false;
      }
    } else if (inner.t === "audio") {
      const body = inner.body as InnerAudioBody;
      if (!body?.data_base64?.trim() || !body?.mime_type?.trim()) {
        bodyValid = false;
      }
    }

    if (isAckEligibleType && isFromApp && ackAwareTransport && bodyValid) {
      const ackResult = ackStore.markInnerAckEmitted({
        groupId: account.groupId,
        refs: inner.id,
        stage: "received",
      });
      if (ackResult.isNew) {
        try {
          sendInnerAck(account.groupId, inner.id, "received");
        } catch (err) {
          runtimeLogger.info("runtime.inner_ack_send_error", {
            msg_id: msg.msg_id,
            refs: inner.id,
            error: String(err),
          });
        }
      }
    }

    if (inner.t === "text") {
      const inbound: Chat4000InboundMessage = {
        messageId: inner.id,
        innerType: "text",
        text: (inner.body as InnerTextBody).text,
        timestamp: inner.ts,
        groupId: account.groupId,
        from: inner.from,
      };
      try {
        await opts.onMessage?.(inbound, currentSend);
      } finally {
        queueRecvAck();
      }
      return;
    }

    if (inner.t === "image") {
      const body = inner.body as InnerImageBody;
      if (!bodyValid) {
        runtimeLogger.info("runtime.image_dropped", {
          msg_id: msg.msg_id,
          reason: "missing image payload fields",
        });
        opts.log?.warn?.(`[${account.accountId}] Dropping inbound image with incomplete payload`);
        // Persisted, malformed → ack + return; do not emit inner ack.
        queueRecvAck();
        return;
      }
      const inbound: Chat4000InboundMessage = {
        messageId: inner.id,
        innerType: "image",
        dataBase64: body.data_base64.trim(),
        mimeType: body.mime_type.trim(),
        timestamp: inner.ts,
        groupId: account.groupId,
        from: inner.from,
      };
      runtimeLogger.info("runtime.image_received", {
        msg_id: msg.msg_id,
        mime_type: inbound.mimeType,
        bytes_base64_len: inbound.dataBase64.length,
      });
      try {
        await opts.onMessage?.(inbound, currentSend);
      } finally {
        queueRecvAck();
      }
      return;
    }

    if (inner.t === "audio") {
      const body = inner.body as InnerAudioBody;
      if (!bodyValid) {
        runtimeLogger.info("runtime.audio_dropped", {
          msg_id: msg.msg_id,
          reason: "missing audio payload fields",
        });
        opts.log?.warn?.(`[${account.accountId}] Dropping inbound audio with incomplete payload`);
        queueRecvAck();
        return;
      }
      const durationMs = Number.isFinite(body.duration_ms) ? Math.max(0, body.duration_ms) : 0;
      const waveform = Array.isArray(body.waveform)
        ? body.waveform.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];
      const inbound: Chat4000InboundMessage = {
        messageId: inner.id,
        innerType: "audio",
        dataBase64: body.data_base64.trim(),
        mimeType: body.mime_type.trim(),
        durationMs,
        waveform,
        timestamp: inner.ts,
        groupId: account.groupId,
        from: inner.from,
      };
      runtimeLogger.info("runtime.audio_received", {
        msg_id: msg.msg_id,
        mime_type: inbound.mimeType,
        duration_ms: durationMs,
        bytes_base64_len: inbound.dataBase64.length,
        waveform_samples: waveform.length,
      });
      try {
        await opts.onMessage?.(inbound, currentSend);
      } finally {
        queueRecvAck();
      }
      return;
    }

    if (inner.t === "text_delta") {
      const delta = (inner.body as InnerDeltaBody).delta;
      opts.log?.debug?.(`[${account.accountId}] Ignoring inbound text_delta: ${delta?.length ?? 0} chars`);
      // Streaming chunks from another sender: still ack so the relay evicts.
      // We do NOT emit a Flow B inner ack for these (per §6.6.5: only
      // text / image / audio originate Flow B receipts).
      queueRecvAck();
      return;
    }

    if (inner.t === "text_end") {
      const text = (inner.body as InnerTextBody).text;
      opts.log?.debug?.(`[${account.accountId}] Ignoring inbound text_end: ${text?.length ?? 0} chars`);
      queueRecvAck();
      return;
    }

    if (inner.t === "status") {
      const status = (inner.body as InnerStatusBody).status;
      opts.log?.debug?.(`[${account.accountId}] Received status update: ${status}`);
      queueRecvAck();
      return;
    }

    if (inner.t === "ack") {
      // Flow B receipt for one of OUR outbound messages. We don't propagate
      // this anywhere yet — it would drive a "delivered" indicator in a
      // future plugin-side UI. Still ack the seq.
      const body = inner.body as { refs?: string; stage?: string };
      runtimeLogger.info("runtime.inner_ack_recv", {
        msg_id: msg.msg_id,
        refs: body?.refs,
        stage: body?.stage,
        from_role: inner.from?.role,
      });
      queueRecvAck();
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
    queueRecvAck();
  };

  const buildConnectOnce = () => {
    // Re-read the persisted watermark every reconnect so the relay redrives
    // only what we haven't already locally processed.
    const lastAckedSeq = ackStore.getLastAckedSeq(account.groupId, "plugin");

    const connectOpts = {
      relayUrl: account.relayUrl,
      groupId: account.groupId,
      releaseChannel: account.config.releaseChannel,
      lastAckedSeq,
      abortSignal: opts.abortSignal,
      onWsOpen: () => {
        runtimeLogger.info("runtime.ws_open");
      },
      onHelloSent: () => {
        runtimeLogger.info("runtime.hello_sent", { last_acked_seq: lastAckedSeq });
      },
      onHelloOk: (payload: { current_terms_version?: number }) => {
        runtimeLogger.info("runtime.hello_ok", {
          current_terms_version: typeof payload.current_terms_version === "number"
            ? payload.current_terms_version
            : undefined,
        });
      },

      onMessage: handleInboundMessage,

      onRelayRecvAck: (payload: { msg_id: string; queued_for?: string[] }) => {
        runtimeLogger.info("runtime.relay_recv_ack", {
          msg_id: payload.msg_id,
          queued_for: Array.isArray(payload.queued_for) ? payload.queued_for.join(",") : undefined,
        });
      },

      onConnected: (send: (envelope: RelayEnvelope) => void) => {
        opts.log?.info?.(`[${account.accountId}] Connected to relay`);
        currentSend = send;
        // Fresh batcher per connection: the ack store remains the source of
        // truth so we never double-ack across reconnects.
        currentBatcher = new RecvAckBatcher({
          groupId: account.groupId,
          role: "plugin",
          store: ackStore,
          send,
          runtimeLogger,
        });
        opts.onConnected?.(send);
      },

      onDisconnected: () => {
        opts.log?.info?.(`[${account.accountId}] Disconnected from relay`);
        // Final flush so any pending in-memory seqs persist their watermark
        // before the socket goes away. The actual `recv_ack` send will no-op
        // if the socket is already closed; the watermark write is what
        // matters for next reconnect.
        currentBatcher?.shutdown();
        currentBatcher = undefined;
        currentSend = undefined;
        opts.onDisconnected?.();
      },
      onTyping: async (type: "typing" | "typing_stop") => {
        runtimeLogger.info("runtime.recv", { type });
      },
    };

    return () => connectOnce(connectOpts);
  };

  // Final flush on abort (clean shutdown path).
  opts.abortSignal?.addEventListener("abort", () => {
    currentBatcher?.shutdown();
    currentBatcher = undefined;
  }, { once: true });

  await runWithReconnect(
    async () => buildConnectOnce()(),
    {
      abortSignal: opts.abortSignal,
      onError: (err) => {
        dumpChat4000Trace("relay-monitor", err, {
          accountId: account.accountId,
        });
        opts.log?.error?.(`[${account.accountId}] Relay error: ${err}`);
      },
      onReconnect: (delayMs) => {
        opts.log?.info?.(`[${account.accountId}] Reconnecting in ${Math.round(delayMs)}ms...`);
      },
    },
  );
}
