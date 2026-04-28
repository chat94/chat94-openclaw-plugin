import { describe, expect, it } from "vitest";
import { patchChannelConfig } from "../../src/cli.js";

describe("patchChannelConfig", () => {
  it("enables chat94 and allowlists it when plugins.allow is present", () => {
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
      chat94: {
        enabled: true,
        pairingLogLevel: "debug",
        runtimeLogLevel: "info",
      },
    });
    expect(next.plugins).toEqual({
      allow: ["openai", "browser", "chat94"],
      entries: {
        chat94: {
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
      chat94: {
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
        chat94: {
          enabled: true,
        },
      },
    });
  });
});
