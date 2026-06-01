# chat4000 OpenClaw plugin — Tech Debt

Known shortcuts, approximations, and things to revisit. Each entry: **what**, **why
it's debt**, **risk**, **fix**. Newest/most important first.

---

## 1. `sync_ack` persist-before-ack is *inferred*, not signalled  ⚠️ correctness

**What.** PROTOCOL D.2 requires: the device persists a sync batch's to-device room
keys to disk, *then* sends `sync_ack { pos }`; only then does the gateway let the
homeserver delete those keys. We implement this in `GatewayTransport`: when the SDK
asks for the **next** sliding-sync (which means it finished processing the previous
batch), we flush the crypto store to disk (only if that batch carried to-device
keys), persist `pos` to `sync-pos.txt`, then send `sync_ack`.

**Why it's debt.** matrix-js-sdk exposes **no explicit "this batch's keys are now
durably stored" signal.** We infer "processed" from the SDK's next sliding-sync
call. That's almost certainly correct — the SDK processes a sync response
(including the Rust-crypto to-device decrypt + IndexedDB write) before requesting
again — but it's an inference, not a contract. The protocol assumes a client (the
Swift app) that controls its own persist→ack ordering; our wrapper can only
approximate it.

**Risk.** A thin race: if matrix-js-sdk ever pipelines sync requests, or returns
from `slidingSync()` *before* the crypto store write settles, we could ack a batch
whose keys aren't on disk → a crash in that window → permanent "Unable to decrypt"
for those Megolm sessions. Low probability (sync is sequential today), high impact.

**Fix options.**
- Get matrix-js-sdk to surface a per-batch "crypto persisted" event/await point, and
  ack off that instead of the next-sync heuristic. (Upstream ask, or patch.)
- Or move to a Node-native, incrementally-persisted crypto store (see #2), so "in
  the store" == "on disk" and the flush step disappears.
- Spec ask: have PROTOCOL D.2 explicitly bless the "ack on next-sync-after-flush"
  path for matrix-js-sdk-style clients.

---

## 2. Crypto store is in-RAM (`fake-indexeddb`) with full-dump snapshots

**What.** matrix-js-sdk's Rust crypto persists to IndexedDB, which doesn't exist in
Node. We shim it with `fake-indexeddb` (in-memory) and snapshot the whole store to a
JSON file (`idb-persistence.ts`): every 60s, on stop, and before each key-bearing
`sync_ack`.

**Why it's debt.** Each snapshot serializes the **entire** crypto store (no
incremental writes). On a busy bot with many sessions, the per-key-batch flush (#1)
re-dumps everything each time — wasteful, and grows with the store.

**Risk.** Performance (disk + CPU) under load; not a correctness issue.

**Fix.** Switch to `@matrix-org/matrix-sdk-crypto-nodejs` (sqlite/sled on real disk,
incremental writes) wired into `initRustCrypto`. Removes both the fake-DB and the
snapshot machinery, and makes #1's flush a no-op. Needs verifying the Node binding
plugs into matrix-js-sdk's `initRustCrypto` the same way the wasm one does.

---

## 3. Tool `args` is the display string, not raw JSON

**What.** PROTOCOL E `chat4000.tool.args` should be the tool's JSON args (≤2048 B).
We populate it from the OpenClaw item event's `meta` (a human-readable display
string). The real args arrive on a separate `onToolStart` (stream `"tool"`) event
that carries **no toolCallId**, so it can't be correlated back to the item.

**Why it's debt.** `args` renders fine in the bubble but isn't the literal JSON the
field is specified to hold.

**Risk.** Cosmetic / fidelity only.

**Fix.** Capture `onToolStart` args and correlate to the next item-start (timing +
name heuristic), or get OpenClaw to put `toolCallId` on the `onToolStart` payload so
it correlates cleanly.

---

## 4. `chat4000.turn_id` must stay encrypted — verify the SDK doesn't lift it

**What.** Tool events link to their turn anchor via the encrypted content field
`chat4000.turn_id` (PROTOCOL E), specifically chosen because `m.relates_to` gets
hoisted to cleartext by the crypto SDK. We rely on the SDK **not** treating
`chat4000.turn_id` as a relation.

**Why it's debt.** Unverified against a live encrypted event — it's a plain custom
field so it should stay inside the ciphertext, but we haven't captured one to
confirm.

**Risk.** If (somehow) lifted to cleartext, the turn grouping leaks to the
homeserver. Privacy, not correctness.

**Fix.** Capture one real `chat4000.tool` `m.room.encrypted` event and confirm
`chat4000.turn_id` is inside the ciphertext, not on the cleartext envelope.

---

## 5. Inbound media → agent depends on OpenClaw's media store path

**What.** Inbound images/voice are downloaded + decrypted (D.3) and offloaded to the
OpenClaw media store via `saveMediaBuffer`, passed to the agent as `MediaUrl`. Done
through a dynamically-imported `openclaw/plugin-sdk/media-store` cast to a local type.

**Why it's debt.** We cast the import shape by hand (no shared types) and rely on the
`MediaUrl`/`MediaPath`/`MediaType` context contract, which isn't type-checked across
the boundary.

**Risk.** Breaks silently if OpenClaw changes the media-store signature or the
inbound context fields. Falls back to a text caption on any error (no crash).

**Fix.** Pin to a typed plugin-SDK export if/when one is published; add a smoke test
against a real OpenClaw runtime.

---

## 6. Never run end-to-end against a live stack

**What.** All verification is `tsc` + 47 unit tests. No real Tuwunel + gateway +
registrar round-trip has happened (pairing, sync_ack key delivery across a
reconnect, media round-trip, tool bubbles rendering).

**Risk.** Integration-level surprises the unit tests can't catch — especially #1
(key delivery across a real disconnect) and #4 (turn_id encryption).

**Fix.** Stage run: `setup --self-redeem --stage` → pair → message round-trip → kill
the socket mid-key-delivery and confirm decryption survives → send/receive media →
run a tool-heavy turn and inspect the bubbles.

---

## 7. Binary-over-WS is a hard error (safety net)

**What.** The gateway transport throws on a binary `req` body. Media is supposed to
go over the HTTP media path (D.3), so this should never fire — it's a guard so a
stray binary send fails loudly instead of sending an empty body.

**Risk.** None expected; it's defensive.

**Fix.** Leave as-is unless a real binary-over-WS need appears.
