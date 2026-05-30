/**
 * Decode a Matrix timeline event into a chat4000 inbound message.
 *
 * Only final, non-edit `m.room.message` events of type text/image/audio are
 * surfaced; edits (m.replace), reactions, state events, and our own draft
 * previews are ignored. Media byte download is a follow-up — for now media
 * events surface a text placeholder so the agent still gets a turn.
 */
import { EventType, type MatrixEvent, MsgType, RelationType } from "matrix-js-sdk";
import type { MatrixInboundMessage } from "./types.js";

export function decodeInboundEvent(event: MatrixEvent): MatrixInboundMessage | null {
  if (event.getType() !== EventType.RoomMessage) return null;
  if (event.isRedacted()) return null;

  const content = event.getContent();

  // Skip edits — the original event already lives in the timeline; we only act
  // on first-class incoming messages.
  const relatesTo = content["m.relates_to"] as { rel_type?: string } | undefined;
  if (relatesTo?.rel_type === RelationType.Replace) return null;

  const eventId = event.getId();
  const roomId = event.getRoomId();
  const senderId = event.getSender();
  if (!eventId || !roomId || !senderId) return null;

  const base = {
    eventId,
    roomId,
    senderId,
    senderDisplayName: event.sender?.name,
    ts: event.getTs(),
  };

  const msgtype = content.msgtype as string | undefined;
  if (msgtype === MsgType.Text || msgtype === MsgType.Notice || msgtype === MsgType.Emote) {
    const text = typeof content.body === "string" ? content.body : "";
    if (!text) return null;
    return { ...base, body: { kind: "text", text } };
  }

  if (msgtype === MsgType.Image || msgtype === MsgType.Audio) {
    // Full media transport (mxc download + decrypt + base64) is a follow-up;
    // surface a placeholder so the agent still receives the turn.
    const filename = typeof content.body === "string" ? content.body : "attachment";
    const label = msgtype === MsgType.Image ? "Image" : "Voice note";
    return { ...base, body: { kind: "text", text: `[${label}: ${filename}]` } };
  }

  return null;
}
