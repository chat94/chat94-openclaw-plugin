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
- the relay/session transport supports `text`, `text_delta`, `text_end`, and `status`
- the current OpenClaw outbound adapter invokes `sendText()` and URL-style `sendMedia()`
- streaming and status transport primitives exist in code, but host-side callback wiring is still incomplete
- deferred chat4000 replies can also arrive through OpenClaw's generic `delivery-queue`; the plugin now runs a recovery loop while connected so queued chat4000 payloads are replayed directly over the live relay sender

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
│   ├── channel-runtime.ts
│   ├── channel.ts
│   ├── crypto.ts
│   ├── cli.ts
│   ├── key-store.ts
│   ├── monitor-websocket.ts
│   ├── monitor.ts
│   ├── pairing.ts
│   ├── reconnect.ts
│   ├── send.ts
│   └── types.ts
├── tests/
│   ├── contract/
│   │   ├── helpers.ts
│   │   └── relay.test.ts
│   └── unit/
│       ├── accounts.test.ts
│       ├── channel.test.ts
│       ├── crypto.test.ts
│       ├── protocol.test.ts
│       ├── reconnect.test.ts
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
- `text_delta`
- `text_end`
- `status`

Current handling:
- inbound `text` is delivered to the caller
- inbound `text_delta`, `text_end`, and `status` are parsed and logged, then ignored by the OpenClaw-facing layer
- outbound helpers exist for all four types

## Connection Lifecycle

```text
channel.gateway.startAccount()
  -> monitorChat4000Provider()
    -> resolve account
    -> runWithReconnect()
      -> connectOnce()
        -> open WebSocket
        -> send hello { role, group_id, device_token, app_version, release_channel }
        -> wait for hello_ok { current_terms_version }
        -> expose send function on connect
        -> dispatch msg / typing / typing_stop
        -> optionally dispatch pairing frames
```

Reconnect policy is handled by `src/reconnect.ts`:
- exponential backoff
- 2s initial delay
- 60s max delay
- jitter applied
- reset on successful connection

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

These are implemented at the relay transport layer. They are not yet fully invoked by the OpenClaw outbound adapter in `src/channel.ts`.

### Deferred / Queued Outbound Recovery

```text
OpenClaw async reply path
  -> writes delivery-queue/*.json for channel=chat4000
  -> plugin recovery loop sees a live chat4000 sender
  -> matching queued payloads are replayed with sendMessageChat4000()
  -> recovered queue file is deleted
```

This path matters for:
- queued "while agent was busy" replies
- other deferred chat4000 deliveries that the host chooses to enqueue

### Inbound Text

```text
relay msg
  -> monitor-websocket.ts
  -> monitor.ts decrypts with groupKeyBytes
  -> parse inner JSON
  -> if t === "text", emit inbound message to caller
```

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
- sends protocol `hello`
- handles `hello_ok` and `hello_error`
- forwards `msg`
- forwards `typing` and `typing_stop`
- forwards pairing frames
- does not emit or expect `msg_ack`

### `src/monitor.ts`

High-level monitored connection manager:
- resolves account once
- wraps `connectOnce()` with reconnect policy
- decrypts relay messages
- parses inner message JSON
- emits inbound `text`
- stores the active send function while connected

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
- supports text, stream delta, stream end, status, typing

Implementation detail that matters:
- sender registration happens on connection, not on first inbound message
- outbound sends can therefore succeed immediately after relay connect

### `src/channel.ts`

OpenClaw-facing plugin surface:
- metadata
- config resolution/description
- gateway lifecycle
- outbound `sendText()` and `sendMedia()`
- deferred delivery recovery while connected

Current limitations:
- no host-side streaming integration yet
- queued recovery currently replays text plus media-URL fallback from `delivery-queue`; it does not reconstruct richer channel-native attachments

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
