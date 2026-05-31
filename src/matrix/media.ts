/**
 * Native Matrix media (PROTOCOL D.3 + E).
 *
 * Binary media rides the HTTP media passthrough on the gateway host (the gateway
 * transport routes `/_matrix/media/*` + `/_matrix/client/v1/media/*` to real
 * HTTP, never the WS). For E2EE rooms the blob is encrypted client-side and only
 * the `mxc://` + decryption key travel inside the (encrypted) event.
 *
 * Encryption uses the official `matrix-encrypt-attachment` lib (the same one
 * Element uses) — we do not roll our own cipher. The cleartext AES key/IV/hashes
 * live in the event's `file` object, which is itself inside `m.room.encrypted`,
 * so the homeserver never sees them.
 */
import {
  decryptAttachment,
  encryptAttachment,
  type IEncryptedFile,
} from "matrix-encrypt-attachment";
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { markPush } from "./push-registry.js";

type EncryptedFileRef = IEncryptedFile & { url?: string };

export type InboundMedia = {
  kind: "image" | "audio";
  dataBase64: string;
  mimeType: string;
  filename: string;
};

export type InboundMediaBuffer = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

/**
 * Download (and decrypt if encrypted) an m.image/m.audio event's media into a
 * Buffer for the OpenClaw media store. Returns null when there's no media ref.
 */
export async function downloadInboundMediaBuffer(
  client: MatrixClient,
  content: Record<string, unknown>,
): Promise<InboundMediaBuffer | null> {
  const file = content.file as EncryptedFileRef | undefined;
  const plainUrl = typeof content.url === "string" ? content.url : undefined;
  const mxc = file?.url ?? plainUrl;
  if (!mxc) return null;

  const httpUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
  if (!httpUrl) return null;

  const res = await globalThis.fetch(httpUrl, {
    headers: { Authorization: `Bearer ${client.getAccessToken() ?? ""}` },
  });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  const cipher = await res.arrayBuffer();
  const plain = file ? await decryptAttachment(cipher, file) : cipher;

  const info = content.info as { mimetype?: string } | undefined;
  const contentType = info?.mimetype ?? (content.msgtype === "m.audio" ? "audio/ogg" : "image/png");
  const filename = typeof content.body === "string" ? content.body : "attachment";
  return { buffer: Buffer.from(plain), contentType, filename };
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Download (and, if encrypted, decrypt) the media referenced by an m.image /
 * m.audio event. Returns null when there is no usable media reference.
 */
export async function downloadInboundMedia(
  client: MatrixClient,
  content: Record<string, unknown>,
): Promise<InboundMedia | null> {
  const kind: "image" | "audio" = content.msgtype === "m.audio" ? "audio" : "image";
  const file = content.file as EncryptedFileRef | undefined;
  const plainUrl = typeof content.url === "string" ? content.url : undefined;
  const mxc = file?.url ?? plainUrl;
  if (!mxc) return null;

  // Authenticated media URL on the gateway host (useAuthentication = true).
  const httpUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
  if (!httpUrl) return null;

  const res = await globalThis.fetch(httpUrl, {
    headers: { Authorization: `Bearer ${client.getAccessToken() ?? ""}` },
  });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  const cipher = await res.arrayBuffer();
  const plain = file ? await decryptAttachment(cipher, file) : cipher;

  const info = content.info as { mimetype?: string } | undefined;
  const mimeType = info?.mimetype ?? (kind === "audio" ? "audio/ogg" : "image/png");
  const filename = typeof content.body === "string" ? content.body : "attachment";
  return { kind, dataBase64: Buffer.from(plain).toString("base64"), mimeType, filename };
}

/**
 * Encrypt (for E2EE rooms) + upload media and send it as a native
 * m.image / m.audio message. Marked push-eligible (a complete result).
 * Returns the event id.
 */
export async function sendMediaMessage(
  client: MatrixClient,
  roomId: string,
  params: { bytes: Uint8Array; mimeType: string; filename: string; encrypted: boolean },
): Promise<string> {
  const isAudio = params.mimeType.startsWith("audio/");
  const msgtype = isAudio ? "m.audio" : "m.image";
  const baseInfo = { mimetype: params.mimeType, size: params.bytes.byteLength };

  // uploadContent's type omits Uint8Array, but Node accepts a Buffer at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asFile = (u8: Uint8Array): any => Buffer.from(u8);

  let content: Record<string, unknown>;
  if (params.encrypted) {
    const enc = await encryptAttachment(toArrayBuffer(params.bytes));
    const upload = await client.uploadContent(asFile(new Uint8Array(enc.data)), {
      type: "application/octet-stream",
      name: params.filename,
    });
    const file: EncryptedFileRef = { url: upload.content_uri, ...enc.info };
    content = { msgtype, body: params.filename, file, info: baseInfo };
  } else {
    const upload = await client.uploadContent(asFile(params.bytes), {
      type: params.mimeType,
      name: params.filename,
    });
    content = { msgtype, body: params.filename, url: upload.content_uri, info: baseInfo };
  }

  const txnId = client.makeTxnId();
  markPush(txnId, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await client.sendEvent(roomId, EventType.RoomMessage, content as any, txnId);
  return res.event_id;
}

/** Whether E2EE is enabled in a room (default to encrypted on any doubt). */
export async function roomIsEncrypted(client: MatrixClient, roomId: string): Promise<boolean> {
  try {
    const crypto = client.getCrypto();
    if (!crypto) return false;
    return await crypto.isEncryptionEnabledInRoom(roomId);
  } catch {
    return true;
  }
}
