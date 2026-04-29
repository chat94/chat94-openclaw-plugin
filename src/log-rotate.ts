import { statSync, writeFileSync } from "node:fs";

export const DEFAULT_LOG_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Strict-cap rollover. When `filePath` is at or above `capBytes`, truncate it
 * back to a single marker line. Subsequent appends grow back from there, so
 * disk use per file stays bounded by `capBytes` at all times.
 *
 * No `.1` history copy is kept — the cap is total, not per-segment.
 * Callers must invoke this immediately before every `appendFileSync` to the
 * same path. Failures are swallowed: logging must never break runtime.
 */
export function rolloverIfTooLarge(filePath: string, capBytes: number = DEFAULT_LOG_CAP_BYTES): void {
  try {
    const stat = statSync(filePath);
    if (stat.size < capBytes) {
      return;
    }
    const marker =
      `${new Date().toISOString()} log.rolled_over previous_size=${stat.size} cap=${capBytes}\n`;
    writeFileSync(filePath, marker, { encoding: "utf8", mode: 0o600 });
  } catch {
    // File missing or stat failed — nothing to roll over.
  }
}
