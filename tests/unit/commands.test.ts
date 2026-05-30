import { describe, expect, it } from "vitest";
import { handleControlCommand } from "../../src/commands.js";

describe("handleControlCommand — owner gating", () => {
  it("denies plugin.update when no allowlist is configured", async () => {
    const res = await handleControlCommand(
      { command: "plugin.update", args: {}, senderId: "@u_x:hs" },
      { updateAllowFrom: [] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no updateAllowFrom");
  });

  it("denies plugin.update from a non-owner sender", async () => {
    const res = await handleControlCommand(
      { command: "plugin.update", args: {}, senderId: "@stranger:hs" },
      { updateAllowFrom: ["@owner:hs"] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not in updateAllowFrom");
  });

  it("answers unknown commands with ok:false", async () => {
    const res = await handleControlCommand(
      { command: "does.not.exist", args: {}, senderId: "@owner:hs" },
      { updateAllowFrom: ["@owner:hs"] },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown command");
  });
});
