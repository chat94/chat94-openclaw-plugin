import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import type { RelayEnvelope, RelayPairCancelPayload, RelayPairDataPayload } from "./types.js";
import { resolveOpenClawHome } from "./key-store.js";

export type PairingLogLevel = "info" | "debug";

export type PairingLoggerContext = {
  roomId: string;
  code: string;
};

function resolvePairingLogPath(): string {
  return path.join(resolveOpenClawHome(), "plugins", "chat4000", "logs", "pairing.log");
}

function nowTimestamp(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value.includes(" ") ? JSON.stringify(value) : value;
  }
  return String(value);
}

function getPayloadType(envelope: RelayEnvelope): string | undefined {
  if (envelope.type !== "pair_data") {
    return undefined;
  }
  return (envelope.payload as RelayPairDataPayload | undefined)?.t;
}

export class PairingLogger {
  private readonly logPath = resolvePairingLogPath();

  constructor(
    private readonly level: PairingLogLevel,
    private readonly context: PairingLoggerContext,
  ) {}

  info(event: string, fields?: Record<string, unknown>): void {
    this.write("INFO", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    if (this.level !== "debug") {
      return;
    }
    this.write("DEBUG", event, fields);
  }

  logSend(envelope: RelayEnvelope, fields?: Record<string, unknown>): void {
    this.info("pair.send", {
      direction: "send",
      type: envelope.type,
      payload_t: getPayloadType(envelope),
      ...fields,
    });
  }

  logRecv(envelope: RelayEnvelope, fields?: Record<string, unknown>): void {
    this.info("pair.recv", {
      direction: "recv",
      type: envelope.type,
      payload_t: getPayloadType(envelope),
      ...fields,
    });
  }

  logCancelRemote(payload?: RelayPairCancelPayload): void {
    this.info("pair.cancel_remote", {
      cancel_origin: "remote",
      reason: payload?.reason,
    });
  }

  logCancelLocal(reason: string): void {
    this.info("pair.cancel_local", {
      cancel_origin: "local",
      reason,
    });
  }

  logWsClose(code: number, reason: string): void {
    this.info("pair.ws_close", {
      close_code: code,
      close_reason: reason,
    });
  }

  logWsError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.info("pair.ws_error", { error: detail });
  }

  logFinish(outcome: "success" | "cancel" | "error", reason: string): void {
    this.info("pair.finish", {
      outcome,
      reason,
    });
  }

  private write(level: "INFO" | "DEBUG", event: string, fields?: Record<string, unknown>): void {
    const merged: Record<string, unknown> = {
      code: this.context.code,
      room_id: this.context.roomId,
      ...fields,
    };

    const details = Object.entries(merged)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(" ");

    const line = `${nowTimestamp()} [tid:${threadId}] ${level} ${event}${details ? ` ${details}` : ""}`;

    mkdirSync(path.dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(this.logPath, 0o600);
    } catch {
      // Best-effort permission tightening.
    }
  }
}
