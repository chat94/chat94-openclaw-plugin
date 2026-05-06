/**
 * chat4000 Channel Plugin for OpenClaw.
 *
 * Routes messages between an OpenClaw agent and chat4000 iOS/macOS apps via
 * an end-to-end encrypted relay.
 *
 * The plugin is split along a `MessageTransport` seam:
 *   - `RelayMessageTransport` owns the wire (WS, encryption, §6.6 ack flow,
 *     §6.5 keepalive, reconnect, dedup by inner.id).
 *   - This file owns OpenClaw glue: agent dispatch, session binding,
 *     session-relative timestamps, media materialization, and (via
 *     `StreamDispatcher`) the §6.4.2 streaming invariants.
 */

import {
  resolveChat4000Account,
  hasConfiguredState,
  listChat4000AccountIds,
  getDefaultChat4000AccountId,
} from "./accounts.js";
import { getChat4000SessionBinding } from "./session-binding.js";
import type { ResolvedChat4000Account } from "./types.js";
import { RuntimeLogger } from "./runtime-logger.js";
import { StreamDispatcher } from "./stream-dispatcher.js";
import {
  registerTransport,
  unregisterTransport,
  getTransport,
} from "./transport/registry.js";
import type {
  ConnectionState,
  InnerAudioBody,
  InnerImageBody,
  InnerMessage,
  InnerTextBody,
  MessageTransport,
} from "./transport/index.js";

let mediaRuntimePromise:
  | Promise<{
      saveMediaBuffer: (
        buffer: Buffer,
        contentType: string,
        source?: string,
        subdir?: string,
        fileName?: string,
      ) => Promise<{ path: string; contentType?: string | null }>;
      buildAgentMediaPayload: (
        mediaList: Array<{ path: string; contentType?: string | null }>,
      ) => {
        MediaPath?: string;
        MediaType?: string;
        MediaPaths?: string[];
        MediaTypes?: string[];
      };
    }>
  | undefined;

let replyPipelinePromise:
  | Promise<{
      createChannelReplyPipeline: (params: {
        cfg: unknown;
        agentId: string;
        channel?: string;
        accountId?: string;
        typing?: {
          start: () => Promise<void> | void;
          onStartError?: (err: unknown) => void;
        };
      }) => {
        typingCallbacks?: unknown;
      };
    }>
  | undefined;

let transportRuntimePromise:
  | Promise<typeof import("./transport/relay.js")>
  | undefined;

async function loadTransportRuntime() {
  transportRuntimePromise ??= import("./transport/relay.js");
  return await transportRuntimePromise;
}

async function loadReplyPipelineRuntime() {
  replyPipelinePromise ??= import("openclaw/plugin-sdk/channel-reply-pipeline").then((mod) => ({
    createChannelReplyPipeline: mod.createChannelReplyPipeline,
  }));
  return await replyPipelinePromise;
}

async function loadMediaRuntime() {
  mediaRuntimePromise ??= import("openclaw/plugin-sdk/media-runtime").then((mod) => ({
    saveMediaBuffer: mod.saveMediaBuffer,
    buildAgentMediaPayload: mod.buildAgentMediaPayload,
  }));
  return await mediaRuntimePromise;
}

// ─── Channel plugin definition ──────────────────────────────────────────────

export const chat4000Plugin = {
  id: "chat4000" as const,

  meta: {
    id: "chat4000",
    label: "chat4000",
    selectionLabel: "chat4000 (iOS/macOS app)",
    docsPath: "/channels/chat4000",
    markdownCapable: true,
    capabilities: {
      chatTypes: ["direct" as const],
      media: true,
      reactions: true,
      edit: true,
      unsend: true,
      reply: true,
      effects: true,
      blockStreaming: false,
    },
    reload: {
      configPrefixes: ["channels.chat4000"],
    },
  },

  // ─── Config ─────────────────────────────────────────────────────────────

  config: {
    hasConfiguredState: ({ env }: { env?: Record<string, string> }) =>
      hasConfiguredState(env),

    listAccountIds: (cfg?: { channels?: Record<string, unknown> }) =>
      listChat4000AccountIds(cfg),

    defaultAccountId: (cfg?: { channels?: Record<string, unknown> }) =>
      getDefaultChat4000AccountId(cfg),

    isConfigured: (account: ResolvedChat4000Account) => account.configured,

    resolveAccount: (
      cfg?: { channels?: Record<string, unknown> },
      accountId?: string | null,
    ) => resolveChat4000Account({ cfg, accountId }),

    inspectAccount: (
      cfg?: { channels?: Record<string, unknown> },
      accountId?: string | null,
    ) => {
      const account = resolveChat4000Account({ cfg, accountId });
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        groupId: account.groupId,
        groupKeyStatus: account.groupKeyBytes.length === 32 ? `available (${account.keySource})` : "missing",
      };
    },

    describeAccount: (account: ResolvedChat4000Account) => ({
      name: `chat4000 (${account.groupId.substring(0, 8)}...)`,
      configured: account.configured,
      enabled: account.enabled,
      extra: {
        groupId: account.groupId,
      },
    }),
  },

  // ─── Gateway (transport lifecycle + agent dispatch) ─────────────────────

  gateway: {
    startAccount: async (ctx: {
      cfg: { channels?: Record<string, unknown> };
      accountId: string;
      account: ResolvedChat4000Account;
      channelRuntime?: unknown;
      abortSignal: AbortSignal;
      setStatus: (next: unknown) => void;
      log?: {
        info?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string) => void;
        debug?: (msg: string) => void;
      };
    }) => {
      if (!ctx.account.configured) {
        throw new Error(
          `chat4000 not configured for account "${ctx.account.accountId}". ` +
          `Run "openclaw chat4000 setup" to create the local key and finish setup.`,
        );
      }

      ctx.log?.info?.(`[${ctx.account.accountId}] Starting chat4000 channel`);
      const runtimeLogger = new RuntimeLogger(ctx.account.runtimeLogLevel, {
        accountId: ctx.account.accountId,
        groupId: ctx.account.groupId,
      });

      const { RelayMessageTransport } = await loadTransportRuntime();
      const transport = new RelayMessageTransport({ abortSignal: ctx.abortSignal });
      registerTransport(ctx.account.accountId, transport);

      const setConnected = (connected: boolean) =>
        ctx.setStatus({
          accountId: ctx.account.accountId,
          name: `chat4000 (${ctx.account.groupId.substring(0, 8)}...)`,
          enabled: true,
          configured: true,
          extra: { connected },
        });

      transport.onConnectionState((state: ConnectionState) => {
        if (state === "connected") {
          ctx.log?.info?.(`[${ctx.account.accountId}] Connected to relay`);
          setConnected(true);
        } else if (state === "disconnected" || state === "reconnecting") {
          if (state === "reconnecting") {
            ctx.log?.info?.(`[${ctx.account.accountId}] Reconnecting...`);
          } else {
            ctx.log?.info?.(`[${ctx.account.accountId}] Disconnected from relay`);
          }
          setConnected(false);
        } else if (typeof state === "object" && "kind" in state && state.kind === "failed") {
          ctx.log?.error?.(`[${ctx.account.accountId}] Relay failed: ${state.reason}`);
          setConnected(false);
        }
      });

      transport.onReceive((inner) => {
        void handleInbound({
          inner,
          transport,
          ctx,
          runtimeLogger,
        });
      });

      transport.connect({
        accountId: ctx.account.accountId,
        groupId: ctx.account.groupId,
        groupKeyBytes: ctx.account.groupKeyBytes,
        relayUrl: ctx.account.relayUrl,
        releaseChannel: ctx.account.config.releaseChannel,
        runtimeLogLevel: ctx.account.runtimeLogLevel,
      });

      // Block until OpenClaw aborts. Without this `await`, the Promise
      // returned from `startAccount` resolves the moment the synchronous
      // setup finishes, which OpenClaw interprets as "channel exited" and
      // immediately triggers the auto-restart loop. Awaiting here keeps
      // the channel "alive" for OpenClaw's lifecycle bookkeeping.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      transport.disconnect();
      unregisterTransport(ctx.account.accountId);
    },
  },

  // ─── Outbound (agent → relay → iPhone) ─────────────────────────────────

  outbound: {
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: 4096,
      sanitizeText: ({ text }: { text: string }) => text,
    },
    attachedResults: {
      channel: "chat4000" as const,
      sendText: async (ctx: {
        cfg: { channels?: Record<string, unknown> };
        to: string;
        text: string;
        accountId?: string;
        replyToId?: string;
      }) => {
        const account = resolveChat4000Account({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
        });
        if (!account.configured) {
          throw new Error(`chat4000 not configured for account "${account.accountId}"`);
        }
        const transport = getTransport(account.accountId);
        if (!transport) {
          throw new Error(`No active relay connection for account "${account.accountId}"`);
        }
        const messageId = transport.send({ kind: "text", text: ctx.text });
        return { messageId };
      },
      sendMedia: async (ctx: {
        cfg: { channels?: Record<string, unknown> };
        to: string;
        text: string;
        mediaUrl?: string;
        accountId?: string;
        replyToId?: string;
      }) => {
        // V1: Send media URL as text. V2: upload + inline.
        const account = resolveChat4000Account({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
        });
        if (!account.configured) {
          throw new Error(`chat4000 not configured for account "${account.accountId}"`);
        }
        const transport = getTransport(account.accountId);
        if (!transport) {
          throw new Error(`No active relay connection for account "${account.accountId}"`);
        }
        const messageText = ctx.mediaUrl
          ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}`
          : ctx.text;
        const messageId = transport.send({ kind: "text", text: messageText });
        return { messageId };
      },
    },
  },
};

// ─── Inbound dispatch ───────────────────────────────────────────────────────

type InboundCtx = {
  cfg: { channels?: Record<string, unknown> };
  accountId: string;
  account: ResolvedChat4000Account;
  channelRuntime?: unknown;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
};

async function handleInbound(params: {
  inner: InnerMessage;
  transport: MessageTransport;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
}): Promise<void> {
  const { inner, transport, ctx, runtimeLogger } = params;
  const isFromApp = inner.from?.role === "app";

  // Inner ack frames flow through onReceive but the plugin doesn't act on
  // them in v1 — they would drive a "delivered" indicator if the plugin
  // ever exposed a UI. Logged only.
  if (inner.body.kind === "ack") {
    runtimeLogger.info("runtime.inner_ack_recv", {
      msg_id: inner.id,
      refs: inner.body.refs,
      stage: inner.body.stage,
      from_role: inner.from?.role,
    });
    return;
  }

  // Streaming chunks from another sender; we don't aggregate inbound
  // streams. Nothing to do beyond logging.
  if (inner.body.kind === "textDelta" || inner.body.kind === "textEnd") {
    ctx.log?.debug?.(
      `[${ctx.account.accountId}] Ignoring inbound ${inner.body.kind} from peer`,
    );
    return;
  }

  if (inner.body.kind === "status") {
    ctx.log?.debug?.(
      `[${ctx.account.accountId}] Received peer status: ${inner.body.status}`,
    );
    return;
  }

  if (inner.body.kind === "unknown") {
    runtimeLogger.info("runtime.msg_dropped", {
      msg_id: inner.id,
      reason: "unsupported_inner_type",
      inner_t: inner.body.rawType,
    });
    return;
  }

  // Beyond this point: text / image / audio.
  if (
    inner.body.kind !== "text" &&
    inner.body.kind !== "image" &&
    inner.body.kind !== "audio"
  ) {
    return;
  }

  // Per protocol §6.6.5: emit `received` ack BEFORE running the agent so the
  // app's ✓✓ tick lights up immediately, not after token generation. Only
  // for app-origin frames. Wrapped in try/catch because the transport may
  // already be disconnected if a config-reload tore it down while this
  // inbound was mid-processing.
  if (isFromApp) {
    try {
      transport.send({ kind: "ack", refs: inner.id, stage: "received" });
    } catch (err) {
      runtimeLogger.info("runtime.inner_ack_send_error", {
        msg_id: inner.id,
        error: String(err),
      });
      return;
    }
  }

  if (!ctx.channelRuntime) {
    runtimeLogger.info("runtime.ai_request_error", {
      msg_id: inner.id,
      error: "channelRuntime missing",
    });
    ctx.log?.warn?.(
      `[${ctx.account.accountId}] runtime.dispatch unavailable: channelRuntime missing`,
    );
    return;
  }

  await dispatchToAgent({
    inner: inner as InnerMessage & {
      body: InnerTextBody | InnerImageBody | InnerAudioBody;
    },
    transport,
    ctx,
    runtimeLogger,
  });
}

async function dispatchToAgent(params: {
  inner: InnerMessage & { body: InnerTextBody | InnerImageBody | InnerAudioBody };
  transport: MessageTransport;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
}): Promise<void> {
  const { inner, transport, ctx, runtimeLogger } = params;

  const senderAddress = `chat4000:${ctx.account.groupId}`;
  const recipientAddress = "chat4000:agent";
  const conversationLabel = `chat4000 (${ctx.account.groupId.substring(0, 8)}...)`;

  const runtime = ctx.channelRuntime as {
    routing: {
      resolveAgentRoute: (params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "direct"; id: string };
      }) => { agentId: string; sessionKey: string; accountId?: string };
    };
    session: {
      resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
      readSessionUpdatedAt?: (params: { storePath: string; sessionKey: string }) => number | undefined;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: Record<string, unknown>;
        onRecordError: (err: unknown) => void;
      }) => Promise<void>;
    };
    reply: {
      resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
      formatAgentEnvelope: (params: {
        channel: string;
        from: string;
        body: string;
        timestamp?: number;
        previousTimestamp?: number;
        envelope: unknown;
      }) => string;
      finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: Record<string, unknown>;
        cfg: unknown;
        dispatcherOptions: Record<string, unknown>;
        replyOptions?: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  };

  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "chat4000",
    accountId: ctx.account.accountId,
    peer: { kind: "direct", id: ctx.account.groupId },
  });
  const boundSession = getChat4000SessionBinding({
    accountId: ctx.account.accountId,
    groupId: ctx.account.groupId,
  });
  const targetSessionKey = boundSession?.targetSessionKey ?? route.sessionKey;
  const targetAgentId = boundSession?.agentId ?? route.agentId;
  const storePath =
    boundSession?.storePath ??
    runtime.session.resolveStorePath(
      (ctx.cfg as { session?: { store?: string } }).session?.store,
      { agentId: targetAgentId },
    );

  if (boundSession) {
    runtimeLogger.info("runtime.session_bound", {
      msg_id: inner.id,
      target_session_key: boundSession.targetSessionKey,
      target_agent_id: boundSession.agentId,
    });
  }

  const previousTimestamp = runtime.session.readSessionUpdatedAt?.({
    storePath,
    sessionKey: targetSessionKey,
  });

  const rawBody =
    inner.body.kind === "text"
      ? inner.body.text
      : inner.body.kind === "image"
        ? "[Image]"
        : `[Voice note${inner.body.durationMs > 0 ? ` ${Math.round(inner.body.durationMs / 1000)}s` : ""}]`;

  const body = runtime.reply.formatAgentEnvelope({
    channel: "chat4000",
    from: conversationLabel,
    body: rawBody,
    timestamp: inner.ts,
    previousTimestamp,
    envelope: runtime.reply.resolveEnvelopeFormatOptions(ctx.cfg),
  });

  let mediaPayload: Record<string, unknown> = {};
  if (inner.body.kind === "image" || inner.body.kind === "audio") {
    try {
      const { saveMediaBuffer, buildAgentMediaPayload } = await loadMediaRuntime();
      const saved = await saveMediaBuffer(
        Buffer.from(inner.body.dataBase64, "base64"),
        inner.body.mimeType,
        "inbound",
        undefined,
        `chat4000-${inner.id}`,
      );
      mediaPayload = buildAgentMediaPayload([
        {
          path: saved.path,
          contentType: saved.contentType ?? inner.body.mimeType,
        },
      ]);
      runtimeLogger.info(
        inner.body.kind === "image" ? "runtime.image_forwarded" : "runtime.audio_forwarded",
        {
          msg_id: inner.id,
          mime_type: inner.body.mimeType,
          media_path: saved.path,
          ...(inner.body.kind === "audio" ? { duration_ms: inner.body.durationMs } : {}),
        },
      );
    } catch (error) {
      runtimeLogger.info(
        inner.body.kind === "image" ? "runtime.image_dropped" : "runtime.audio_dropped",
        {
          msg_id: inner.id,
          reason: String(error),
        },
      );
      throw error instanceof Error
        ? error
        : new Error(`chat4000 ${inner.body.kind} save failed: ${String(error)}`);
    }
  }

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: senderAddress,
    To: recipientAddress,
    SessionKey: targetSessionKey,
    AccountId: route.accountId ?? ctx.account.accountId,
    ChatType: "direct",
    ConversationLabel: conversationLabel,
    SenderId: ctx.account.groupId,
    Provider: "chat4000",
    Surface: "chat4000",
    MessageSid: inner.id,
    MessageSidFull: inner.id,
    Timestamp: inner.ts,
    Chat4000FromRole: inner.from?.role,
    Chat4000FromDeviceId: inner.from?.deviceId,
    Chat4000FromDeviceName: inner.from?.deviceName,
    ...(inner.body.kind === "audio" ? { AudioDurationMs: inner.body.durationMs } : {}),
    OriginatingChannel: "chat4000",
    OriginatingTo: senderAddress,
    CommandAuthorized: true,
    ...mediaPayload,
  });

  const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();

  // Reply pipeline state: dispatcher + last-status memo.
  const dispatcher = new StreamDispatcher({
    transport,
    onStreamReset: ({ streamId, abandonedChars }) => {
      runtimeLogger.info("runtime.stream_reset", {
        msg_id: inner.id,
        stream_id: streamId,
        reason: "non-monotonic-partial",
        abandoned_chars: abandonedChars,
      });
    },
  });

  let lastSentStatus: "thinking" | "typing" | "idle" | undefined;
  const sendStatus = (status: "thinking" | "typing" | "idle") => {
    if (lastSentStatus === status) return;
    transport.send({ kind: "status", status });
    lastSentStatus = status;
  };
  const finalizeStreamingState = () => {
    dispatcher.flush();
    sendStatus("idle");
  };

  let finalSent = false;

  runtimeLogger.info("runtime.ai_request_start", {
    msg_id: inner.id,
  });

  const replyPipeline = createChannelReplyPipeline({
    cfg: ctx.cfg,
    agentId: targetAgentId,
    channel: "chat4000",
    accountId: route.accountId ?? ctx.account.accountId,
    typing: {
      start: () => {
        sendStatus("typing");
      },
      onStartError: (err) => {
        runtimeLogger.info("runtime.ai_request_error", {
          msg_id: inner.id,
          error: String(err),
          phase: "typing_start",
        });
      },
    },
  });

  await runtime.session.recordInboundSession({
    storePath,
    sessionKey: targetSessionKey,
    ctx: ctxPayload,
    onRecordError: (error: unknown) => {
      runtimeLogger.info("runtime.ai_request_error", {
        msg_id: inner.id,
        error: String(error),
        phase: "record",
      });
      throw error instanceof Error
        ? error
        : new Error(`chat4000 session record failed: ${String(error)}`);
    },
  });

  await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload: { text?: string }, info: { kind: string }) => {
        if (info.kind !== "final") return;
        const text = payload.text ?? "";
        const result = dispatcher.onFinal(text);
        if (result === "oneshot") {
          // No streaming had occurred but the agent produced final text —
          // ship it as a single `text` frame instead of a streaming pair.
          transport.send({ kind: "text", text });
        }
        if (result === "empty") {
          ctx.log?.debug?.(
            `[${ctx.account.accountId}] runtime.send skipped empty response id=${inner.id}`,
          );
        }
        finalizeStreamingState();
        finalSent = true;
      },
      onError: (error: unknown, info: { kind: string }) => {
        runtimeLogger.info("runtime.ai_request_error", {
          msg_id: inner.id,
          error: String(error),
          phase: info.kind,
        });
        finalizeStreamingState();
      },
    },
    replyOptions: {
      onReasoningStream: async () => {
        sendStatus("thinking");
      },
      onReasoningEnd: async () => {
        sendStatus("typing");
      },
      onAssistantMessageStart: async () => {
        sendStatus("typing");
      },
      onPartialReply: async (payload: { text?: string }) => {
        const text = payload.text ?? "";
        if (!text) return;
        sendStatus("typing");
        dispatcher.onPartial(text);
      },
      onToolStart: async () => {
        sendStatus("thinking");
      },
      onCompactionStart: async () => {
        sendStatus("thinking");
      },
      onCompactionEnd: async () => {
        sendStatus("typing");
      },
    },
  });

  if (!finalSent) {
    finalizeStreamingState();
  }
  dispatcher.dispose();

  runtimeLogger.info("runtime.ai_request_success", {
    msg_id: inner.id,
  });
}
