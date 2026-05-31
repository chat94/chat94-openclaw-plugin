/**
 * Self-update boot guard (auto-rollback).
 *
 * When a self-update schedules a restart, apply.ts drops a marker recording
 * {fromVersion → toVersion}. On the next boot the gateway calls
 * `reconcileUpdateMarker`:
 *
 *   - the new version comes up and confirms healthy (first successful sync) →
 *     the marker is cleared;
 *   - the new version keeps crashing before it can confirm → after
 *     `MAX_BOOT_ATTEMPTS` boots the guard reports `rollback`, and the caller
 *     reinstalls the previous pinned version and restarts.
 *
 * Pure fs + version read — no dependency on the apply/install code, so the caller
 * (channel.ts) performs the rollback itself (via applyUpdate) and there is no
 * import cycle.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChat4000UpdateMarkerPath } from "../paths.js";

/** Boots into the new version that may confirm healthy before we give up on it. */
const MAX_BOOT_ATTEMPTS = 2;

type UpdateMarker = {
  fromVersion: string;
  toVersion: string;
  attempts?: number;
};

export type BootGuard = {
  /** `none` — nothing to do; `guard` — watching this boot; `rollback` — revert. */
  action: "none" | "guard" | "rollback";
  /** The version to reinstall when `action === "rollback"`. */
  rollbackToVersion?: string;
  /** Call once the gateway is healthy (synced) to clear a `guard` marker. */
  confirmHealthy: () => void;
};

const NOOP_GUARD: BootGuard = { action: "none", confirmHealthy: () => {} };

/** Record that we are about to restart into `toVersion` (called before restart). */
export function writeUpdateMarker(fromVersion: string, toVersion: string): void {
  const file = resolveChat4000UpdateMarkerPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const marker: UpdateMarker = { fromVersion, toVersion, attempts: 0 };
  writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

export function clearUpdateMarker(): void {
  try {
    rmSync(resolveChat4000UpdateMarkerPath(), { force: true });
  } catch {
    // best-effort
  }
}

function readUpdateMarker(): UpdateMarker | null {
  const file = resolveChat4000UpdateMarkerPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdateMarker>;
    if (typeof parsed.fromVersion === "string" && typeof parsed.toVersion === "string") {
      return {
        fromVersion: parsed.fromVersion,
        toVersion: parsed.toVersion,
        attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide what to do about a pending self-update on boot. See module docs.
 */
export function reconcileUpdateMarker(params: {
  currentVersion: string;
  log?: (line: string) => void;
}): BootGuard {
  const marker = readUpdateMarker();
  if (!marker) return NOOP_GUARD;

  // The version that's actually running isn't the one we updated to — the install
  // didn't take, or we already moved on. Drop the marker; nothing to guard.
  if (marker.toVersion !== params.currentVersion) {
    clearUpdateMarker();
    return NOOP_GUARD;
  }

  const attempts = (marker.attempts ?? 0) + 1;
  if (attempts > MAX_BOOT_ATTEMPTS) {
    params.log?.(
      `update to ${marker.toVersion} failed to confirm healthy after ${attempts - 1} ` +
        `boot(s); rolling back to ${marker.fromVersion}`,
    );
    clearUpdateMarker();
    return { action: "rollback", rollbackToVersion: marker.fromVersion, confirmHealthy: () => {} };
  }

  // Persist the incremented attempt count; clear once the gateway confirms healthy.
  writeFileSync(
    resolveChat4000UpdateMarkerPath(),
    `${JSON.stringify({ ...marker, attempts }, null, 2)}\n`,
    "utf8",
  );
  return { action: "guard", confirmHealthy: () => clearUpdateMarker() };
}
