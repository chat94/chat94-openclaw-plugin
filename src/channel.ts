/**
 * chat4000 Channel Plugin for OpenClaw.
 *
 * This plugin connects to a chat4000 relay server via WebSocket,
 * routing E2E encrypted messages between the OpenClaw agent and
 * chat4000 iOS/macOS apps.
 *
 * Pattern follows IRC and Mattermost plugins.
 */

import {
  resolveChat4000Account,
  hasConfiguredState,
  listChat4000AccountIds,
  getDefaultChat4000AccountId,
} from "./accounts.js";
import { getChat4000SessionBinding } from "./session-binding.js";
import type { ResolvedChat4000Account, Chat4000Probe } from "./types.js";
import { RuntimeLogger } from "./runtime-logger.js";
import { randomUUID } from "node:crypto";

const STREAM_FLUSH_MIN_CHARS = 200;
const STREAM_FLUSH_DELAY_MS = 100;
const DEFERRED_DELIVERY_RECOVERY_INTERVAL_MS = 5_000;
const CHAT4000_TARGET_PREFIX = "chat4000:";

function stripChat4000Prefix(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase().startsWith(CHAT4000_TARGET_PREFIX)
    ? trimmed.slice(CHAT4000_TARGET_PREFIX.length) || undefined
    : trimmed;
}

// Lazy-load runtime to avoid pulling in WebSocket/crypto on import
let channelRuntimePromise: Promise<typeof import("./channel-runtime.js")> | undefined;
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

async function loadChannelRuntime() {
  channelRuntimePromise ??= import("./channel-runtime.js");
  return await channelRuntimePromise;
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
// This would use createChatChannelPlugin() from openclaw/plugin-sdk/channel-core
// but since we're building standalone for now, we export the raw structure.

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
      effects: true, // typing indicators
      blockStreaming: false,
    },
    reload: {
      configPrefixes: ["channels.chat4000"],
    },
  },

  conversationBindings: {
    supportsCurrentConversationBinding: true,
    defaultTopLevelPlacement: "current" as const,
  },

  messaging: {
    resolveInboundConversation: ({
      to,
      groupId,
      conversationId,
      threadId,
    }: {
      to?: string | null;
      groupId?: string | null;
      conversationId?: string | null;
      threadId?: string | null;
    }) => {
      const id = stripChat4000Prefix(threadId)
        ?? stripChat4000Prefix(to)
        ?? stripChat4000Prefix(conversationId)
        ?? stripChat4000Prefix(groupId);
      return id ? { conversationId: id } : null;
    },
  },

  bindings: {
    resolveCommandConversation: ({
      originatingTo,
      commandTo,
      fallbackTo,
    }: {
      originatingTo?: string | null;
      commandTo?: string | null;
      fallbackTo?: string | null;
    }) => {
      const id = stripChat4000Prefix(originatingTo)
        ?? stripChat4000Prefix(commandTo)
        ?? stripChat4000Prefix(fallbackTo);
      return id ? { conversationId: id } : null;
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

  // ─── Gateway (WebSocket connection to relay) ────────────────────────────

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
          `Run "openclaw chat4000 setup" to create the local key and finish setup.`
        );
      }

      ctx.log?.info?.(`[${ctx.account.accountId}] Starting chat4000 channel`);
      const runtimeLogger = new RuntimeLogger(ctx.account.runtimeLogLevel, {
        accountId: ctx.account.accountId,
        groupId: ctx.account.groupId,
      });

      const {
        monitorChat4000Provider,
        recoverQueuedChat4000Deliveries,
        registerSender,
        unregisterSender,
      } = await loadChannelRuntime();

      let deferredDeliveryRecoveryTimer: NodeJS.Timeout | undefined;

      const stopDeferredDeliveryRecovery = () => {
        if (!deferredDeliveryRecoveryTimer) {
          return;
        }
        clearInterval(deferredDeliveryRecoveryTimer);
        deferredDeliveryRecoveryTimer = undefined;
      };

      const runDeferredDeliveryRecovery = async () => {
        try {
          await recoverQueuedChat4000Deliveries({
            cfg: ctx.cfg,
            accountId: ctx.account.accountId,
            groupId: ctx.account.groupId,
            log: ctx.log,
          });
        } catch (error) {
          ctx.log?.warn?.(
            `[${ctx.account.accountId}] queued chat4000 delivery recovery failed: ${String(error)}`,
          );
        }
      };

      await monitorChat4000Provider({
        accountId: ctx.account.accountId,
        config: ctx.cfg,
        abortSignal: ctx.abortSignal,
        onConnected: (send) => {
          registerSender(ctx.account, send);
          stopDeferredDeliveryRecovery();
          void runDeferredDeliveryRecovery();
          deferredDeliveryRecoveryTimer = setInterval(() => {
            void runDeferredDeliveryRecovery();
          }, DEFERRED_DELIVERY_RECOVERY_INTERVAL_MS);
          ctx.setStatus({
            accountId: ctx.account.accountId,
            name: `chat4000 (${ctx.account.groupId.substring(0, 8)}...)`,
            enabled: true,
            configured: true,
            extra: { connected: true },
          });
        },
        onDisconnected: () => {
          stopDeferredDeliveryRecovery();
          unregisterSender(ctx.account.groupId);
          ctx.setStatus({
            accountId: ctx.account.accountId,
            name: `chat4000 (${ctx.account.groupId.substring(0, 8)}...)`,
            enabled: true,
            configured: true,
            extra: { connected: false },
          });
        },
        onMessage: async (message) => {
          if (!ctx.channelRuntime) {
            runtimeLogger.info("runtime.ai_request_error", {
              msg_id: message.messageId,
              error: "channelRuntime missing",
            });
            ctx.log?.warn?.(
              `[${ctx.account.accountId}] runtime.dispatch unavailable: channelRuntime missing`,
            );
            return;
          }

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
              msg_id: message.messageId,
              target_session_key: boundSession.targetSessionKey,
              target_agent_id: boundSession.agentId,
            });
          }
          const previousTimestamp = runtime.session.readSessionUpdatedAt?.({
            storePath,
            sessionKey: targetSessionKey,
          });
          const rawBody =
            message.innerType === "text"
              ? message.text
              : message.innerType === "image"
                ? "[Image]"
                : `[Voice note${message.durationMs > 0 ? ` ${Math.round(message.durationMs / 1000)}s` : ""}]`;
          const body = runtime.reply.formatAgentEnvelope({
            channel: "chat4000",
            from: conversationLabel,
            body: rawBody,
            timestamp: message.timestamp,
            previousTimestamp,
            envelope: runtime.reply.resolveEnvelopeFormatOptions(ctx.cfg),
          });
          let mediaPayload: Record<string, unknown> = {};
          if (message.innerType === "image" || message.innerType === "audio") {
            try {
              const { saveMediaBuffer, buildAgentMediaPayload } = await loadMediaRuntime();
              const saved = await saveMediaBuffer(
                Buffer.from(message.dataBase64, "base64"),
                message.mimeType,
                "inbound",
                undefined,
                `chat4000-${message.messageId}`,
              );
              mediaPayload = buildAgentMediaPayload([
                {
                  path: saved.path,
                  contentType: saved.contentType ?? message.mimeType,
                },
              ]);
              runtimeLogger.info(message.innerType === "image" ? "runtime.image_forwarded" : "runtime.audio_forwarded", {
                msg_id: message.messageId,
                mime_type: message.mimeType,
                media_path: saved.path,
                ...(message.innerType === "audio" ? { duration_ms: message.durationMs } : {}),
              });
            } catch (error) {
              runtimeLogger.info(message.innerType === "image" ? "runtime.image_dropped" : "runtime.audio_dropped", {
                msg_id: message.messageId,
                reason: String(error),
              });
              throw error instanceof Error
                ? error
                : new Error(`chat4000 ${message.innerType} save failed: ${String(error)}`);
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
            MessageSid: message.messageId,
            MessageSidFull: message.messageId,
            Timestamp: message.timestamp,
            Chat4000FromRole: message.from?.role,
            Chat4000FromDeviceId: message.from?.device_id,
            Chat4000FromDeviceName: message.from?.device_name,
            ...(message.innerType === "audio" ? { AudioDurationMs: message.durationMs } : {}),
            OriginatingChannel: "chat4000",
            OriginatingTo: senderAddress,
            CommandAuthorized: true,
            ...mediaPayload,
          });
          const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();
          let streamId = randomUUID();
          let streamActive = false;
          let finalSent = false;
          let lastText = "";
          let lastPartialText = "";
          let streamBuffer = "";
          let firstStreamChunkSent = false;
          let flushTimer: NodeJS.Timeout | undefined;
          let lastSentStatus: "thinking" | "typing" | "idle" | undefined;

          runtimeLogger.info("runtime.ai_request_start", {
            msg_id: message.messageId,
          });

          const {
            sendMessageChat4000,
            sendStatus,
            sendStreamDelta,
            sendStreamEnd,
          } = await loadChannelRuntime();

          const clearFlushTimer = () => {
            if (!flushTimer) {
              return;
            }
            clearTimeout(flushTimer);
            flushTimer = undefined;
          };

          const sendTypingState = () => {
            if (lastSentStatus === "typing") {
              return;
            }
            sendStatus(ctx.account.groupId, "typing");
            lastSentStatus = "typing";
          };

          const sendThinkingState = () => {
            if (lastSentStatus === "thinking") {
              return;
            }
            sendStatus(ctx.account.groupId, "thinking");
            lastSentStatus = "thinking";
          };

          const flushBufferedStream = () => {
            if (!streamBuffer) {
              clearFlushTimer();
              return;
            }
            const delta = streamBuffer;
            streamBuffer = "";
            clearFlushTimer();
            streamActive = true;
            lastText += delta;
            sendStreamDelta(ctx.account.groupId, streamId, delta);
          };

          const resetStreamForRewrite = (nextText: string) => {
            clearFlushTimer();
            streamBuffer = "";
            if (streamActive && lastText.length > 0) {
              sendStreamEnd(ctx.account.groupId, streamId, lastText, { reset: true });
            }
            streamId = randomUUID();
            streamActive = false;
            lastText = "";
            firstStreamChunkSent = false;
            if (nextText) {
              queueStreamDelta(nextText);
            }
          };

          const queueStreamDelta = (text: string) => {
            if (!text) {
              return;
            }
            sendTypingState();
            if (!firstStreamChunkSent) {
              firstStreamChunkSent = true;
              streamActive = true;
              lastText += text;
              sendStreamDelta(ctx.account.groupId, streamId, text);
              return;
            }

            streamBuffer += text;
            if (streamBuffer.length >= STREAM_FLUSH_MIN_CHARS) {
              flushBufferedStream();
              return;
            }
            if (!flushTimer) {
              flushTimer = setTimeout(() => {
                flushBufferedStream();
              }, STREAM_FLUSH_DELAY_MS);
            }
          };

          const finalizeStreamingState = () => {
            clearFlushTimer();
            sendStatus(ctx.account.groupId, "idle");
            lastSentStatus = "idle";
          };

          const replyPipeline = createChannelReplyPipeline({
            cfg: ctx.cfg,
            agentId: targetAgentId,
            channel: "chat4000",
            accountId: route.accountId ?? ctx.account.accountId,
            typing: {
              start: () => {
                sendTypingState();
              },
              onStartError: (err) => {
                runtimeLogger.info("runtime.ai_request_error", {
                  msg_id: message.messageId,
                  error: String(err),
                  phase: "typing_start",
                });
              },
            },
          });

          await runtime.session.recordInboundSession({
            storePath,
            sessionKey: (ctxPayload.SessionKey as string | undefined) ?? targetSessionKey,
            ctx: ctxPayload,
            onRecordError: (error: unknown) => {
              runtimeLogger.info("runtime.ai_request_error", {
                msg_id: message.messageId,
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
                const text = payload.text ?? "";
                if (info.kind !== "final") {
                  return;
                }

                if (streamActive) {
                  flushBufferedStream();
                  const finalText = text || lastText;
                  if (finalText.length > 0) {
                    sendStreamEnd(ctx.account.groupId, streamId, finalText, {
                      notifyIfOffline: true,
                    });
                  }
                  finalizeStreamingState();
                  finalSent = true;
                  return;
                }

                if (!text.trim()) {
                  ctx.log?.debug?.(
                    `[${ctx.account.accountId}] runtime.send skipped empty response id=${message.messageId}`,
                  );
                  finalizeStreamingState();
                  finalSent = true;
                  return;
                }

                await sendMessageChat4000(senderAddress, text, {
                  cfg: ctx.cfg,
                  accountId: ctx.account.accountId,
                  replyToId: message.messageId,
                });
                finalizeStreamingState();
                finalSent = true;
              },
              onError: (error: unknown, info: { kind: string }) => {
                runtimeLogger.info("runtime.ai_request_error", {
                  msg_id: message.messageId,
                  error: String(error),
                  phase: info.kind,
                });
                finalizeStreamingState();
              },
            },
            replyOptions: {
              onReasoningStream: async () => {
                sendThinkingState();
              },
              onReasoningEnd: async () => {
                sendTypingState();
              },
              onAssistantMessageStart: async () => {
                sendTypingState();
              },
              onPartialReply: async (payload: { text?: string }) => {
                const text = payload.text ?? "";
                if (!text) {
                  return;
                }
                if (!lastPartialText) {
                  lastPartialText = text;
                  queueStreamDelta(text);
                  return;
                }
                if (text === lastPartialText) {
                  return;
                }
                if (text.startsWith(lastPartialText)) {
                  const delta = text.slice(lastPartialText.length);
                  lastPartialText = text;
                  queueStreamDelta(delta);
                  return;
                }
                lastPartialText = text;
                resetStreamForRewrite(text);
              },
              onToolStart: async () => {
                sendThinkingState();
              },
              onCompactionStart: async () => {
                sendThinkingState();
              },
              onCompactionEnd: async () => {
                sendTypingState();
              },
            },
          });

          if (!finalSent) {
            finalizeStreamingState();
          }

          runtimeLogger.info("runtime.ai_request_success", {
            msg_id: message.messageId,
          });
        },
        log: ctx.log as MonitorOptions["log"],
      });

      stopDeferredDeliveryRecovery();
    },
  },

  // ─── Outbound (agent response → relay → iPhone) ────────────────────────

  outbound: {
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: 4096, // Generous — relay handles up to 64KB
      sanitizeText: ({ text }: { text: string }) => text, // No sanitization needed (app handles rendering)
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
        const { sendMessageChat4000 } = await loadChannelRuntime();
        return await sendMessageChat4000(ctx.to, ctx.text, {
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          replyToId: ctx.replyToId,
        });
      },
      sendMedia: async (ctx: {
        cfg: { channels?: Record<string, unknown> };
        to: string;
        text: string;
        mediaUrl?: string;
        accountId?: string;
        replyToId?: string;
      }) => {
        // V1: Send media URL as text. V2: Upload and send inline.
        const { sendMessageChat4000 } = await loadChannelRuntime();
        const messageText = ctx.mediaUrl
          ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}`
          : ctx.text;
        return await sendMessageChat4000(ctx.to, messageText, {
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          replyToId: ctx.replyToId,
        });
      },
    },
  },
};

// Type import for monitor options
type MonitorOptions = Parameters<
  Awaited<ReturnType<typeof loadChannelRuntime>>["monitorChat4000Provider"]
>[0];
