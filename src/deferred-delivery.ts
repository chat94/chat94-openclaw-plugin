import { promises as fs } from "node:fs";
import path from "node:path";
import { sendMessageChat94 } from "./send.js";
import { resolveOpenClawHome } from "./key-store.js";

type QueuedPayload = {
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
};

type QueuedDeliveryEntry = {
  id: string;
  channel: string;
  to?: unknown;
  accountId?: unknown;
  payloads?: unknown;
  lastError?: unknown;
};

const RECOVERY_SUFFIX = ".chat94-recovering";

function resolveDeliveryQueueDir(): string {
  return path.join(resolveOpenClawHome(), "delivery-queue");
}

function isQueuedPayload(value: unknown): value is QueuedPayload {
  return Boolean(value) && typeof value === "object";
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMediaUrls(payload: QueuedPayload): string[] {
  const urls: string[] = [];
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()) {
    urls.push(payload.mediaUrl.trim());
  }
  if (Array.isArray(payload.mediaUrls)) {
    for (const value of payload.mediaUrls) {
      if (typeof value === "string" && value.trim()) {
        urls.push(value.trim());
      }
    }
  }
  return urls;
}

function formatQueuedPayloadText(payload: QueuedPayload): string {
  const text = normalizeText(payload.text);
  const mediaUrls = normalizeMediaUrls(payload);
  if (mediaUrls.length === 0) {
    return text;
  }

  const attachmentBlock = mediaUrls.map((url) => `Attachment: ${url}`).join("\n");
  return text ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
}

async function readQueueEntry(filePath: string): Promise<QueuedDeliveryEntry | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as QueuedDeliveryEntry;
  } catch {
    return null;
  }
}

async function renameForRecovery(filePath: string): Promise<string | null> {
  const tempPath = `${filePath}${RECOVERY_SUFFIX}.${process.pid}.${Date.now()}`;
  try {
    await fs.rename(filePath, tempPath);
    return tempPath;
  } catch {
    return null;
  }
}

async function restoreQueueEntry(tempPath: string, originalPath: string): Promise<void> {
  try {
    await fs.rename(tempPath, originalPath);
  } catch {
    // Best-effort: if restore fails, a later manual inspection is still possible.
  }
}

function matchesChat94Entry(
  entry: QueuedDeliveryEntry,
  accountId: string,
  groupId: string,
): boolean {
  return (
    entry.channel === "chat94" &&
    entry.accountId === accountId &&
    entry.to === `chat94:${groupId}`
  );
}

export async function recoverQueuedChat94Deliveries(params: {
  cfg: { channels?: Record<string, unknown> };
  accountId: string;
  groupId: string;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}): Promise<number> {
  const queueDir = resolveDeliveryQueueDir();
  let fileNames: string[] = [];
  try {
    fileNames = (await fs.readdir(queueDir))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return 0;
  }

  let recovered = 0;
  for (const fileName of fileNames) {
    const originalPath = path.join(queueDir, fileName);
    const tempPath = await renameForRecovery(originalPath);
    if (!tempPath) {
      continue;
    }

    const entry = await readQueueEntry(tempPath);
    if (!entry || !matchesChat94Entry(entry, params.accountId, params.groupId)) {
      await restoreQueueEntry(tempPath, originalPath);
      continue;
    }

    const payloads = Array.isArray(entry.payloads)
      ? entry.payloads.filter(isQueuedPayload)
      : [];

    try {
      for (const payload of payloads) {
        const text = formatQueuedPayloadText(payload);
        if (!text) {
          continue;
        }
        await sendMessageChat94(`chat94:${params.groupId}`, text, {
          cfg: params.cfg,
          accountId: params.accountId,
        });
      }
      await fs.unlink(tempPath);
      recovered += 1;
      params.log?.info?.(
        `[${params.accountId}] Recovered queued chat94 delivery ${entry.id}`,
      );
    } catch (error) {
      await restoreQueueEntry(tempPath, originalPath);
      params.log?.warn?.(
        `[${params.accountId}] Failed to recover queued chat94 delivery ${entry.id}: ${String(error)}`,
      );
    }
  }

  return recovered;
}
