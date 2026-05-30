import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectV1State } from "../../src/migration/detect.js";

describe("detectV1State", () => {
  let tmp: string;
  const prevState = process.env.OPENCLAW_STATE_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "c4k-mig-"));
    process.env.OPENCLAW_STATE_DIR = tmp;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevState;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports absent when no v1 files exist", () => {
    expect(detectV1State("default").present).toBe(false);
  });

  it("detects a v1 group-key file and sqlite ack store", () => {
    const pluginDir = path.join(tmp, "plugins", "chat4000");
    mkdirSync(path.join(pluginDir, "keys"), { recursive: true });
    mkdirSync(path.join(pluginDir, "state"), { recursive: true });
    writeFileSync(path.join(pluginDir, "keys", "default.json"), "{}");
    writeFileSync(path.join(pluginDir, "state", "default.sqlite"), "");

    const det = detectV1State("default");
    expect(det.present).toBe(true);
    expect(det.keyFile).toContain("keys/default.json");
    expect(det.sqliteFile).toContain("state/default.sqlite");
    expect(det.paths.length).toBeGreaterThanOrEqual(2);
  });
});
