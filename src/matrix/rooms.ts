/**
 * Room creation + invite for the pairing flow (PROTOCOL §3.3).
 *
 * When a device redeems a pairing code, "the plugin invites user_id to its space
 * and session rooms." Minimal correct behavior: the plugin creates an encrypted
 * room and invites the freshly-paired user so messages can flow immediately.
 *
 * Uses a short-lived bare Matrix client (no crypto init needed — createRoom and
 * invite are plaintext state operations; the room is flagged encrypted so the
 * gateway's full client uses Megolm for actual messages).
 */
import { createClient, EventType, Preset, Visibility } from "matrix-js-sdk";
import type { MatrixCredentials } from "./types.js";

export type CreatePairedRoomResult = {
  roomId: string;
};

/**
 * Create an encrypted direct room owned by the plugin and invite `inviteUserId`.
 * Returns the new room id.
 */
export async function createPairedRoom(params: {
  credentials: MatrixCredentials;
  inviteUserId: string;
  name?: string;
}): Promise<CreatePairedRoomResult> {
  const client = createClient({
    baseUrl: params.credentials.homeserver,
    accessToken: params.credentials.accessToken,
    userId: params.credentials.userId,
    deviceId: params.credentials.deviceId,
  });

  try {
    const res = await client.createRoom({
      preset: Preset.TrustedPrivateChat,
      visibility: Visibility.Private,
      is_direct: true,
      invite: [params.inviteUserId],
      name: params.name,
      initial_state: [
        {
          type: EventType.RoomEncryption,
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });
    return { roomId: res.room_id };
  } finally {
    // Bare client — nothing started, just drop the reference.
    try {
      client.stopClient();
    } catch {
      // never started; ignore
    }
  }
}
