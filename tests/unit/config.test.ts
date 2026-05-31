import { describe, expect, it } from "vitest";
import { patchChannelConfig } from "../../src/cli.js";

const baseParams = {
  accountId: "default",
  env: "stage" as const,
  pairingLogLevel: "info" as const,
  runtimeLogLevel: "info" as const,
  gatewayUrl: "wss://gateway.stgcht4.duckdns.org/ws",
  userId: "@plugin_x:stgcht4.duckdns.org",
  deviceId: "DEV1",
  registrarUrl: "https://registrar.stgcht4.duckdns.org",
};

describe("patchChannelConfig", () => {
  it("writes gatewayUrl/userId/deviceId but NEVER the access token", () => {
    const next = patchChannelConfig({}, baseParams);
    const channel = (next.channels as Record<string, Record<string, unknown>>).chat4000;

    expect(channel.gatewayUrl).toBe(baseParams.gatewayUrl);
    expect(channel.userId).toBe(baseParams.userId);
    expect(channel.deviceId).toBe("DEV1");
    expect(channel.env).toBe("stage");
    // The access token lives only in the 0600 credentials file.
    expect(JSON.stringify(next)).not.toContain("accessToken");
    expect(JSON.stringify(next)).not.toContain("access_token");
    // And no stale homeserver field leaks back in.
    expect(channel.homeserver).toBeUndefined();
  });

  it("enables the plugin entry and records the registrar url", () => {
    const next = patchChannelConfig({}, baseParams);
    const entries = (next.plugins as { entries: Record<string, { enabled?: boolean }> }).entries;
    expect(entries.chat4000.enabled).toBe(true);
    const channel = (next.channels as Record<string, Record<string, unknown>>).chat4000;
    expect((channel.provisioning as Record<string, unknown>).url).toBe(baseParams.registrarUrl);
  });

  it("nests a non-default account under accounts and sets defaultAccount", () => {
    const next = patchChannelConfig({}, { ...baseParams, accountId: "work" });
    const channel = (next.channels as Record<string, Record<string, unknown>>).chat4000;
    const accounts = channel.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work.gatewayUrl).toBe(baseParams.gatewayUrl);
    expect(channel.defaultAccount).toBe("work");
  });
});
