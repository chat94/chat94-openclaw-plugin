/**
 * Shared types for the chat4000 v2 Matrix transport.
 */

/** A persisted Matrix session for one plugin account. */
export type MatrixCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /** Plugin bot id from the provisioning service (stable across logins). */
  pluginId?: string;
};

/** Connection lifecycle surfaced to the channel layer. */
export type MatrixConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | { kind: "failed"; reason: string };

/** A decoded inbound room message handed to the agent dispatcher. */
export type MatrixInboundMessage = {
  /** Matrix event id — canonical dedup key (replaces the v1 inner msg_id). */
  eventId: string;
  roomId: string;
  /** Matrix user id of the sender. */
  senderId: string;
  senderDisplayName?: string;
  /** Origin server timestamp (ms). */
  ts: number;
  body:
    | { kind: "text"; text: string }
    | { kind: "image"; dataBase64: string; mimeType: string }
    | { kind: "audio"; dataBase64: string; mimeType: string; durationMs: number };
};
