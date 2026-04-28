import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawHome } from "./key-store.js";
import { captureChat94Exception } from "./telemetry.js";

function resolveChat94LogDir(): string {
  return path.join(resolveOpenClawHome(), "plugins", "chat94", "logs");
}

export function resolveChat94ErrorLogPath(): string {
  return path.join(resolveChat94LogDir(), "errors.log");
}

export function dumpChat94Trace(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>,
): string {
  captureChat94Exception(error, scope);

  const logPath = resolveChat94ErrorLogPath();
  const detail = error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : JSON.stringify(error));

  mkdirSync(path.dirname(logPath), { recursive: true });

  const lines = [
    `=== ${new Date().toISOString()} [${scope}] ===`,
    `message: ${detail.message}`,
  ];

  if (context && Object.keys(context).length > 0) {
    lines.push(`context: ${JSON.stringify(context)}`);
  }

  if (detail.stack) {
    lines.push(detail.stack);
  }

  lines.push("");

  appendFileSync(logPath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    chmodSync(logPath, 0o600);
  } catch {
    // Best-effort permission tightening.
  }

  return logPath;
}
