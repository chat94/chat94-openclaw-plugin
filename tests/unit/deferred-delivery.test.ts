import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverQueuedChat94Deliveries } from "../../src/deferred-delivery.js";

const { sendMessageChat94 } = vi.hoisted(() => ({
  sendMessageChat94: vi.fn(),
}));

vi.mock("../../src/send.js", () => ({
  sendMessageChat94,
}));

describe("recoverQueuedChat94Deliveries", () => {
  const originalHome = process.env.OPENCLAW_HOME;
  let tempRoot = "";

  beforeEach(() => {
    sendMessageChat94.mockReset();
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "chat94-deferred-"));
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

  it("replays queued chat94 text replies and removes the queue entry", async () => {
    writeQueueEntry("queued.json", {
      id: "queued",
      channel: "chat94",
      to: "chat94:group-1",
      accountId: "default",
      payloads: [
        {
          text: "Hello from queue",
        },
      ],
      lastError: "Outbound not configured for channel: chat94",
    });
    sendMessageChat94.mockResolvedValue({ messageId: "sent-1" });

    const recovered = await recoverQueuedChat94Deliveries({
      cfg: { channels: { chat94: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(recovered).toBe(1);
    expect(sendMessageChat94).toHaveBeenCalledWith("chat94:group-1", "Hello from queue", {
      cfg: { channels: { chat94: {} } },
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

    const recovered = await recoverQueuedChat94Deliveries({
      cfg: { channels: { chat94: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(recovered).toBe(0);
    expect(sendMessageChat94).not.toHaveBeenCalled();
    expect(readFileSync(filePath, "utf8")).toContain('"channel": "telegram"');
  });

  it("restores the queue entry when replay fails", async () => {
    const filePath = writeQueueEntry("failed.json", {
      id: "failed",
      channel: "chat94",
      to: "chat94:group-1",
      accountId: "default",
      payloads: [{ text: "Hello again" }],
    });
    sendMessageChat94.mockRejectedValue(new Error("relay unavailable"));

    const recovered = await recoverQueuedChat94Deliveries({
      cfg: { channels: { chat94: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(recovered).toBe(0);
    expect(sendMessageChat94).toHaveBeenCalledTimes(1);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain('"id": "failed"');
  });

  it("includes media URLs in the replayed fallback text", async () => {
    writeQueueEntry("media.json", {
      id: "media",
      channel: "chat94",
      to: "chat94:group-1",
      accountId: "default",
      payloads: [
        {
          text: "See attached",
          mediaUrl: "https://example.com/a.png",
          mediaUrls: ["https://example.com/b.png"],
        },
      ],
    });
    sendMessageChat94.mockResolvedValue({ messageId: "sent-2" });

    await recoverQueuedChat94Deliveries({
      cfg: { channels: { chat94: {} } },
      accountId: "default",
      groupId: "group-1",
    });

    expect(sendMessageChat94).toHaveBeenCalledWith(
      "chat94:group-1",
      "See attached\n\nAttachment: https://example.com/a.png\nAttachment: https://example.com/b.png",
      {
        cfg: { channels: { chat94: {} } },
        accountId: "default",
      },
    );
  });
});
