import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerSender,
  unregisterSender,
  sendMessageChat4000,
  sendStatus,
  sendStreamDelta,
  sendStreamEnd,
} from "../../src/send.js";
import { decrypt, deriveGroupId } from "../../src/crypto.js";
import type { InnerMessage, RelayEnvelope, ResolvedChat4000Account } from "../../src/types.js";

describe("send", () => {
  const sentMessages: RelayEnvelope[] = [];
  const groupKeyBytes = Buffer.alloc(32, 0x71);
  const groupKey = groupKeyBytes.toString("base64url");
  const groupId = deriveGroupId(groupKeyBytes);
  const account: Pick<ResolvedChat4000Account, "groupId" | "groupKeyBytes" | "accountId" | "runtimeLogLevel"> = {
    accountId: "default",
    groupId,
    groupKeyBytes,
    runtimeLogLevel: "info",
  };

  function parseInnerMessage(envelope: RelayEnvelope): InnerMessage {
    const payload = envelope.payload as { nonce: string; ciphertext: string };
    const plaintext = decrypt(payload.nonce, payload.ciphertext, groupKeyBytes);
    expect(plaintext).not.toBeNull();
    return JSON.parse(plaintext!.toString("utf-8")) as InnerMessage;
  }

  beforeEach(() => {
    sentMessages.length = 0;
    registerSender(account, (env) => sentMessages.push(env));
  });

  afterEach(() => {
    unregisterSender(groupId);
  });

  it("sends encrypted text message with inner format", async () => {
    const result = await sendMessageChat4000(`chat4000:${groupId}`, "hello agent", {
      cfg: {
        channels: {
          chat4000: { groupKey },
        },
      },
    });

    expect(result.messageId).toBeTruthy();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.type).toBe("msg");
    expect(sentMessages[0]!.payload.notify_if_offline).toBe(true);

    const inner = parseInnerMessage(sentMessages[0]!);
    expect(inner.t).toBe("text");
    expect(inner.id).toBe(result.messageId);
    expect(inner.body).toEqual({ text: "hello agent" });
    expect(inner.from).toMatchObject({
      role: "plugin",
      app_version: "1.1.2",
      bundle_id: "@chat4000/openclaw-plugin",
    });
    expect(typeof inner.ts).toBe("number");
  });

  it("encrypts before sending", async () => {
    await sendMessageChat4000("to", "secret text", {
      cfg: { channels: { chat4000: { groupKey } } },
    });

    const ct = sentMessages[0]!.payload.ciphertext as string;
    expect(ct).not.toContain("secret text");
  });

  it("sends stream delta", () => {
    sendStreamDelta(groupId, "stream-1", "delta");
    expect(sentMessages[0]!.payload.notify_if_offline).toBeUndefined();
    const inner = parseInnerMessage(sentMessages[0]!);
    expect(inner).toMatchObject({
      t: "text_delta",
      id: "stream-1",
      body: { delta: "delta" },
    });
  });

  it("sends stream end with notify_if_offline=true (final agent-reply frame)", () => {
    sendStreamEnd(groupId, "stream-1", "full text");
    expect(sentMessages[0]!.payload.notify_if_offline).toBe(true);
    const inner = parseInnerMessage(sentMessages[0]!);
    expect(inner).toMatchObject({
      t: "text_end",
      id: "stream-1",
      body: { text: "full text" },
    });
  });

  it("sends status", () => {
    sendStatus(groupId, "thinking");
    expect(sentMessages[0]!.payload.notify_if_offline).toBeUndefined();
    const inner = parseInnerMessage(sentMessages[0]!);
    expect(inner.t).toBe("status");
    expect(inner.body).toEqual({ status: "thinking" });
  });

  it("send without active connection throws", async () => {
    unregisterSender(groupId);
    await expect(
      sendMessageChat4000("to", "text", {
        cfg: { channels: { chat4000: { groupKey } } },
      }),
    ).rejects.toThrow("No active relay connection");
  });

  it("send with unconfigured account throws", async () => {
    await expect(
      sendMessageChat4000("to", "text", {
        cfg: { channels: { chat4000: {} } },
      }),
    ).rejects.toThrow("not configured");
  });
});
