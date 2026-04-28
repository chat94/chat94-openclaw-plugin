import { randomUUID } from "node:crypto";
import { resolveChat94Account } from "./accounts.js";
import { encrypt } from "./crypto.js";
import { resolveChat94InstanceIdentity } from "./key-store.js";
import { readPackageVersion } from "./package-info.js";
import { RuntimeLogger } from "./runtime-logger.js";
import type {
  InnerMessage,
  InnerMessageFrom,
  InnerMessageType,
  RelayEnvelope,
  ResolvedChat94Account,
} from "./types.js";

export type SendChat94Options = {
  cfg: { channels?: Record<string, unknown> };
  accountId?: string;
  replyToId?: string;
};

export type SendChat94Result = {
  messageId: string;
};

type ActiveSender = {
  send: (envelope: RelayEnvelope) => void;
  groupKeyBytes: Buffer;
  runtimeLogger?: RuntimeLogger;
};

const activeSenders = new Map<string, ActiveSender>();
let cachedPluginFrom: InnerMessageFrom | undefined;

function resolvePluginFrom(): InnerMessageFrom {
  cachedPluginFrom ??= (() => {
    const instance = resolveChat94InstanceIdentity();
    return {
      role: "plugin",
      device_id: instance.deviceId,
      device_name: instance.deviceName,
      app_version: readPackageVersion(),
      bundle_id: "@chat94/openclaw-plugin",
    };
  })();
  return cachedPluginFrom;
}

export function registerSender(
  account: Pick<ResolvedChat94Account, "groupId" | "groupKeyBytes" | "accountId" | "runtimeLogLevel">,
  send: (envelope: RelayEnvelope) => void,
): void {
  activeSenders.set(account.groupId, {
    send,
    groupKeyBytes: Buffer.from(account.groupKeyBytes),
    runtimeLogger: new RuntimeLogger(account.runtimeLogLevel, {
      accountId: account.accountId,
      groupId: account.groupId,
    }),
  });
}

export function unregisterSender(groupId: string): void {
  activeSenders.delete(groupId);
}

function sendInnerMessage(
  groupId: string,
  t: InnerMessageType,
  body: Record<string, unknown>,
  messageId: string = randomUUID(),
  opts?: { notifyIfOffline?: boolean },
): string {
  const active = activeSenders.get(groupId);
  if (!active) {
    throw new Error(`No active relay connection for group "${groupId}"`);
  }

  const innerMessage: InnerMessage = {
    t,
    id: messageId,
    from: resolvePluginFrom(),
    body,
    ts: Date.now(),
  };

  const plaintext = Buffer.from(JSON.stringify(innerMessage), "utf-8");
  const { nonce, ciphertext } = encrypt(plaintext, active.groupKeyBytes);

  active.send({
    version: 1,
    type: "msg",
    payload: {
      msg_id: messageId,
      nonce,
      ciphertext,
      ...(opts?.notifyIfOffline ? { notify_if_offline: true } : {}),
    },
  });
  active.runtimeLogger?.info("runtime.send", {
    type: "msg",
    msg_id: messageId,
    inner_t: t,
    from_role: innerMessage.from?.role,
    from_device_id: innerMessage.from?.device_id,
  });

  return messageId;
}

export async function sendMessageChat94(
  to: string,
  text: string,
  opts: SendChat94Options,
): Promise<SendChat94Result> {
  const account = resolveChat94Account({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(`chat94 not configured for account "${account.accountId}"`);
  }

  const messageId = sendInnerMessage(account.groupId, "text", { text }, undefined, {
    notifyIfOffline: true,
  });
  return { messageId };
}

export function sendStreamDelta(groupId: string, streamId: string, delta: string): void {
  sendInnerMessage(groupId, "text_delta", { delta }, streamId);
}

export function sendStreamEnd(groupId: string, streamId: string, fullText: string): void {
  sendInnerMessage(groupId, "text_end", { text: fullText }, streamId);
}

export function sendStatus(groupId: string, status: "thinking" | "typing" | "idle"): void {
  const messageId = sendInnerMessage(groupId, "status", { status });
  activeSenders.get(groupId)?.runtimeLogger?.info("runtime.send", {
    type: "status",
    msg_id: messageId,
    status,
  });
}
