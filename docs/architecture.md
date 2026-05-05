# chat4000 Plugin — Architecture

## Current State

This document describes the plugin as implemented in this repo.

The plugin now follows the group-key protocol model:
- the plugin owns first-key creation and stores the long-lived key in plugin-managed state
- `groupId` is derived as lowercase hex `sha256(groupKeyBytes)`
- relay `hello` uses `group_id`
- encrypted session payloads use XChaCha20-Poly1305 with the raw 32-byte group key
- pairing uses the protocol room flow:
  - `pair_open`
  - `pair_open_ok`
  - `pair_ready`
  - `pair_data`
  - `pair_complete`
  - `pair_cancel`
- legacy `pairKey` input is still accepted during migration, but is normalized into the group-key model internally

Important implementation boundary:
- the relay/session transport supports `text`, `image`, `audio`, `text_delta`, `text_end`, `status`, and `ack`
- the current OpenClaw outbound adapter invokes `sendText()` and URL-style `sendMedia()`
- streaming and status transport primitives exist in code; host-side callback wiring is now exercised by the channel runtime for streaming/status, and inbound `text`/`image`/`audio` are dispatched into the host

Reliable delivery layer (protocol §6.6):
- per-account SQLite state at `~/.openclaw/plugins/chat4000/state/<account>.sqlite`
- cumulative `recv_ack` emission with `last_acked_seq` reconnect replay (Flow A)
- encrypted inner `t: "ack"` emission for app-origin `text`/`image`/`audio` (Flow B)
- application-layer `ping`/`pong` distinct from WebSocket frame keepalive
- redrive dedupe by inner `msg_id`

## Folder Structure

```text
chat4000-plugin/
├── index.ts
├── package.json
├── openclaw.plugin.json
├── tsconfig.json
├── vitest.config.ts
├── docs/
│   ├── architecture.md
│   ├── product.md
│   ├── status.md
│   └── current-task.md
├── src/
│   ├── accounts.ts
│   ├── ack-store.ts
│   ├── channel-runtime.ts
│   ├── channel.ts
│   ├── crypto.ts
│   ├── cli.ts
│   ├── key-store.ts
│   ├── monitor-websocket.ts
│   ├── monitor.ts
│   ├── pairing.ts
│   ├── reconnect.ts
│   ├── recv-ack-batcher.ts
│   ├── send.ts
│   └── types.ts
├── tests/
│   ├── contract/
│   │   ├── helpers.ts
│   │   └── relay.test.ts
│   └── unit/
│       ├── accounts.test.ts
│       ├── ack-store.test.ts
│       ├── channel.test.ts
│       ├── crypto.test.ts
│       ├── monitor.test.ts
│       ├── protocol.test.ts
│       ├── reconnect.test.ts
│       ├── recv-ack-batcher.test.ts
│       └── send.test.ts
└── docker/
```

## Runtime Model

OpenClaw plugins run in-process inside the host. This plugin assumes:
- Node.js runtime access
- `ws` is available for relay connectivity
- logging is provided by the host logger when integrated
- runtime-heavy modules should stay out of the top-level entry where possible

`src/channel-runtime.ts` exists specifically to lazy-load runtime transport code only when the gateway starts.

## Data Model

### Config Model

Resolved connection settings use a fixed relay:
1. production chat4000 relay endpoint

Resolved key state comes from:
1. `CHAT4000_GROUP_KEY`
2. `groupKey` in `channels.chat4000`
3. legacy config `groupKey`
4. legacy config `pairKey`
5. plugin-managed key file

Default key-file path:
- `~/.openclaw/plugins/chat4000/keys/<account>.json`

Default ack/dedupe state path:
- `~/.openclaw/plugins/chat4000/state/<account>.sqlite`

There is no configurable encryption mode. The protocol is fixed to XChaCha20-Poly1305.

### Identity Model

- `groupKeyBytes`: raw 32-byte secret
- `groupId`: lowercase hex SHA-256 of `groupKeyBytes`
- relay routing uses `groupId`
- session encryption uses `groupKeyBytes`

### Inner Message Model

Encrypted session payload plaintext is JSON:

```json
{ "t": "<type>", "id": "<id>", "body": { ... }, "ts": 1713000000000 }
```

Supported inner message types:
- `text`
- `image`
- `audio`
- `text_delta`
- `text_end`
- `status`
- `ack`

Current handling:
- inbound `text`, `image`, and `audio` are dispatched into the OpenClaw runtime; for app-origin frames an encrypted Flow B `t: "ack"` (stage `received`) is emitted before the agent dispatch
- inbound `text_delta`, `text_end`, and `status` are parsed and logged, then ignored by the OpenClaw-facing layer (still Flow-A-acked at the relay layer)
- inbound `ack` frames are logged for telemetry; reserved for future plugin-side delivery indicators
- outbound helpers exist for all types except inbound-only `ack`-handling shape

## Connection Lifecycle

```text
channel.gateway.startAccount()
  -> monitorChat4000Provider()
    -> open ack store at ~/.openclaw/plugins/chat4000/state/<account>.sqlite
    -> resolve account
    -> runWithReconnect()
      -> connectOnce()
        -> open WebSocket
        -> read last_acked_seq from ack store for (group_id, role=plugin)
        -> send hello { role, group_id, device_token, app_version, release_channel, last_acked_seq? }
        -> wait for hello_ok { current_terms_version, version_policy?, plugin_version_policy? }
        -> expose send function + start app-layer ping/pong loop
        -> instantiate per-connection RecvAckBatcher
        -> dispatch msg / ack / pair_* frames; respond to relay ping with pong
```

Reconnect policy is handled by `src/reconnect.ts`:
- exponential backoff
- 2s initial delay
- 60s max delay
- jitter applied
- reset on successful connection
- application-layer `ping` is sent every 25s of write-idle; missed `pong` (15s) tears the socket down so the reconnect layer takes over

## Session Message Flow

### Outbound Text

```text
channel.outbound.sendText()
  -> sendMessageChat4000()
    -> resolve account
    -> fetch active sender by groupId
    -> build inner message { t: "text", id, body, ts }
    -> JSON.stringify
    -> encrypt with XChaCha20-Poly1305(groupKeyBytes)
    -> send relay envelope { version, type: "msg", payload: { msg_id, nonce, ciphertext } }
```

### Outbound Streaming / Status Transport

Transport helpers in `src/send.ts`:
- `sendStreamDelta(groupId, streamId, delta)`
- `sendStreamEnd(groupId, streamId, fullText)`
- `sendStatus(groupId, status)`
- `sendTypingIndicator(groupId)`

These are implemented at the relay transport layer and are now invoked by the channel gateway in `src/channel.ts` via the buffered block dispatcher: partial replies stream as `text_delta`, finals close the stream with `text_end`, and `status` transitions (`thinking`/`typing`/`idle`) are emitted around tool/compaction/reasoning boundaries. The OpenClaw outbound adapter still uses `sendText()` / URL-style `sendMedia()` for non-streaming agent responses.

### Inbound Text

```text
relay msg { msg_id, nonce, ciphertext, seq? }
  -> monitor-websocket.ts
  -> monitor.ts decrypts with groupKeyBytes
  -> parse inner JSON
  -> persist msg_id in ack store (INSERT OR IGNORE)
       -> if duplicate (relay redrive of already-processed msg_id):
          recv-ack the new seq and stop — do not re-dispatch and do not re-emit inner ack
  -> if app-origin text/image/audio with seq present and bodyValid:
       emit encrypted inner ack { t: "ack", body: { refs: msg_id, stage: "received" } }
       (idempotent on (group_id, refs, stage) via inner_acks table)
  -> dispatch inbound message to caller (agent runtime)
  -> queue outer seq into RecvAckBatcher (Flow A)
```

### Acknowledgement Layer (Flow A + Flow B)

Two independent ack flows, per protocol §6.6:

- **Flow A (`recv_ack`)** — plaintext outer envelope sent to the relay so it evicts persisted messages from the per-recipient queue. Cumulative `up_to_seq` (highest contiguous persisted seq) plus optional out-of-order `ranges`.
- **Flow B (inner `ack`)** — encrypted end-to-end receipt the originating app uses to flip its outbound message UI from "sent" to "delivered". Emitted once per `(refs, stage)` for app-origin `text`/`image`/`audio`.

Flush triggers for `recv_ack`:
- 32 newly persisted seqs pending
- 50 ms idle since the most recent persistence
- explicit `shutdown()` / clean disconnect

The watermark is persisted to SQLite **before** the `recv_ack` envelope is sent so a crash between send and fsync never re-acks a seq we may not have persisted.

Pre-ack relays (no `seq` on outbound `msg`) cause graceful degradation: no `recv_ack`, no `last_acked_seq`, no inner `ack`. Existing message flow is unaffected.

## Pairing Flow

The plugin now contains both:
- joiner-side pairing support
- initiator-side pairing support for plugin bootstrap / additional device pairing

Implemented flows:
1. plugin can generate/store the first long-lived key
2. plugin can initiate pairing with a temporary code
3. joiner can derive `room_id = sha256("pairing-v1:" || normalized_code)`
4. joiner can receive and unwrap the long-lived key
5. already-paired peers can reuse the same pairing protocol to add another client

Exact pairing crypto in `src/crypto.ts`:
- pairing code normalization
- pairing room id derivation
- proof construction using SHA-256 with required `0x00` separators
- X25519 shared-secret wrapping
- `wrap_key = sha256(shared_secret || "chat4000-pair-wrap-v1")`
- XChaCha20-Poly1305 wrapped-key encryption

## File Responsibilities

### `src/types.ts`

Central type definitions for:
- config types
- resolved accounts
- relay envelopes
- pairing payloads
- inner message shapes
- inbound message payloads

### `src/crypto.ts`

Protocol crypto utilities:
- `encrypt()`
- `decrypt()`
- `deriveGroupId()`
- `generateGroupKey()`
- `formatGroupQrUrl()`
- `parseGroupKey()`
- `normalizePairingCode()`
- `derivePairingRoomId()`
- `generatePairingJoinerKeypair()`
- `computePairingProof()`
- `wrapGroupKeyToJoiner()`
- `unwrapGroupKeyFromInitiator()`

Backward-compatible aliases remain exported for legacy pair-key naming, but new code should use the group-key helpers.

### `src/accounts.ts`

Resolves and validates channel account state:
- merges top-level and per-account config
- applies env var overrides
- loads plugin-managed key files
- parses legacy `groupKey` / `pairKey` overrides
- derives `groupId`
- marks invalid keys as unconfigured

### `src/monitor-websocket.ts`

Single-connection relay client:
- opens WebSocket
- sends protocol `hello` with optional `last_acked_seq`
- handles `hello_ok` (parses `version_policy` and `plugin_version_policy` and forwards them to the caller) and `hello_error`
- forwards `msg` (including relay-assigned `seq`)
- forwards `relay_recv_ack` to the caller (drives "sent" tick when surfaced)
- replies to relay-initiated app-layer `ping` with `pong`
- emits app-layer `ping` every 25 s of write-idle; tears the socket down on a missed `pong` (15 s)
- forwards pairing frames

### `src/ack-store.ts`

Persistent ack/dedupe layer backed by SQLite (better-sqlite3, WAL + `synchronous=FULL`). Per-account database at `~/.openclaw/plugins/chat4000/state/<account>.sqlite`. Tables:
- `meta(group_id, role, last_acked_seq)` — cumulative high-water mark for Flow A reconnect replay; monotonic
- `messages(msg_id PK, group_id, seq, inner_t, ts, persisted_at)` — idempotent application-layer log used to dedupe relay redrives
- `inner_acks(group_id, refs, stage, emitted_at)` — enforces "at most one Flow B ack per (refs, stage)" across redrives and process restarts

### `src/recv-ack-batcher.ts`

Flow A batcher. Buffers persisted seqs and flushes whichever fires first:
- 32 newly persisted seqs pending
- 50 ms idle since the most recent persistence
- explicit `shutdown()` / clean disconnect

Computes `up_to_seq` as the cumulative high-water mark (the highest seq for which every lower seq has been persisted). Out-of-order seqs above the watermark are reported as `[low, high]` ranges. The watermark is persisted to the ack store before the envelope is shipped.

### `src/monitor.ts`

High-level monitored connection manager:
- resolves account once
- opens (and caches) the per-account ack store
- wraps `connectOnce()` with reconnect policy; re-reads `last_acked_seq` from the ack store before every reconnect
- decrypts relay messages
- parses inner message JSON
- dedupes by inner `msg_id` so relay redrives never double-process
- emits encrypted Flow B `t: "ack"` (stage `received`) for app-origin `text`/`image`/`audio` after successful decode + body validation
- emits inbound `text`/`image`/`audio` to the caller for agent dispatch
- queues persisted outer `seq` values into the recv-ack batcher for Flow A
- final flush on disconnect/abort so the watermark is durable before reconnect

### `src/pairing.ts`

Joiner-side pairing workflow:
- manages room connection state
- reacts to `pair_ready` and `pair_data`
- computes proofs
- unwraps the granted `groupKey`
- returns `{ groupKeyBytes, groupId }`

This module does not yet persist the received key into host config automatically.

### `src/send.ts`

Outbound transport helpers:
- maintains active sender map keyed by `groupId`
- stores `groupKeyBytes` alongside the sender
- encrypts inner messages before relay send
- supports `text`, `text_delta`, `text_end`, `status`, and `ack` (Flow B)
- `sendInnerAck(groupId, refs, stage)` rides the same encrypted envelope path as user content; idempotency is enforced by the caller via the ack store

Implementation detail that matters:
- sender registration happens on connection, not on first inbound message
- outbound sends can therefore succeed immediately after relay connect

### `src/channel.ts`

OpenClaw-facing plugin surface:
- metadata
- config resolution/description
- gateway lifecycle (resolves agent route, records inbound session, runs the reply pipeline)
- inbound dispatch: routes `text`/`image`/`audio` into the OpenClaw agent runtime; streams partial replies via `text_delta`, finalizes with `text_end`, and emits `status` transitions around reasoning/tool/compaction boundaries
- outbound `sendText()` and URL-based `sendMedia()` for non-streaming send paths

Current limitations:
- inline media upload is still text-with-URL fallback; no native binary attachment send

### `src/channel-runtime.ts`

Lazy runtime barrel. This is the boundary that keeps runtime-only modules out of the plugin entry until needed.

### `index.ts`

Current exports:
- `chat4000Plugin`
- group-key helpers
- legacy pair-key aliases
- pairing helpers
- `joinPairingSession`

## Testing Architecture

### Unit Tests

Covered today:
- crypto roundtrip, corruption, parsing, group-id derivation
- pairing code normalization, room derivation, proof generation, and wrap/unwrap
- account resolution and env override behavior
- legacy pair-key migration compatibility
- send path inner-message shape and encryption
- protocol envelope format including pairing payload shapes
- plugin config surface
- reconnect backoff behavior
- ack store: watermark monotonicity, msg_id dedupe, inner-ack idempotency, persistence across close/reopen, per-(group_id, role) separation
- recv-ack batcher: count-threshold flush, idle flush, range collapse, gap-fill folding, watermark write before envelope ship, shutdown final-flush, no-op when nothing pending
- monitor: Flow B inner ack emission for app-origin text, no inner ack for malformed audio body (still Flow-A-acked), redrive dedupe (no double inner ack), pre-ack relay graceful degradation

### Contract Tests

Contract coverage exists for:
- `hello` connection success
- app/plugin routing
- offline queue behavior
- typing forwarding
- ciphertext passthrough
- session isolation
- ordering
- health endpoint visibility

Important environment constraint:
- contract tests require a real relay binary via `RELAY_BINARY`
- in this workspace they currently cannot run unless that binary exists

## Verification Status

Verified locally:
- `npm run build`
- `npm test`

Not verified in this workspace:
- `npm run test:contract`

Reason:
- relay binary missing at the expected path

## Documentation Maintenance

These docs must be updated whenever implementation changes alter:
- protocol behavior
- config/env vars
- pairing flow
- feature support status
- file responsibilities
- test coverage
- integration gaps

See `docs/documentation-template.md` for the maintenance contract.
