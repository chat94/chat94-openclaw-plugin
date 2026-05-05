# chat4000 Plugin — Status

This file tracks implementation status against the numbered product features in `docs/product.md`.

Status values:
- `Implemented`
- `Partial`
- `Not Implemented`
- `Blocked`

## Feature Status

| ID | Feature | Status | Notes |
|----|---------|--------|-------|
| `1.1` | Group key generation | Implemented | Plugin bootstrap now generates and persists the long-lived key locally. |
| `1.2` | Group key persistence | Implemented | Primary storage now lives in plugin-managed state files; env/config remain as legacy/manual overrides. |
| `1.3` | Group identity derivation | Implemented | `groupId` is derived from the raw group key. |
| `1.4` | Pairing flow | Implemented | `src/pairing.ts` implements both initiator-side and joiner-side relay workflows. |
| `1.5` | Group-key configuration | Implemented | `groupKey` and `CHAT4000_GROUP_KEY` are the only supported raw key overrides. |
| `2.1` | WebSocket connection | Implemented | Relay connectivity exists in `src/monitor-websocket.ts`. |
| `2.2` | Hello handshake | Implemented | Hello sends `group_id`, plugin `app_version`, and `release_channel`; relay `current_terms_version` is logged as numeric policy metadata. |
| `2.3` | Reconnection | Implemented | Backoff and retry behavior implemented in `src/reconnect.ts`. |
| `2.4` | Multi-account support | Implemented | Top-level plus per-account config supported. |
| `2.5` | Pairing-room transport | Implemented | Pairing relay frames are modeled and handled by the websocket/pairing layers for both host and joiner roles. |
| `3.1` | End-to-end encryption | Implemented | XChaCha20-Poly1305 with raw group key. |
| `3.2` | Encrypted relay envelopes | Implemented | `msg` envelope wrapping implemented. |
| `3.3` | Inner message encoding | Implemented | Inner JSON messages are built before encryption. |
| `3.4` | Pairing proof generation | Implemented | Proof generation and verification helpers exist in `src/crypto.ts`. |
| `3.5` | Wrapped-key handling | Implemented | X25519 + XChaCha20-Poly1305 wrap/unwrap helpers exist and are tested. |
| `4.1` | Inbound text | Implemented | Monitor decrypts and dispatches inbound `text`/`image`/`audio` into the OpenClaw runtime via `src/channel.ts`; Flow B inner ack is emitted before agent dispatch. |
| `4.2` | Outbound text | Implemented | `sendMessageChat4000()` wired through outbound adapter. |
| `4.3` | Streaming text | Partial | Transport helpers exist, but host outbound streaming integration is not wired. |
| `4.4` | Status signaling | Partial | Transport helper exists, but host integration is not wired. |
| `4.5` | Typing signals | Implemented | Empty-payload relay typing envelopes supported. |
| `4.6` | Attachments and media | Partial | Current fallback is text plus media URL; full media transport not implemented. |
| `5.1` | Channel registration | Implemented | Channel surface exported as `chat4000`. |
| `5.2` | Account configuration surface | Implemented | Resolve/describe/configured-state behavior exists. |
| `5.3` | Gateway lifecycle | Implemented | Per-account gateway startup exists. |
| `5.4` | Outbound adapter | Partial | `sendText()` and URL-based `sendMedia()` exist; richer content and streaming hooks do not. |
| `5.5` | Inbound dispatch | Implemented | `src/channel.ts` now resolves the agent route, records the inbound session, runs the reply pipeline, and streams the response back through `text_delta`/`text_end`/`status` while emitting Flow B inner ack on receipt. |
| `5.6` | Runtime-safe loading | Implemented | Lazy runtime loading via `src/channel-runtime.ts`. |
| `5.7` | Pairing workflow surface | Implemented | Host/operator workflows now exist via `openclaw chat4000 setup|pair|status`, with `pair` non-interactive by default and `setup --no-pair` supported. |
| `6.1` | OpenClaw command | Implemented | Plugin registers a `chat4000` CLI root with setup, non-interactive pair, and status flows. |
| `6.2` | Build command | Implemented | `npm run build`. |
| `6.3` | Unit test command | Implemented | `npm test`. |
| `6.4` | Contract test command | Implemented | Command exists; requires external relay binary. |
| `6.5` | Full test command | Implemented | `npm run test:all`. |
| `6.6` | Watch mode | Implemented | `npm run test:watch`. |
| `7.1` | Environment variables | Implemented | `CHAT4000_GROUP_KEY`. |
| `7.2` | Config file shape | Implemented | Group-key model config supported; legacy pair-key accepted during migration. |
| `7.3` | Plugin manifest contract | Implemented | Manifest exposes current env vars. |
| `8.1` | Relay health visibility | Implemented | Covered by contract test expectations. |
| `8.2` | Verification workflow | Partial | Build and unit tests are validated locally; contract tests require a relay binary not present in this workspace. |
| `9.1` | Persistent ack watermark (Flow A) | Implemented | `src/ack-store.ts` SQLite store at `~/.openclaw/plugins/chat4000/state/<account>.sqlite`; per-`(group_id, role)` `last_acked_seq`. |
| `9.2` | Reconnect replay marker | Implemented | `hello.last_acked_seq` populated from the ack store on every reconnect by `src/monitor.ts`. |
| `9.3` | Cumulative `recv_ack` emission | Implemented | `src/recv-ack-batcher.ts` flushes on 32-pending / 50ms-idle / shutdown; `up_to_seq` + `ranges`. |
| `9.4` | Inner `ack` emission (Flow B) | Implemented | `sendInnerAck()` in `src/send.ts` plus idempotency table `inner_acks`; emitted for app-origin `text`/`image`/`audio` after decode. `processing`/`displayed` skipped per v1. |
| `9.5` | Message dedupe by `msg_id` | Implemented | `messages` table in the ack store; redrives are Flow-A-acked but never re-dispatched. |
| `9.6` | Application-layer keepalive | Implemented | App-layer `ping` every 25s of write-idle in `src/monitor-websocket.ts`; missed `pong` (15s) tears the socket down. |
| `9.7` | Pre-ack relay compatibility | Implemented | Inbound `msg` without `seq` skips both `recv_ack` queueing and inner ack emission; no `last_acked_seq` is advanced. |
| `9.8` | Version policy parsing | Implemented | `RelayHelloOkPayload.version_policy` is parsed and forwarded; `plugin_version_policy` is intentionally ignored by the plugin. |
| `10` | Future capability areas | Not Implemented | Reserved for later phases. |

## Current Verification State

Verified locally:
- `npm run build`
- `npm test`

Not verified in this workspace:
- `npm run test:contract`

Reason:
- missing relay binary for `RELAY_BINARY`
