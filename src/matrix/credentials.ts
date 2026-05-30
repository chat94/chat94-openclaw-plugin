/**
 * Read/write persisted Matrix credentials for a chat4000 account.
 *
 * Stored at ~/.openclaw/plugins/chat4000/credentials/<account>.json with 0600
 * perms. This is the v2 durable secret (replaces the v1 group-key file): it
 * holds the plugin bot's Matrix access token + device id.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChat4000CredentialsPath } from "../paths.js";
import type { MatrixCredentials } from "./types.js";

export function loadMatrixCredentials(accountId: string): MatrixCredentials | null {
  const file = resolveChat4000CredentialsPath(accountId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MatrixCredentials>;
    if (
      typeof parsed.homeserver === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.deviceId === "string"
    ) {
      return {
        homeserver: parsed.homeserver,
        userId: parsed.userId,
        accessToken: parsed.accessToken,
        deviceId: parsed.deviceId,
        pluginId: typeof parsed.pluginId === "string" ? parsed.pluginId : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveMatrixCredentials(
  accountId: string,
  credentials: MatrixCredentials,
): string {
  const file = resolveChat4000CredentialsPath(accountId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort perm tightening
  }
  return file;
}

export function deleteMatrixCredentials(accountId: string): boolean {
  const file = resolveChat4000CredentialsPath(accountId);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
