import { describe, it, expect } from "vitest";
import { chat4000Plugin } from "../../src/channel.js";

describe("channel plugin", () => {
  const groupKey = Buffer.alloc(32, 0x41).toString("base64url");

  it("has correct id", () => {
    expect(chat4000Plugin.id).toBe("chat4000");
  });

  it("meta has required fields", () => {
    expect(chat4000Plugin.meta.label).toBe("chat4000");
    expect(chat4000Plugin.meta.markdownCapable).toBe(true);
    expect(chat4000Plugin.meta.capabilities.chatTypes).toContain("direct");
  });

  it("capabilities include media and reactions", () => {
    expect(chat4000Plugin.meta.capabilities.media).toBe(true);
    expect(chat4000Plugin.meta.capabilities.reactions).toBe(true);
    expect(chat4000Plugin.meta.capabilities.effects).toBe(true);
  });

  it("config.isConfigured returns false for unconfigured", () => {
    const account = chat4000Plugin.config.resolveAccount({});
    expect(chat4000Plugin.config.isConfigured(account)).toBe(false);
  });

  it("config hooks tolerate missing cfg during host probes", () => {
    expect(chat4000Plugin.config.listAccountIds()).toEqual(["default"]);
    expect(chat4000Plugin.config.defaultAccountId()).toBe("default");
    expect(chat4000Plugin.config.resolveAccount()).toMatchObject({
      accountId: "default",
      configured: false,
    });
  });

  it("config.isConfigured returns true when configured", () => {
    const account = chat4000Plugin.config.resolveAccount({
      channels: {
        chat4000: { groupKey },
      },
    });
    expect(chat4000Plugin.config.isConfigured(account)).toBe(true);
  });

  it("config.describeAccount shows truncated groupId", () => {
    const account = chat4000Plugin.config.resolveAccount({
      channels: {
        chat4000: { groupKey },
      },
    });
    const desc = chat4000Plugin.config.describeAccount(account);
    expect(desc.name).toContain(`${account.groupId.substring(0, 8)}...`);
    expect(desc.configured).toBe(true);
    expect(desc.extra.groupId).toBe(account.groupId);
  });

  it("outbound base has correct delivery mode", () => {
    expect(chat4000Plugin.outbound.base.deliveryMode).toBe("direct");
    expect(chat4000Plugin.outbound.base.textChunkLimit).toBe(4096);
  });

  it("outbound channel is chat4000", () => {
    expect(chat4000Plugin.outbound.attachedResults.channel).toBe("chat4000");
  });

  it("gateway.startAccount throws if not configured", async () => {
    const account = chat4000Plugin.config.resolveAccount({});
    await expect(
      chat4000Plugin.gateway.startAccount({
        cfg: {},
        accountId: "default",
        account,
        abortSignal: AbortSignal.timeout(100),
        setStatus: () => {},
      }),
    ).rejects.toThrow("not configured");
  });
});
