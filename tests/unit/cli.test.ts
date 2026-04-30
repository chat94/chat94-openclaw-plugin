import { describe, expect, it } from "vitest";
import { patchChannelConfig } from "../../src/cli.js";

describe("patchChannelConfig", () => {
  it("enables chat4000 and allowlists it when plugins.allow is present", () => {
    const next = patchChannelConfig(
      {
        plugins: {
          allow: ["openai", "browser"],
        },
      },
      {
        accountId: "default",
        pairingLogLevel: "debug",
        runtimeLogLevel: "info",
      },
    );

    expect(next.channels).toEqual({
      chat4000: {
        enabled: true,
        pairingLogLevel: "debug",
        runtimeLogLevel: "info",
      },
    });
    expect(next.plugins).toEqual({
      allow: ["openai", "browser", "chat4000"],
      entries: {
        chat4000: {
          enabled: true,
        },
      },
    });
  });

  it("writes named-account config without creating a new allowlist", () => {
    const next = patchChannelConfig(
      {},
      {
        accountId: "work",
        pairingLogLevel: "info",
        runtimeLogLevel: "debug",
      },
    );

    expect(next.channels).toEqual({
      chat4000: {
        accounts: {
          work: {
            enabled: true,
            pairingLogLevel: "info",
            runtimeLogLevel: "debug",
          },
        },
        defaultAccount: "work",
      },
    });
    expect(next.plugins).toEqual({
      entries: {
        chat4000: {
          enabled: true,
        },
      },
    });
  });
});
