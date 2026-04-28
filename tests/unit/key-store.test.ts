import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawHomeDir, resolveOpenClawStateDir } from "../../src/key-store.js";

describe("resolveOpenClawStateDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers OPENCLAW_STATE_DIR over OPENCLAW_HOME", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/chat94-state");
    vi.stubEnv("OPENCLAW_HOME", "/tmp/chat94-home");

    expect(resolveOpenClawStateDir()).toBe("/tmp/chat94-state");
  });

  it("falls back to OPENCLAW_HOME before homedir", () => {
    vi.stubEnv("OPENCLAW_HOME", "/tmp/chat94-home");

    expect(resolveOpenClawHomeDir()).toBe("/tmp/chat94-home");
    expect(resolveOpenClawStateDir()).toBe("/tmp/chat94-home/.openclaw");
  });

  it("falls back to homedir when no env override exists", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    vi.stubEnv("OPENCLAW_HOME", "");

    expect(resolveOpenClawStateDir()).toBe(path.join(os.homedir(), ".openclaw"));
  });
});
