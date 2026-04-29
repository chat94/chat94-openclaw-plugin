import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
} from "node:crypto";
import type { RelayWrappedKeyPayload } from "./types.js";

/**
 * `@noble/ciphers@2.x` is published as a pure ESM package. OpenClaw's plugin
 * loader (jiti-based) transforms static `import` statements into `require()`
 * calls, which fail with `MODULE_NOT_FOUND` against pure-ESM packages. We
 * defer the load to a real native dynamic `import()` and cache the resolved
 * module so per-call cost is just a property read after the first await.
 */
type XChaChaModule = typeof import("@noble/ciphers/chacha.js");
let xchachaModulePromise: Promise<XChaChaModule> | undefined;
async function loadXChaCha20Poly1305(): Promise<XChaChaModule["xchacha20poly1305"]> {
  xchachaModulePromise ??= import("@noble/ciphers/chacha.js");
  return (await xchachaModulePromise).xchacha20poly1305;
}

export async function encrypt(
  plaintext: Buffer,
  key: Buffer,
): Promise<{ nonce: string; ciphertext: string }> {
  const xchacha20poly1305 = await loadXChaCha20Poly1305();
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const sealed = cipher.encrypt(plaintext);

  return {
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(sealed).toString("base64"),
  };
}

export async function decrypt(
  nonceB64: string,
  ciphertextB64: string,
  key: Buffer,
): Promise<Buffer | null> {
  try {
    const xchacha20poly1305 = await loadXChaCha20Poly1305();
    const nonce = Buffer.from(nonceB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    const cipher = xchacha20poly1305(key, nonce);
    const plaintext = cipher.decrypt(ciphertext);
    return Buffer.from(plaintext);
  } catch {
    return null;
  }
}

const PAIRING_ROOM_PREFIX = "pairing-v1:";
const PAIR_WRAP_INFO = "chat4000-pair-wrap-v1";
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPRTUVWXYZ2346789";

export type X25519Keypair = {
  privateKey: KeyObject;
  publicKey: Buffer;
  publicKeyBase64: string;
};

function sha256(parts: (Buffer | string)[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

function base64UrlToBase64(value: string): string {
  return value.replace(/-/g, "+").replace(/_/g, "/");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(base64UrlToBase64(value), "base64");
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function x25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: {
      crv: "X25519",
      kty: "OKP",
      x: encodeBase64Url(raw),
    },
    format: "jwk",
  });
}

/** Derive group_id from raw group key: lowercase_hex(SHA-256(key_bytes)) */
export function deriveGroupId(groupKeyBytes: Buffer): string {
  return createHash("sha256").update(groupKeyBytes).digest("hex");
}

/** Generate a new 32-byte group key */
export function generateGroupKey(): Buffer {
  return randomBytes(32);
}

/** Format group key as QR code URL (legacy helper retained for compatibility). */
export function formatGroupQrUrl(groupKeyBytes: Buffer): string {
  const b64url = groupKeyBytes.toString("base64url");
  return `chat4000://pair/${b64url}`;
}

/** Parse a group key from base64url or hex string */
export function parseGroupKey(input: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(input)) {
    return Buffer.from(input, "hex");
  }

  const buf = Buffer.from(input, "base64url");
  if (buf.length !== 32) {
    throw new Error(`Invalid group key: expected 32 bytes, got ${buf.length}`);
  }

  return buf;
}

export function normalizePairingCode(input: string): string {
  return input.replace(/-/g, "").trim().toUpperCase();
}

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (value) => PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

export function derivePairingRoomId(input: string): string {
  const normalized = normalizePairingCode(input);
  return sha256([PAIRING_ROOM_PREFIX, normalized]).toString("hex");
}

export function generatePairingJoinerKeypair(): X25519Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (typeof jwk.x !== "string") {
    throw new Error("Failed to export x25519 public key");
  }
  const rawPublicKey = decodeBase64Url(jwk.x);
  return {
    privateKey,
    publicKey: rawPublicKey,
    publicKeyBase64: rawPublicKey.toString("base64"),
  };
}

export function computePairingProof(
  normalizedCode: string,
  aSaltB64: string,
  bPubB64: string,
  side: "A" | "B",
): string {
  const normalizedCodeBytes = Buffer.from(normalizedCode, "utf8");
  const aSaltRaw = Buffer.from(aSaltB64, "base64");
  const bPubRaw = Buffer.from(bPubB64, "base64");
  const proof = sha256([
    normalizedCodeBytes,
    Buffer.from([0x00]),
    aSaltRaw,
    Buffer.from([0x00]),
    bPubRaw,
    Buffer.from([0x00]),
    side,
  ]);
  return proof.toString("base64");
}

export async function wrapGroupKeyToJoiner(
  recipientPublicKeyB64: string,
  groupKey: Buffer,
): Promise<RelayWrappedKeyPayload> {
  const xchacha20poly1305 = await loadXChaCha20Poly1305();
  const recipientPublicKey = x25519PublicKeyFromRaw(Buffer.from(recipientPublicKeyB64, "base64"));
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey,
    publicKey: recipientPublicKey,
  });
  const wrapKey = sha256([sharedSecret, PAIR_WRAP_INFO]);
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(wrapKey, nonce);
  const ciphertext = cipher.encrypt(groupKey);
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (typeof jwk.x !== "string") {
    throw new Error("Failed to export ephemeral x25519 public key");
  }
  return {
    ephemeral_pub: Buffer.from(decodeBase64Url(jwk.x)).toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

export async function unwrapGroupKeyFromInitiator(
  wrappedKey: RelayWrappedKeyPayload,
  recipientPrivateKey: KeyObject,
): Promise<Buffer | null> {
  try {
    const xchacha20poly1305 = await loadXChaCha20Poly1305();
    const senderPublicKey = x25519PublicKeyFromRaw(Buffer.from(wrappedKey.ephemeral_pub, "base64"));
    const sharedSecret = diffieHellman({
      privateKey: recipientPrivateKey,
      publicKey: senderPublicKey,
    });
    const wrapKey = sha256([sharedSecret, PAIR_WRAP_INFO]);
    const nonce = Buffer.from(wrappedKey.nonce, "base64");
    const ciphertext = Buffer.from(wrappedKey.ciphertext, "base64");
    const cipher = xchacha20poly1305(wrapKey, nonce);
    const groupKey = Buffer.from(cipher.decrypt(ciphertext));
    return groupKey.length === 32 ? groupKey : null;
  } catch {
    return null;
  }
}

// Backward-compatible aliases during the protocol vocabulary migration.
export const derivePairId = deriveGroupId;
export const generatePairKey = generateGroupKey;
export const formatPairQrUrl = formatGroupQrUrl;
export const parsePairKey = parseGroupKey;
