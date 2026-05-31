import { describe, expect, it } from "vitest";
import { handleControlCommand } from "../../src/commands.js";

describe("handleControlCommand — control-room commands", () => {
  // Authorization is control-room membership (enforced in the Matrix client, not
  // here): the handler acts on any command it is given. plugin.update is NOT
  // sender-gated — any member of the control room may run it (PROTOCOL E + B4).
  it("does not deny plugin.update by sender", async () => {
    const res = await handleControlCommand(
      { command: "plugin.update", args: { version: "9.9.9" }, senderId: "@anyone:hs" },
      {},
    );
    // It attempts the update (which fails for unrelated reasons in a test env),
    // but it is NOT rejected with an authorization error.
    expect(res.command).toBe("plugin.update");
    expect(res.error ?? "").not.toContain("denied");
    expect(res.error ?? "").not.toContain("updateAllowFrom");
  });

  it("answers plugin.update_check ok with version data", async () => {
    const res = await handleControlCommand(
      { command: "plugin.update_check", args: {}, senderId: "@anyone:hs" },
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.data).toHaveProperty("current_version");
    expect(res.data).toHaveProperty("updatable");
  });

  it("answers unknown commands with ok:false", async () => {
    const res = await handleControlCommand(
      { command: "does.not.exist", args: {}, senderId: "@anyone:hs" },
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown command");
  });
});
