import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverQueuedChat4000Deliveries } from "../../src/deferred-delivery.js";

const { sendMessageChat4000 } = vi.hoisted(() => ({
  sendMessageChat4000: vi.fn(),
}));

vi.mock("../../src/send.js", () => ({
  sendMessageChat4000,
}));

describe("recoverQueuedChat4000Deliveries", () => {
  const originalHome = process.env.OPENCLAW_HOME;
  let tempRoot = "";

  beforeEach(() => {
    sendMessageChat4000.mockReset();
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "chat4000-deferred-"));
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

  function writeQueueEntry(fileName: string, entry: Record<string, unknown>): string {
    const queueDir = path.join(tempRoot, ".openclaw", "delivery-queue");
    mkdirSync(queueDir, { recursive: true });
    const filePath = path.join(queueDir, fileName);
    writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return filePath;
  }

  it("replays queued chat4000 text replies and removes the queue entry", async () => {
    writeQueueEntry("queued.json", {
      id: "queued",
      channel: "chat4000",
      to: "chat4000:group-1",
      accountId: "default",
      payloads: [
        {
          text: "Hello from queue",
        },
      ],
      lastError: "Outbound not configured for channel: chat4000",
    });
    sendMessageChat4000.mockResolvedValue({ messageId: "sent-1" });

    const recovered = await recoverQueuedChat4000Deliveries({
      cfg: { channels: { chat4000: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(recovered).toBe(1);
    expect(sendMessageChat4000).toHaveBeenCalledWith("chat4000:group-1", "Hello from queue", {
      cfg: { channels: { chat4000: {} } },
      accountId: "default",
    });
    expect(existsSync(path.join(tempRoot, ".openclaw", "delivery-queue", "queued.json"))).toBe(false);
  });

  it("leaves unrelated queue entries untouched", async () => {
    const filePath = writeQueueEntry("other.json", {
      id: "other",
      channel: "telegram",
      to: "channel:abc",
      accountId: "default",
      payloads: [{ text: "nope" }],
    });

    const recovered = await recoverQueuedChat4000Deliveries({
      cfg: { channels: { chat4000: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(recovered).toBe(0);
    expect(sendMessageChat4000).not.toHaveBeenCalled();
    expect(readFileSync(filePath, "utf8")).toContain('"channel": "telegram"');
  });

  it("restores the queue entry when replay fails", async () => {
    const filePath = writeQueueEntry("failed.json", {
      id: "failed",
      channel: "chat4000",
      to: "chat4000:group-1",
      accountId: "default",
      payloads: [{ text: "Hello again" }],
    });
    sendMessageChat4000.mockRejectedValue(new Error("relay unavailable"));

    const recovered = await recoverQueuedChat4000Deliveries({
      cfg: { channels: { chat4000: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(recovered).toBe(0);
    expect(sendMessageChat4000).toHaveBeenCalledTimes(1);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain('"id": "failed"');
  });

  it("includes media URLs in the replayed fallback text", async () => {
    writeQueueEntry("media.json", {
      id: "media",
      channel: "chat4000",
      to: "chat4000:group-1",
      accountId: "default",
      payloads: [
        {
          text: "See attached",
          mediaUrl: "https://example.com/a.png",
          mediaUrls: ["https://example.com/b.png"],
        },
      ],
    });
    sendMessageChat4000.mockResolvedValue({ messageId: "sent-2" });

    await recoverQueuedChat4000Deliveries({
      cfg: { channels: { chat4000: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(sendMessageChat4000).toHaveBeenCalledWith(
      "chat4000:group-1",
      "See attached\n\nAttachment: https://example.com/a.png\nAttachment: https://example.com/b.png",
      {
        cfg: { channels: { chat4000: {} } },
        accountId: "default",
      },
    );
  });
});
