import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  clearChat4000SessionBinding,
  getChat4000SessionBinding,
  listOpenClawSessionCandidates,
  setChat4000SessionBinding,
} from "../../src/session-binding.js";

describe("session binding", () => {
  const originalHome = process.env.OPENCLAW_HOME;
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "chat4000-session-binding-"));
    process.env.OPENCLAW_HOME = tempRoot;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalHome;
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("lists recent user-facing sessions with transcript previews", () => {
    const sessionsDir = path.join(tempRoot, ".openclaw", "agents", "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:telegram:direct:123": {
          sessionId: "sess-1",
          updatedAt: 1_710_000_000_000,
          lastChannel: "telegram",
          subject: "Deploy bug",
        },
        "agent:main:cron:job-1": {
          sessionId: "sess-cron",
          updatedAt: 1_710_000_000_100,
        },
      }),
    );
    writeFileSync(
      path.join(sessionsDir, "sess-1.jsonl"),
      [
        JSON.stringify({ id: "1", message: { role: "user", content: [{ type: "text", text: "First" }] } }),
        JSON.stringify({ id: "2", message: { role: "assistant", content: [{ type: "text", text: "Latest reply from telegram" }] } }),
      ].join("\n"),
    );

    const sessions = listOpenClawSessionCandidates();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionKey: "agent:main:telegram:direct:123",
      label: "Deploy bug",
      lastChannel: "telegram",
      lastPreview: "Latest reply from telegram",
    });
  });

  it("persists and clears a chat4000 binding", () => {
    const target = {
      sessionKey: "agent:main:telegram:direct:123",
      agentId: "main",
      sessionId: "sess-1",
      storePath: path.join(tempRoot, ".openclaw", "agents", "main", "sessions", "sessions.json"),
      updatedAt: 1_710_000_000_000,
      label: "Deploy bug",
      lastPreview: "Latest reply",
      lastChannel: "telegram",
    };

    setChat4000SessionBinding({
      accountId: "default",
      groupId: "group-1",
      target,
    });

    expect(getChat4000SessionBinding({ accountId: "default", groupId: "group-1" })).toMatchObject({
      targetSessionKey: target.sessionKey,
      agentId: "main",
      label: "Deploy bug",
    });

    expect(clearChat4000SessionBinding({ accountId: "default", groupId: "group-1" })).toBe(true);
    expect(getChat4000SessionBinding({ accountId: "default", groupId: "group-1" })).toBeNull();
  });
});
