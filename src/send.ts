import { randomUUID } from "node:crypto";
import { resolveChat4000Account } from "./accounts.js";
import { encrypt } from "./crypto.js";
import { resolveChat4000InstanceIdentity } from "./key-store.js";
import { readPackageVersion } from "./package-info.js";
import { RuntimeLogger } from "./runtime-logger.js";
import type {
  InnerMessage,
  InnerMessageFrom,
  InnerMessageType,
  RelayEnvelope,
  ResolvedChat4000Account,
} from "./types.js";

export type SendChat4000Options = {
  cfg: { channels?: Record<string, unknown> };
  accountId?: string;
  replyToId?: string;
};

export type SendChat4000Result = {
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
    const instance = resolveChat4000InstanceIdentity();
    return {
      role: "plugin",
      device_id: instance.deviceId,
      device_name: instance.deviceName,
      app_version: readPackageVersion(),
      bundle_id: "@chat4000/openclaw-plugin",
    };
  })();
  return cachedPluginFrom;
}

export function registerSender(
  account: Pick<ResolvedChat4000Account, "groupId" | "groupKeyBytes" | "accountId" | "runtimeLogLevel">,
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

async function sendInnerMessage(
  groupId: string,
  t: InnerMessageType,
  body: Record<string, unknown>,
  messageId: string = randomUUID(),
  opts?: { notifyIfOffline?: boolean },
): Promise<string> {
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
  const { nonce, ciphertext } = await encrypt(plaintext, active.groupKeyBytes);

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
    notify_if_offline: opts?.notifyIfOffline ? true : false,
    ...(typeof body.reset === "boolean" ? { reset: body.reset } : {}),
  });

  return messageId;
}

export async function sendMessageChat4000(
  to: string,
  text: string,
  opts: SendChat4000Options,
): Promise<SendChat4000Result> {
  const account = resolveChat4000Account({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(`chat4000 not configured for account "${account.accountId}"`);
  }

  const messageId = await sendInnerMessage(account.groupId, "text", { text }, undefined, {
    notifyIfOffline: true,
  });
  return { messageId };
}

export async function sendStreamDelta(
  groupId: string,
  streamId: string,
  delta: string,
): Promise<void> {
  await sendInnerMessage(groupId, "text_delta", { delta }, streamId);
}

export async function sendStreamEnd(
  groupId: string,
  streamId: string,
  fullText: string,
  opts?: { notifyIfOffline?: boolean; reset?: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { text: fullText };
  if (opts?.reset) {
    body.reset = true;
  }
  await sendInnerMessage(groupId, "text_end", body, streamId, opts);
}

export async function sendStatus(
  groupId: string,
  status: "thinking" | "typing" | "idle",
): Promise<void> {
  const messageId = await sendInnerMessage(groupId, "status", { status });
  activeSenders.get(groupId)?.runtimeLogger?.info("runtime.send", {
    type: "status",
    msg_id: messageId,
    status,
  });
}
