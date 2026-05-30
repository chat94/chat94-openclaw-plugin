/**
 * Outbound Matrix sends: final agent messages and in-place edits.
 *
 * Streaming (PROTOCOL §5) is modeled as ONE message that updates itself via
 * `m.replace` edits, with the final edit carrying the full text. Text is
 * rendered to HTML via markdown-it.
 *
 * matrix-js-sdk's `sendEvent` content type is a strict generated union that's
 * awkward for dynamically-shaped content, so we build plain objects (always
 * with `body` + `msgtype`) and cast at the call boundary.
 */
import MarkdownIt from "markdown-it";
import { EventType, type MatrixClient, MsgType, RelationType } from "matrix-js-sdk";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

type MatrixContent = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SendContent = any;

function renderTextContent(text: string): MatrixContent {
  const formatted = md.render(text).trim();
  const isPlain = formatted === `<p>${text}</p>` || formatted.length === 0;
  if (isPlain) {
    return { msgtype: MsgType.Text, body: text };
  }
  return {
    msgtype: MsgType.Text,
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: formatted,
  };
}

/** Send a brand-new text message. Returns the event id. */
export async function sendText(
  client: MatrixClient,
  roomId: string,
  text: string,
): Promise<string> {
  const res = await client.sendEvent(
    roomId,
    EventType.RoomMessage,
    renderTextContent(text) as SendContent,
  );
  return res.event_id;
}

/**
 * Edit an existing message in place (`m.replace`). Returns the edit event id.
 * This is the streaming primitive: the draft stream calls this repeatedly with
 * the accumulated text; the final call carries the full reply.
 */
export async function editText(
  client: MatrixClient,
  roomId: string,
  targetEventId: string,
  text: string,
): Promise<string> {
  const newContent = renderTextContent(text);
  const content: MatrixContent = {
    ...newContent,
    // Fallback body for clients that don't render edits (prefixed " *").
    body: `* ${text}`,
    "m.new_content": newContent,
    "m.relates_to": {
      rel_type: RelationType.Replace,
      event_id: targetEventId,
    },
  };
  const res = await client.sendEvent(roomId, EventType.RoomMessage, content as SendContent);
  return res.event_id;
}

/** Send a typing indicator (ephemeral, best-effort). */
export async function sendTyping(
  client: MatrixClient,
  roomId: string,
  typing: boolean,
  timeoutMs = 20_000,
): Promise<void> {
  try {
    await client.sendTyping(roomId, typing, typing ? timeoutMs : 0);
  } catch {
    // Typing is best-effort.
  }
}
