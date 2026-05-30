/**
 * Stable per-account plugin instance identity.
 *
 * PROTOCOL §3.1 requires a `plugin_id` (UUID, 36 chars) on every
 * `/pair/register`. It must be stable across runs, so we persist it at
 * ~/.openclaw/plugins/chat4000/instance/<account>.json (0600).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveChat4000InstancePath } from "../paths.js";

type InstanceFile = {
  pluginId?: string;
};

function readInstance(accountId: string): InstanceFile {
  const file = resolveChat4000InstancePath(accountId);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as InstanceFile;
  } catch {
    return {};
  }
}

function writeInstance(accountId: string, data: InstanceFile): void {
  const file = resolveChat4000InstancePath(accountId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

/** Get the persisted plugin_id for this account, creating one on first use. */
export function getOrCreatePluginId(accountId: string): string {
  const instance = readInstance(accountId);
  if (instance.pluginId && instance.pluginId.trim()) return instance.pluginId;
  const pluginId = randomUUID();
  writeInstance(accountId, { ...instance, pluginId });
  return pluginId;
}
