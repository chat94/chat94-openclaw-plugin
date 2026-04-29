# chat94 Plugin — Status

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
| `1.5` | Group-key configuration | Implemented | `groupKey` and `CHAT94_GROUP_KEY` are the only supported raw key overrides. |
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
| `4.1` | Inbound text | Partial | Monitor layer parses and exposes inbound `text`, but full host dispatch is still TODO in `src/channel.ts`. |
| `4.2` | Outbound text | Implemented | `sendMessageChat94()` is wired through the normal outbound adapter, and queued chat94 replies are now recovered from OpenClaw's `delivery-queue` while connected. |
| `4.3` | Streaming text | Partial | Transport helpers exist, but host outbound streaming integration is not wired. |
| `4.4` | Status signaling | Partial | Transport helper exists, but host integration is not wired. |
| `4.5` | Typing signals | Implemented | Empty-payload relay typing envelopes supported. |
| `4.6` | Attachments and media | Partial | Current fallback is text plus media URL; full media transport not implemented. |
| `5.1` | Channel registration | Implemented | Channel surface exported as `chat94`. |
| `5.2` | Account configuration surface | Implemented | Resolve/describe/configured-state behavior exists. |
| `5.3` | Gateway lifecycle | Implemented | Per-account gateway startup exists. |
| `5.4` | Outbound adapter | Partial | `sendText()` and URL-based `sendMedia()` exist; queued/deferred chat94 replies are replayed from `delivery-queue`, but richer content and full host-managed streaming hooks still do not exist. |
| `5.5` | Inbound dispatch | Not Implemented | `src/channel.ts` still contains TODO integration comments rather than host dispatch. |
| `5.6` | Runtime-safe loading | Implemented | Lazy runtime loading via `src/channel-runtime.ts`. |
| `5.7` | Pairing workflow surface | Implemented | Host/operator workflows now exist via `openclaw chat94 setup|pair|status`, with `pair` non-interactive by default and `setup --no-pair` supported. |
| `6.1` | OpenClaw command | Implemented | Plugin registers a `chat94` CLI root with setup, non-interactive pair, and status flows. |
| `6.2` | Build command | Implemented | `npm run build`. |
| `6.3` | Unit test command | Implemented | `npm test`. |
| `6.4` | Contract test command | Implemented | Command exists; requires external relay binary. |
| `6.5` | Full test command | Implemented | `npm run test:all`. |
| `6.6` | Watch mode | Implemented | `npm run test:watch`. |
| `7.1` | Environment variables | Implemented | `CHAT94_GROUP_KEY`. |
| `7.2` | Config file shape | Implemented | Group-key model config supported; legacy pair-key accepted during migration. |
| `7.3` | Plugin manifest contract | Implemented | Manifest exposes current env vars. |
| `8.1` | Relay health visibility | Implemented | Covered by contract test expectations. |
| `8.2` | Verification workflow | Partial | Build and unit tests are validated locally; contract tests require a relay binary not present in this workspace. |
| `9` | Future capability areas | Not Implemented | Reserved for later phases. |

## Current Verification State

Verified locally:
- `npm run build`
- `npm test`

Not verified in this workspace:
- `npm run test:contract`

Reason:
- missing relay binary for `RELAY_BINARY`
