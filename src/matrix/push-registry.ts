/**
 * Push-intent side channel for `chat4000.push` (PROTOCOL E).
 *
 * `chat4000.push` must sit OUTSIDE the encrypted payload (like `m.relates_to`)
 * so the homeserver can read the one bit and decide whether to wake the user.
 * matrix-js-sdk + the Rust crypto encrypt the *whole* event content and preserve
 * only `m.relates_to` as cleartext, so we cannot put the flag in the content we
 * hand to `sendEvent` — it would be encrypted and the push rule (which keys on
 * cleartext `content.chat4000.push`) would never match.
 *
 * The clean seam is the wire boundary: the send layer picks a `txnId`, records
 * the push intent here, and the gateway transport — which sees the outgoing
 * `PUT …/send/m.room.encrypted/{txnId}` — injects `chat4000.push` into that
 * `m.room.encrypted` content (a cleartext sibling of the ciphertext; the
 * ciphertext itself is untouched). This is exactly "outside the encrypted
 * payload", done where the plugin legitimately controls the wire event.
 */

const MAX_ENTRIES = 512;

// Insertion-ordered; capped so a long-running gateway can't grow it unbounded.
// We do NOT delete on read: the SDK may retry a send with the same txnId, and
// the retry must carry the same flag.
const intents = new Map<string, boolean>();

/** Record the push-eligibility for an outgoing event's transaction id. */
export function markPush(txnId: string, push: boolean): void {
  if (intents.has(txnId)) intents.delete(txnId); // refresh insertion order
  intents.set(txnId, push);
  while (intents.size > MAX_ENTRIES) {
    const oldest = intents.keys().next().value;
    if (oldest === undefined) break;
    intents.delete(oldest);
  }
}

/** Peek the push-eligibility for a transaction id (undefined ⇒ not set). */
export function getPush(txnId: string): boolean | undefined {
  return intents.get(txnId);
}

/** Test helper: clear all recorded intents. */
export function _resetPushRegistry(): void {
  intents.clear();
}
