// ─── Plugin config ──────────────────────────────────────────────────────────

export type Chat4000AccountConfig = {
  enabled?: boolean;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
  releaseChannel?: string;
  // Legacy/manual override paths retained for migration.
  groupKey?: string;
  pairKey?: string;
  dmPolicy?: "open" | "pairing" | "disabled";
  allowFrom?: string[];
  textChunkLimit?: number;
  blockStreaming?: boolean;
};

export type Chat4000Config = Chat4000AccountConfig & {
  accounts?: Record<string, Chat4000AccountConfig>;
  defaultAccount?: string;
};

// ─── Resolved account ───────────────────────────────────────────────────────

export type ResolvedChat4000Account = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  relayUrl: string;
  pairingLogLevel: "info" | "debug";
  runtimeLogLevel: "info" | "debug";
  groupId: string;
  groupKeyBytes: Buffer;
  keyFilePath: string;
  keySource: "state-file" | "config" | "env" | "missing";
  config: Chat4000AccountConfig;
};

// ─── Relay protocol messages ────────────────────────────────────────────────

export type RelayEnvelope = {
  version: number;
  type: string;
  payload: Record<string, unknown>;
};

export type RelayHelloPayload = {
  role: "plugin";
  group_id: string;
  device_token: null;
  app_version: string;
  release_channel: string;
  last_acked_seq?: number;
};

export type RelayVersionPolicy = {
  min_version?: string | null;
  recommended_version?: string | null;
  latest_version?: string | null;
};

export type RelayHelloOkPayload = {
  current_terms_version?: number;
  version_policy?: RelayVersionPolicy;
  plugin_version_policy?: RelayVersionPolicy;
};

export type RelayMsgPayload = {
  msg_id: string;
  nonce: string;
  ciphertext: string;
  notify_if_offline?: boolean;
  /** Relay-assigned per-recipient sequence number. Absent on pre-ack relays. */
  seq?: number;
};

export type RelayRecvAckPayload = {
  /** Highest seq for which every lower seq has been persisted (cumulative high-water mark). */
  up_to_seq: number;
  /** Optional out-of-order persisted ranges above up_to_seq. Each pair [low, high] inclusive, low > up_to_seq. */
  ranges?: [number, number][];
};

/** Sender-side hint emitted by ack-aware relays to confirm fan-out. Optional in v1. */
export type RelayRecvSenderAckPayload = {
  msg_id: string;
  queued_for?: string[];
};

export type RelayPairOpenPayload = {
  role: "initiator" | "joiner";
  room_id: string;
};

export type RelayPairOpenOkPayload = Record<string, never>;

export type RelayPairDataHelloPayload = {
  t: "hello";
  salt: string;
};

export type RelayPairDataJoinPayload = {
  t: "join";
  salt: string;
};

export type RelayPairDataProofPayload = {
  t: "proof_b";
  proof: string;
};

export type RelayWrappedKeyPayload = {
  ephemeral_pub: string;
  nonce: string;
  ciphertext: string;
};

export type RelayPairDataGrantPayload = {
  t: "grant";
  proof: string;
  wrapped_key: RelayWrappedKeyPayload;
};

export type RelayPairDataPayload =
  | RelayPairDataHelloPayload
  | RelayPairDataJoinPayload
  | RelayPairDataProofPayload
  | RelayPairDataGrantPayload;

export type RelayPairCompletePayload = {
  status: "ok";
};

export type RelayPairCancelPayload = {
  reason?: string;
};

// ─── Inner messages ─────────────────────────────────────────────────────────

export type InnerMessageType =
  | "text"
  | "image"
  | "audio"
  | "text_delta"
  | "text_end"
  | "status"
  | "ack";

export type InnerAckStage = "received" | "processing" | "displayed";

export type InnerMessageFrom = {
  role: "app" | "plugin";
  device_id?: string;
  device_name?: string;
  app_version?: string;
  bundle_id?: string;
};

export type InnerMessage = {
  t: InnerMessageType;
  id: string;
  from?: InnerMessageFrom;
  body: Record<string, unknown>;
  ts: number;
};

export type InnerTextBody = { text: string };
export type InnerImageBody = {
  data_base64: string;
  mime_type: string;
};
export type InnerAudioBody = {
  data_base64: string;
  mime_type: string;
  duration_ms: number;
  waveform: number[];
};
export type InnerDeltaBody = { delta: string };
export type InnerStatusBody = { status: "thinking" | "typing" | "idle" };
export type InnerAckBody = {
  refs: string;
  stage: InnerAckStage;
};

// ─── Inbound (from iPhone) ──────────────────────────────────────────────────

export type Chat4000InboundTextMessage = {
  messageId: string;
  innerType: "text";
  text: string;
  timestamp: number;
  groupId: string;
  from?: InnerMessageFrom;
};

export type Chat4000InboundImageMessage = {
  messageId: string;
  innerType: "image";
  dataBase64: string;
  mimeType: string;
  timestamp: number;
  groupId: string;
  from?: InnerMessageFrom;
};

export type Chat4000InboundAudioMessage = {
  messageId: string;
  innerType: "audio";
  dataBase64: string;
  mimeType: string;
  durationMs: number;
  waveform: number[];
  timestamp: number;
  groupId: string;
  from?: InnerMessageFrom;
};

export type Chat4000InboundMessage =
  | Chat4000InboundTextMessage
  | Chat4000InboundImageMessage
  | Chat4000InboundAudioMessage;

// ─── Probe result ───────────────────────────────────────────────────────────

export type Chat4000Probe = {
  ok: boolean;
  error?: string;
  latencyMs?: number;
};
