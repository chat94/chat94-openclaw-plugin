/**
 * Environment presets for the chat4000 backend (PROTOCOL §0 + README).
 *
 *   prod  — domain chat4000.com (TLS), host 87.99.156.216
 *   stage — domain stgcht4.duckdns.org (Duck DNS wildcard + LE wildcard cert,
 *           TLS), host 178.105.217.63 — no real user data
 *
 * Selecting an env fixes the homeserver / registrar / gateway URL triple. The
 * plugin uses the registrar for pairing and the homeserver for its Matrix
 * client; the gateway URL is informational (devices connect there).
 */

export type Chat4000Env = "prod" | "stage";

export type EnvEndpoints = {
  homeserver: string;
  registrar: string;
  gateway: string;
};

export const ENV_ENDPOINTS: Record<Chat4000Env, EnvEndpoints> = {
  prod: {
    homeserver: "https://matrix.chat4000.com",
    registrar: "https://registrar.chat4000.com",
    gateway: "wss://gateway.chat4000.com/ws",
  },
  stage: {
    homeserver: "https://matrix.stgcht4.duckdns.org",
    registrar: "https://registrar.stgcht4.duckdns.org",
    gateway: "wss://gateway.stgcht4.duckdns.org/ws",
  },
};

export function normalizeEnv(value: string | undefined): Chat4000Env | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "stage" || v === "staging") return "stage";
  if (v === "prod" || v === "production") return "prod";
  return undefined;
}

/** Resolve env from an explicit flag, else CHAT4000_ENV, else prod. */
export function resolveEnv(flag?: string): Chat4000Env {
  return normalizeEnv(flag) ?? normalizeEnv(process.env.CHAT4000_ENV) ?? "prod";
}

export function endpointsForEnv(env: Chat4000Env): EnvEndpoints {
  return ENV_ENDPOINTS[env];
}
