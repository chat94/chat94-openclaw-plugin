import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import {
  computePairingProof,
  deriveGroupId,
  derivePairingRoomId,
  generatePairingCode,
  generatePairingJoinerKeypair,
  wrapGroupKeyToJoiner,
  normalizePairingCode,
  unwrapGroupKeyFromInitiator,
} from "./crypto.js";
import { dumpChat4000Trace } from "./error-log.js";
import { PairingLogger, type PairingLogLevel } from "./pairing-logger.js";
import type {
  RelayEnvelope,
  RelayPairCancelPayload,
  RelayPairDataGrantPayload,
  RelayPairDataHelloPayload,
  RelayPairDataPayload,
  RelayWrappedKeyPayload,
} from "./types.js";
import { attachWebSocketKeepalive } from "./ws-keepalive.js";

export type PairJoinResult = {
  groupKeyBytes: Buffer;
  groupId: string;
};

export type PairJoinOptions = {
  relayUrl: string;
  code: string;
  abortSignal?: AbortSignal;
  logLevel?: PairingLogLevel;
};

export type PairHostStatus =
  | "connecting"
  | "connected"
  | "waiting"
  | "joiner-ready"
  | "grant-sent"
  | "completed"
  | "closed";

export type PairHostResult = {
  code: string;
  roomId: string;
};

export type PairHostOptions = {
  relayUrl: string;
  groupKeyBytes: Buffer;
  code?: string;
  abortSignal?: AbortSignal;
  reconnectDelayMs?: number;
  logLevel?: PairingLogLevel;
  onStatus?: (status: PairHostStatus, detail: string) => void;
};

function sendEnvelope(ws: WebSocket, envelope: RelayEnvelope, logger?: PairingLogger, fields?: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not open");
  }
  logger?.logSend(envelope, fields);
  ws.send(JSON.stringify(envelope));
}

function parseEnvelope(raw: WebSocket.RawData): RelayEnvelope | null {
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString()) as RelayEnvelope;
  } catch {
    return null;
  }
}

export async function joinPairingSession(opts: PairJoinOptions): Promise<PairJoinResult> {
  const normalizedCode = normalizePairingCode(opts.code);
  const roomId = derivePairingRoomId(normalizedCode);
  const keypair = generatePairingJoinerKeypair();
  const logger = new PairingLogger(opts.logLevel ?? "info", {
    roomId,
    code: opts.code,
  });

  return await new Promise<PairJoinResult>((resolve, reject) => {
    let aSaltB64 = "";
    let finished = false;
    const ws = new WebSocket(opts.relayUrl);
    const stopKeepalive = attachWebSocketKeepalive(ws);

    const finish = (fn: () => void): void => {
      if (finished) return;
      finished = true;
      stopKeepalive();
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {}
      fn();
    };

    ws.on("open", () => {
      logger.info("pair.ws_open");
      sendEnvelope(ws, {
        version: 1,
        type: "pair_open",
        payload: {
          role: "joiner",
          room_id: roomId,
        },
      }, logger);
    });

    ws.on("message", async (raw) => {
      const envelope = parseEnvelope(raw);
      if (!envelope) return;
      logger.logRecv(envelope);

      if (envelope.type === "pair_cancel") {
        const payload = envelope.payload as RelayPairCancelPayload | undefined;
        logger.logCancelRemote(payload);
        logger.logFinish("cancel", payload?.reason || "remote_cancel");
        finish(() => reject(new Error("Pairing cancelled")));
        return;
      }

      if (envelope.type === "pair_ready" || envelope.type === "pair_open_ok") {
        if (envelope.type === "pair_ready") {
          logger.info("pair.ready");
        }
        return;
      }

      if (envelope.type !== "pair_data") {
        return;
      }

      const payload = envelope.payload as RelayPairDataPayload;
      if (payload.t === "hello") {
        aSaltB64 = (payload as RelayPairDataHelloPayload).salt;
        logger.info("pair.recv_hello", {
          a_salt_len: Buffer.from(aSaltB64, "base64").length,
        });
        sendEnvelope(ws, {
          version: 1,
          type: "pair_data",
          payload: {
            t: "join",
            salt: keypair.publicKeyBase64,
          },
        }, logger, {
          joiner_pub_len: keypair.publicKey.length,
        });
        sendEnvelope(ws, {
          version: 1,
          type: "pair_data",
          payload: {
            t: "proof_b",
            proof: computePairingProof(normalizedCode, aSaltB64, keypair.publicKeyBase64, "B"),
          },
        }, logger);
        return;
      }

      if (payload.t === "grant") {
        if (!aSaltB64) {
          finish(() => reject(new Error("Received pairing grant before hello salt")));
          return;
        }
        const grant = payload as RelayPairDataGrantPayload;
        const expectedProof = computePairingProof(normalizedCode, aSaltB64, keypair.publicKeyBase64, "A");
        if (grant.proof !== expectedProof) {
          logger.info("pair.proof_a_verify", { verified: false });
          logger.logFinish("error", "pairing_proof_mismatch");
          finish(() => reject(new Error("Pairing proof mismatch")));
          return;
        }
        logger.info("pair.proof_a_verify", { verified: true });
        const groupKeyBytes = await unwrapGroupKeyFromInitiator(
          grant.wrapped_key as RelayWrappedKeyPayload,
          keypair.privateKey,
        );
        if (!groupKeyBytes) {
          logger.logFinish("error", "unwrap_failed");
          finish(() => reject(new Error("Failed to unwrap group key")));
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) {
          logger.logFinish("error", "socket_closed_before_complete");
          finish(() => reject(new Error("Pairing socket closed before completion ack")));
          return;
        }
        logger.logSend({
          version: 1,
          type: "pair_complete",
          payload: {
            status: "ok",
          },
        });
        ws.send(
          JSON.stringify({
            version: 1,
            type: "pair_complete",
            payload: {
              status: "ok",
            },
          }),
          () => {
            logger.logFinish("success", "pair_complete_sent");
            finish(() =>
              resolve({
                groupKeyBytes,
                groupId: deriveGroupId(groupKeyBytes),
              }),
            );
          },
        );
      }
    });

    ws.on("error", (err) => {
      logger.logWsError(err);
      dumpChat4000Trace("pair-join-error", err, {
        roomId,
      });
      finish(() => reject(err));
    });

    ws.on("close", (codeValue, reasonValue) => {
      if (!finished) {
        const reason = Buffer.isBuffer(reasonValue) ? reasonValue.toString("utf8") : String(reasonValue ?? "");
        const detail = reason.trim() ? `Pairing socket closed (${codeValue}: ${reason.trim()})` : `Pairing socket closed (${codeValue})`;
        const error = new Error(detail);
        logger.logWsClose(codeValue, reason.trim());
        logger.logFinish("error", detail);
        dumpChat4000Trace("pair-join-close", error, {
          roomId,
        });
        finish(() => reject(error));
      }
    });

    opts.abortSignal?.addEventListener("abort", () => {
      logger.logCancelLocal("aborted");
      logger.logFinish("cancel", "aborted");
      finish(() => reject(new Error("Pairing aborted")));
    }, { once: true });
  });
}

export async function hostPairingSession(opts: PairHostOptions): Promise<PairHostResult> {
  const reconnectDelayMs = Math.max(250, opts.reconnectDelayMs ?? 1_000);
  const code = opts.code?.trim() || generatePairingCode();
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await hostPairingSessionOnce({
        ...opts,
        code,
      });
    } catch (error) {
      if (opts.abortSignal?.aborted || !isRetryablePairingError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      dumpChat4000Trace("pair-host-reconnect", error, {
        code,
        attempt,
      });
      opts.onStatus?.("closed", `${message}; reconnecting to relay`);
      await delay(reconnectDelayMs, opts.abortSignal);
    }
  }
}

async function hostPairingSessionOnce(opts: PairHostOptions): Promise<PairHostResult> {
  const code = opts.code?.trim() || generatePairingCode();
  const normalizedCode = normalizePairingCode(code);
  const roomId = derivePairingRoomId(normalizedCode);
  const aSaltB64 = randomBytes(32).toString("base64");
  const logger = new PairingLogger(opts.logLevel ?? "info", {
    roomId,
    code,
  });

  return await new Promise<PairHostResult>((resolve, reject) => {
    let finished = false;
    let joinerPublicKeyB64 = "";
    let grantSent = false;
    const ws = new WebSocket(opts.relayUrl);
    const stopKeepalive = attachWebSocketKeepalive(ws);

    const finish = (fn: () => void): void => {
      if (finished) return;
      finished = true;
      stopKeepalive();
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {}
      fn();
    };

    opts.onStatus?.("connecting", "Connecting to relay");

    ws.on("open", () => {
      logger.info("pair.ws_open");
      sendEnvelope(ws, {
        version: 1,
        type: "pair_open",
        payload: {
          role: "initiator",
          room_id: roomId,
        },
      }, logger);
    });

    ws.on("message", async (raw) => {
      const envelope = parseEnvelope(raw);
      if (!envelope) return;
      logger.logRecv(envelope);

      if (envelope.type === "pair_open_ok") {
        opts.onStatus?.("connected", "Connected to relay");
        opts.onStatus?.("waiting", "Waiting for client to join");
        return;
      }

      if (envelope.type === "pair_ready") {
        logger.info("pair.ready");
        opts.onStatus?.("joiner-ready", "Client joined pairing session");
        sendEnvelope(ws, {
          version: 1,
          type: "pair_data",
          payload: {
            t: "hello",
            salt: aSaltB64,
          },
        }, logger, {
          a_salt_len: Buffer.from(aSaltB64, "base64").length,
        });
        return;
      }

      if (envelope.type === "pair_cancel") {
        const payload = envelope.payload as RelayPairCancelPayload | undefined;
        logger.logCancelRemote(payload);
        logger.logFinish("cancel", payload?.reason || "remote_cancel");
        finish(() => reject(new Error("Pairing cancelled")));
        return;
      }

      if (envelope.type === "pair_complete") {
        logger.logFinish("success", "pair_complete_received");
        opts.onStatus?.("completed", "Pairing complete");
        finish(() => resolve({ code, roomId }));
        return;
      }

      if (envelope.type !== "pair_data") {
        return;
      }

      const payload = envelope.payload as RelayPairDataPayload;
      if (payload.t === "join") {
        joinerPublicKeyB64 = payload.salt;
        logger.info("pair.join_received", {
          joiner_pub_len: Buffer.from(joinerPublicKeyB64, "base64").length,
        });
        return;
      }

      if (payload.t === "proof_b") {
        logger.info("pair.proof_b_received");
        if (!joinerPublicKeyB64) {
          logger.logFinish("error", "proof_before_join");
          finish(() => reject(new Error("Received proof before join public key")));
          return;
        }
        const expectedProof = computePairingProof(
          normalizedCode,
          aSaltB64,
          joinerPublicKeyB64,
          "B",
        );
        logger.info("pair.proof_b_verify", {
          verified: payload.proof === expectedProof,
        });
        if (payload.proof !== expectedProof) {
          logger.logCancelLocal("proof_mismatch");
          sendEnvelope(ws, {
            version: 1,
            type: "pair_cancel",
            payload: { reason: "proof_mismatch" },
          }, logger, {
            cancel_origin: "local",
          });
          logger.logFinish("error", "joiner_proof_mismatch");
          finish(() => reject(new Error("Joiner proof mismatch")));
          return;
        }
        const wrappedKey = await wrapGroupKeyToJoiner(joinerPublicKeyB64, opts.groupKeyBytes);
        sendEnvelope(ws, {
          version: 1,
          type: "pair_data",
          payload: {
            t: "grant",
            proof: computePairingProof(normalizedCode, aSaltB64, joinerPublicKeyB64, "A"),
            wrapped_key: wrappedKey,
          },
        }, logger, {
          ephemeral_pub_len: Buffer.from(wrappedKey.ephemeral_pub, "base64").length,
          nonce_len: Buffer.from(wrappedKey.nonce, "base64").length,
          ciphertext_len: Buffer.from(wrappedKey.ciphertext, "base64").length,
        });
        grantSent = true;
        logger.info("pair.grant_sent", {
          ephemeral_pub_len: Buffer.from(wrappedKey.ephemeral_pub, "base64").length,
          nonce_len: Buffer.from(wrappedKey.nonce, "base64").length,
          ciphertext_len: Buffer.from(wrappedKey.ciphertext, "base64").length,
        });
        opts.onStatus?.("grant-sent", "Transferred encrypted group key");
        return;
      }

    });

    ws.on("error", (err) => {
      logger.logWsError(err);
      dumpChat4000Trace("pair-host-error", err, {
        roomId,
      });
      finish(() => reject(err));
    });

    ws.on("close", (codeValue, reasonValue) => {
      if (!finished) {
        if (grantSent) {
          logger.logWsClose(codeValue, Buffer.isBuffer(reasonValue) ? reasonValue.toString("utf8").trim() : String(reasonValue ?? "").trim());
          logger.logFinish("success", "closed_after_grant");
          opts.onStatus?.("completed", "Pairing room closed after key transfer");
          finish(() => resolve({ code, roomId }));
          return;
        }
        const reason = Buffer.isBuffer(reasonValue) ? reasonValue.toString("utf8") : String(reasonValue ?? "");
        const detail = reason.trim() ? `Pairing socket closed (${codeValue}: ${reason.trim()})` : `Pairing socket closed (${codeValue})`;
        logger.logWsClose(codeValue, reason.trim());
        logger.logFinish("error", detail);
        dumpChat4000Trace("pair-host-close", new Error(detail), {
          roomId,
          grantSent,
        });
        opts.onStatus?.("closed", detail);
        finish(() => reject(new Error(detail)));
      }
    });

    opts.abortSignal?.addEventListener(
      "abort",
      () => {
        logger.logCancelLocal("aborted");
        logger.logFinish("cancel", "aborted");
        finish(() => reject(new Error("Pairing aborted")));
      },
      { once: true },
    );
  });
}

function isRetryablePairingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Pairing socket closed") ||
    message.includes("ECONNRESET") ||
    message.includes("WebSocket was closed") ||
    message.includes("Unexpected server response")
  );
}

async function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    throw new Error("Pairing aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Pairing aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
