import { describe, it, expect } from "vitest";
import { chat94Plugin } from "../../src/channel.js";

describe("channel plugin", () => {
  const groupKey = Buffer.alloc(32, 0x41).toString("base64url");

  it("has correct id", () => {
    expect(chat94Plugin.id).toBe("chat94");
  });

  it("meta has required fields", () => {
    expect(chat94Plugin.meta.label).toBe("chat94");
    expect(chat94Plugin.meta.markdownCapable).toBe(true);
    expect(chat94Plugin.meta.capabilities.chatTypes).toContain("direct");
  });

  it("capabilities include media and reactions", () => {
    expect(chat94Plugin.meta.capabilities.media).toBe(true);
    expect(chat94Plugin.meta.capabilities.reactions).toBe(true);
    expect(chat94Plugin.meta.capabilities.effects).toBe(true);
  });

  it("config.isConfigured returns false for unconfigured", () => {
    const account = chat94Plugin.config.resolveAccount({});
    expect(chat94Plugin.config.isConfigured(account)).toBe(false);
  });

  it("config hooks tolerate missing cfg during host probes", () => {
    expect(chat94Plugin.config.listAccountIds()).toEqual(["default"]);
    expect(chat94Plugin.config.defaultAccountId()).toBe("default");
    expect(chat94Plugin.config.resolveAccount()).toMatchObject({
      accountId: "default",
      configured: false,
    });
  });

  it("config.isConfigured returns true when configured", () => {
    const account = chat94Plugin.config.resolveAccount({
      channels: {
        chat94: { groupKey },
      },
    });
    expect(chat94Plugin.config.isConfigured(account)).toBe(true);
  });

  it("config.describeAccount shows truncated groupId", () => {
    const account = chat94Plugin.config.resolveAccount({
      channels: {
        chat94: { groupKey },
      },
    });
    const desc = chat94Plugin.config.describeAccount(account);
    expect(desc.name).toContain(`${account.groupId.substring(0, 8)}...`);
    expect(desc.configured).toBe(true);
    expect(desc.extra.groupId).toBe(account.groupId);
  });

  it("outbound base has correct delivery mode", () => {
    expect(chat94Plugin.outbound.base.deliveryMode).toBe("direct");
    expect(chat94Plugin.outbound.base.textChunkLimit).toBe(4096);
  });

  it("outbound channel is chat94", () => {
    expect(chat94Plugin.outbound.attachedResults.channel).toBe("chat94");
  });

  it("gateway.startAccount throws if not configured", async () => {
    const account = chat94Plugin.config.resolveAccount({});
    await expect(
      chat94Plugin.gateway.startAccount({
        cfg: {},
        accountId: "default",
        account,
        abortSignal: AbortSignal.timeout(100),
        setStatus: () => {},
      }),
    ).rejects.toThrow("not configured");
  });
});
