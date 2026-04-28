import { describe, it, expect } from "vitest";
import {
  computePairingProof,
  decrypt,
  deriveGroupId,
  derivePairId,
  derivePairingRoomId,
  encrypt,
  formatGroupQrUrl,
  formatPairQrUrl,
  generateGroupKey,
  generatePairKey,
  generatePairingCode,
  generatePairingJoinerKeypair,
  normalizePairingCode,
  parsePairKey,
  parseGroupKey,
  unwrapGroupKeyFromInitiator,
  wrapGroupKeyToJoiner,
} from "../../src/crypto.js";

describe("crypto", () => {
  const key = Buffer.alloc(32, 0x11);

  it("encrypt and decrypt roundtrip", () => {
    const plaintext = Buffer.from("hello from Chat94");
    const { nonce, ciphertext } = encrypt(plaintext, key);
    const decrypted = decrypt(nonce, ciphertext, key);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.toString("utf-8")).toBe("hello from Chat94");
  });

  it("wrong key fails to decrypt", () => {
    const wrongKey = Buffer.alloc(32, 0x22);
    const plaintext = Buffer.from("secret");
    const { nonce, ciphertext } = encrypt(plaintext, key);
    const result = decrypt(nonce, ciphertext, wrongKey);
    expect(result).toBeNull();
  });

  it("deriveGroupId produces consistent sha256 hex", () => {
    const k1 = Buffer.alloc(32, 0x33);
    const k2 = Buffer.alloc(32, 0x33);
    const k3 = Buffer.alloc(32, 0x44);
    expect(deriveGroupId(k1)).toBe(deriveGroupId(k2));
    expect(deriveGroupId(k1)).not.toBe(deriveGroupId(k3));
    expect(deriveGroupId(k1)).toMatch(/^[0-9a-f]{64}$/);
    expect(derivePairId(k1)).toBe(deriveGroupId(k1));
  });

  it("generateGroupKey returns 32 bytes", () => {
    expect(generateGroupKey()).toHaveLength(32);
    expect(generatePairKey()).toHaveLength(32);
  });

  it("formatGroupQrUrl uses base64url key", () => {
    expect(formatGroupQrUrl(key)).toBe(`chat94://pair/${key.toString("base64url")}`);
    expect(formatPairQrUrl(key)).toBe(formatGroupQrUrl(key));
  });

  it("parseGroupKey accepts hex and base64url", () => {
    expect(parseGroupKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseGroupKey(key.toString("base64url")).equals(key)).toBe(true);
    expect(parsePairKey(key.toString("hex")).equals(key)).toBe(true);
  });

  it("parseGroupKey rejects wrong length", () => {
    expect(() => parseGroupKey("short")).toThrow("Invalid group key");
  });

  it("encrypt empty payload", () => {
    const plaintext = Buffer.alloc(0);
    const { nonce, ciphertext } = encrypt(plaintext, key);
    const decrypted = decrypt(nonce, ciphertext, key);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.length).toBe(0);
  });

  it("encrypt large payload (64KB)", () => {
    const plaintext = Buffer.alloc(65_536, 0xab);
    const { nonce, ciphertext } = encrypt(plaintext, key);
    const decrypted = decrypt(nonce, ciphertext, key);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.length).toBe(65_536);
    expect(decrypted![0]).toBe(0xab);
  });

  it("corrupted ciphertext fails", () => {
    const { nonce, ciphertext } = encrypt(Buffer.from("data"), key);
    const corrupted = ciphertext.slice(0, -2) + "XX";
    expect(decrypt(nonce, corrupted, key)).toBeNull();
  });

  it("wrong nonce fails", () => {
    const { ciphertext } = encrypt(Buffer.from("data"), key);
    const wrongNonce = Buffer.alloc(24).toString("base64");
    expect(decrypt(wrongNonce, ciphertext, key)).toBeNull();
  });

  it("normalizes pairing codes and derives room ids", () => {
    expect(normalizePairingCode("abCd-2346")).toBe("ABCD2346");
    expect(derivePairingRoomId("ABCD-2346")).toBe(derivePairingRoomId("abcd2346"));
    expect(derivePairingRoomId("ABCD-2346")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates pairing codes in the expected human format", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01ILS5O]/);
  });

  it("computes pairing proof using exact spec separators", () => {
    const proof = computePairingProof(
      "ABCD2346",
      Buffer.from("salt-value").toString("base64"),
      Buffer.alloc(32, 0x23).toString("base64"),
      "B",
    );
    expect(proof).toBe("iqH42fMsdUtAwURmEZj1m2GlqS3itz12RWHDLARn7aE=");
  });

  it("wraps and unwraps a group key via x25519+xchacha20poly1305", () => {
    const keypair = generatePairingJoinerKeypair();
    const wrapped = wrapGroupKeyToJoiner(keypair.publicKeyBase64, key);
    const unwrapped = unwrapGroupKeyFromInitiator(wrapped, keypair.privateKey);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped!.equals(key)).toBe(true);
  });
});
