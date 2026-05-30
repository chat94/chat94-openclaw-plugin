// ─── Plugin config (v2 — Matrix) ────────────────────────────────────────────

export type Chat4000ProvisioningConfig = {
  /** Registrar base URL, e.g. https://registrar.chat4000.com (PROTOCOL §3). */
  url?: string;
  /** SERVICE_TOKEN bearer the plugin uses for /pair/register and /pair/status. */
  serviceToken?: string;
};

export type Chat4000AccountConfig = {
  enabled?: boolean;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
  releaseChannel?: string;
  /** Backend environment preset: "prod" | "stage". */
  env?: string;
  /** Matrix session — normally written by `setup`, overridable by hand/env. */
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  deviceId?: string;
  provisioning?: Chat4000ProvisioningConfig;
  dmPolicy?: "open" | "pairing" | "disabled";
  allowFrom?: string[];
  textChunkLimit?: number;
  blockStreaming?: boolean;
  initialSyncLimit?: number;
};

export type Chat4000Config = Chat4000AccountConfig & {
  accounts?: Record<string, Chat4000AccountConfig>;
  defaultAccount?: string;
};

// ─── Resolved account ───────────────────────────────────────────────────────

export type ResolvedChat4000Account = {
  accountId: string;
  enabled: boolean;
  /** True once Matrix credentials (homeserver/userId/accessToken/deviceId) exist. */
  configured: boolean;
  pairingLogLevel: "info" | "debug";
  runtimeLogLevel: "info" | "debug";
  /** Matrix identity, resolved from credentials file → config → env. */
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  pluginId?: string;
  /** Where the credentials came from. */
  credentialSource: "state-file" | "config" | "env" | "missing";
  /** Resolved registrar settings (url + serviceToken), if configured. */
  provisioning: Chat4000ProvisioningConfig;
  config: Chat4000AccountConfig;
};

// ─── Probe result ───────────────────────────────────────────────────────────

export type Chat4000Probe = {
  ok: boolean;
  error?: string;
  latencyMs?: number;
};
