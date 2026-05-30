/**
 * chat4000 Channel Plugin for OpenClaw (v2 — Matrix).
 *
 * Routes messages between an OpenClaw agent and chat4000 iOS/macOS apps over a
 * Matrix homeserver (Tuwunel). The plugin runs as a Matrix bot participant:
 *
 *   - `gateway.startAccount` brings up a `MatrixClientHandle` (sync + E2E crypto)
 *     and dispatches inbound room messages to the agent.
 *   - Replies stream back as a single Matrix message that refines itself via
 *     `m.replace` edits (`MatrixDraftStream`), settling to a final edit.
 *   - `outbound` sends agent-initiated text into the bound room.
 *
 * The agent-dispatch pipeline (route → record → reply pipeline) is unchanged
 * from v1; only the transport sink moved from the custom relay to Matrix.
 */
import {
  getDefaultChat4000AccountId,
  hasConfiguredState,
  listChat4000AccountIds,
  resolveChat4000Account,
} from "./accounts.js";
import { getHandle, registerHandle, unregisterHandle } from "./channel-runtime.js";
import { MatrixClientHandle } from "./matrix/client.js";
import { sendText as matrixSendText, sendTyping } from "./matrix/send.js";
import { MatrixDraftStream } from "./matrix/streaming.js";
import type { MatrixInboundMessage } from "./matrix/types.js";
import { RuntimeLogger } from "./runtime-logger.js";
import { getChat4000SessionBinding } from "./session-binding.js";
import type { ResolvedChat4000Account } from "./types.js";

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
      }) => { typingCallbacks?: unknown };
    }>
  | undefined;

async function loadReplyPipelineRuntime() {
  replyPipelinePromise ??= import("openclaw/plugin-sdk/channel-reply-pipeline").then((mod) => ({
    createChannelReplyPipeline: mod.createChannelReplyPipeline,
  }));
  return await replyPipelinePromise;
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
    hasConfiguredState: ({ env }: { env?: Record<string, string> }) => hasConfiguredState(env),

    listAccountIds: (cfg?: { channels?: Record<string, unknown> }) => listChat4000AccountIds(cfg),

    defaultAccountId: (cfg?: { channels?: Record<string, unknown> }) =>
      getDefaultChat4000AccountId(cfg),

    isConfigured: (account: ResolvedChat4000Account) => account.configured,

    resolveAccount: (cfg?: { channels?: Record<string, unknown> }, accountId?: string | null) =>
      resolveChat4000Account({ cfg, accountId }),

    inspectAccount: (cfg?: { channels?: Record<string, unknown> }, accountId?: string | null) => {
      const account = resolveChat4000Account({ cfg, accountId });
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        userId: account.userId || "(missing)",
        homeserver: account.homeserver || "(missing)",
        credentialStatus: account.configured
          ? `available (${account.credentialSource})`
          : "missing",
      };
    },

    describeAccount: (account: ResolvedChat4000Account) => ({
      name: account.userId ? `chat4000 (${account.userId})` : "chat4000",
      configured: account.configured,
      enabled: account.enabled,
      extra: { homeserver: account.homeserver, userId: account.userId },
    }),
  },

  // ─── Gateway (Matrix client lifecycle + agent dispatch) ─────────────────

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
            `Run "openclaw chat4000 setup" to provision a Matrix identity and pair.`,
        );
      }

      ctx.log?.info?.(`[${ctx.account.accountId}] Starting chat4000 (Matrix) channel`);
      const runtimeLogger = new RuntimeLogger(ctx.account.runtimeLogLevel, {
        accountId: ctx.account.accountId,
        groupId: ctx.account.userId,
      });

      const setConnected = (connected: boolean) =>
        ctx.setStatus({
          accountId: ctx.account.accountId,
          name: `chat4000 (${ctx.account.userId})`,
          enabled: true,
          configured: true,
          extra: { connected, homeserver: ctx.account.homeserver },
        });

      const handle = await MatrixClientHandle.create({
        accountId: ctx.account.accountId,
        credentials: {
          homeserver: ctx.account.homeserver,
          userId: ctx.account.userId,
          accessToken: ctx.account.accessToken,
          deviceId: ctx.account.deviceId,
          pluginId: ctx.account.pluginId,
        },
        initialSyncLimit: ctx.account.config.initialSyncLimit,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        onConnectionState: (state) => {
          if (state === "connected") {
            ctx.log?.info?.(`[${ctx.account.accountId}] Connected to ${ctx.account.homeserver}`);
            runtimeLogger.info("runtime.hello_ok", { homeserver: ctx.account.homeserver });
            setConnected(true);
          } else if (state === "reconnecting") {
            ctx.log?.info?.(`[${ctx.account.accountId}] Reconnecting...`);
            setConnected(false);
          } else if (state === "disconnected") {
            setConnected(false);
          } else if (typeof state === "object" && state.kind === "failed") {
            ctx.log?.error?.(`[${ctx.account.accountId}] Matrix failed: ${state.reason}`);
            setConnected(false);
          }
        },
        onMessage: (message) => {
          void handleInbound({ message, handle, ctx, runtimeLogger });
        },
      });

      registerHandle(ctx.account.accountId, handle);
      await handle.start();

      // Keep the channel alive for OpenClaw's lifecycle bookkeeping until abort.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      await handle.stop();
      unregisterHandle(ctx.account.accountId);
    },
  },

  // ─── Outbound (agent → Matrix room) ─────────────────────────────────────

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
      }) => {
        const account = resolveChat4000Account({ cfg: ctx.cfg, accountId: ctx.accountId });
        const handle = getHandle(account.accountId);
        if (!handle) {
          throw new Error(`No active Matrix connection for account "${account.accountId}"`);
        }
        const roomId = stripTargetPrefix(ctx.to);
        const messageId = await matrixSendText(handle.client, roomId, ctx.text);
        return { messageId };
      },
      sendMedia: async (ctx: {
        cfg: { channels?: Record<string, unknown> };
        to: string;
        text: string;
        mediaUrl?: string;
        accountId?: string;
      }) => {
        // V2 interim: send media as a URL in text. Native mxc upload is a follow-up.
        const account = resolveChat4000Account({ cfg: ctx.cfg, accountId: ctx.accountId });
        const handle = getHandle(account.accountId);
        if (!handle) {
          throw new Error(`No active Matrix connection for account "${account.accountId}"`);
        }
        const roomId = stripTargetPrefix(ctx.to);
        const text = ctx.mediaUrl ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}` : ctx.text;
        const messageId = await matrixSendText(handle.client, roomId, text);
        return { messageId };
      },
    },
  },
};

function stripTargetPrefix(to: string): string {
  // Accept "chat4000:!room:hs", "room:!room:hs", or a bare room id.
  return to.replace(/^chat4000:/i, "").replace(/^room:/i, "");
}

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
  message: MatrixInboundMessage;
  handle: MatrixClientHandle;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
}): Promise<void> {
  const { message, handle, ctx, runtimeLogger } = params;

  if (message.body.kind !== "text") {
    // Media inbound currently arrives as a text placeholder from inbound.ts.
    return;
  }

  // Flow-B ack: send a read receipt as soon as we accept the message, before the
  // agent runs, so the app's delivered/read indicator lights up promptly.
  void handle.sendReadReceipt(message.roomId, message.eventId);

  if (!ctx.channelRuntime) {
    runtimeLogger.info("runtime.ai_request_error", {
      msg_id: message.eventId,
      error: "channelRuntime missing",
    });
    return;
  }

  await dispatchToAgent({
    message: message as MatrixInboundMessage & { body: { kind: "text"; text: string } },
    handle,
    ctx,
    runtimeLogger,
  });
}

async function dispatchToAgent(params: {
  message: MatrixInboundMessage & { body: { kind: "text"; text: string } };
  handle: MatrixClientHandle;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
}): Promise<void> {
  const { message, handle, ctx, runtimeLogger } = params;
  const roomId = message.roomId;

  const senderAddress = `chat4000:${roomId}`;
  const recipientAddress = "chat4000:agent";
  const conversationLabel = message.senderDisplayName
    ? `chat4000 (${message.senderDisplayName})`
    : `chat4000 (${roomId.substring(0, 12)}...)`;

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
    peer: { kind: "direct", id: roomId },
  });
  const boundSession = getChat4000SessionBinding({
    accountId: ctx.account.accountId,
    groupId: roomId,
  });
  const targetSessionKey = boundSession?.targetSessionKey ?? route.sessionKey;
  const targetAgentId = boundSession?.agentId ?? route.agentId;
  const storePath =
    boundSession?.storePath ??
    runtime.session.resolveStorePath(
      (ctx.cfg as { session?: { store?: string } }).session?.store,
      { agentId: targetAgentId },
    );

  const previousTimestamp = runtime.session.readSessionUpdatedAt?.({
    storePath,
    sessionKey: targetSessionKey,
  });

  const rawBody = message.body.text;
  const body = runtime.reply.formatAgentEnvelope({
    channel: "chat4000",
    from: conversationLabel,
    body: rawBody,
    timestamp: message.ts,
    previousTimestamp,
    envelope: runtime.reply.resolveEnvelopeFormatOptions(ctx.cfg),
  });

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
    SenderId: message.senderId,
    Provider: "chat4000",
    Surface: "chat4000",
    MessageSid: message.eventId,
    MessageSidFull: message.eventId,
    Timestamp: message.ts,
    Chat4000RoomId: roomId,
    Chat4000SenderId: message.senderId,
    OriginatingChannel: "chat4000",
    OriginatingTo: senderAddress,
    CommandAuthorized: true,
  });

  const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();

  const draft = new MatrixDraftStream({
    client: handle.client,
    roomId,
    log: (m) => runtimeLogger.debug("runtime.draft_stream", { msg_id: message.eventId, detail: m }),
  });

  let lastTyping: boolean | undefined;
  const setTyping = (on: boolean) => {
    if (lastTyping === on) return;
    lastTyping = on;
    void sendTyping(handle.client, roomId, on);
  };

  runtimeLogger.info("runtime.ai_request_start", { msg_id: message.eventId });

  const replyPipeline = createChannelReplyPipeline({
    cfg: ctx.cfg,
    agentId: targetAgentId,
    channel: "chat4000",
    accountId: route.accountId ?? ctx.account.accountId,
    typing: {
      start: () => setTyping(true),
      onStartError: (err) => {
        runtimeLogger.info("runtime.ai_request_error", {
          msg_id: message.eventId,
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
        msg_id: message.eventId,
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
        if (text.trim().length > 0) {
          await draft.finalize(text);
        }
        draft.reset();
        setTyping(false);
      },
      onError: (error: unknown, info: { kind: string }) => {
        runtimeLogger.info("runtime.ai_request_error", {
          msg_id: message.eventId,
          error: String(error),
          phase: info.kind,
        });
        setTyping(false);
      },
    },
    replyOptions: {
      onReasoningStream: async () => setTyping(true),
      onAssistantMessageStart: async () => setTyping(true),
      onPartialReply: async (payload: { text?: string }) => {
        const text = payload.text ?? "";
        if (!text) return;
        setTyping(true);
        draft.update(text);
      },
      onToolStart: async () => setTyping(true),
    },
  });

  await draft.dispose();
  setTyping(false);
  runtimeLogger.info("runtime.ai_request_success", { msg_id: message.eventId });
}
