# chat94 Plugin — Product Specification

## Purpose

This document defines what the chat94 plugin is supposed to be and do.

This is the product contract. It describes scope, features, behaviors, and operator-facing workflows in a stable way.

Implementation progress does not belong here as the primary source of truth. Progress belongs in `docs/status.md`, which references the numbered features in this file.

## Product Overview

The chat94 plugin is an OpenClaw channel plugin that connects a chat94 iOS/macOS client to an OpenClaw agent through a relay server.

```text
chat94 app <-> relay server <-> OpenClaw plugin <-> OpenClaw agent
```

The relay is transport-only. Session plaintext is intended to be visible only to the app and plugin that share the long-lived group key.

## Product Goals

1. Provide a direct-message channel between the chat94 app and an OpenClaw agent.
2. Support secure relay transport using a long-lived 32-byte group key.
3. Support a pairing workflow where the plugin bootstraps the first key and later joiners receive that key through a temporary pairing room.
4. Support reliable reconnect behavior for long-running plugin sessions.
5. Support future expansion for richer mobile-first agent interaction without redesigning the core transport.

## Core Concepts

### Group Key

The long-lived session primitive is a 32-byte shared secret.

It is used for:
1. Routing identity: `group_id = lowercase_hex(sha256(groupKeyBytes))`
2. End-to-end encryption key material for encrypted session payloads

### Group Identity

`group_id` is derived from the raw group key. It is not independently operator-assigned.

### Pairing Room

Initial pairing is plugin-led.

Instead:
1. the plugin creates the long-lived `group_key`
2. the plugin opens a temporary pairing room derived from a short code
3. the first client joins that room
4. the plugin proves knowledge of the code and wraps the long-lived key to the joiner
5. later, any already-paired client may repeat the same flow to add another client

### Relay Role

The relay is expected to:
1. route traffic by `group_id`
2. forward encrypted message envelopes
3. forward online-only typing signals
4. forward pairing room events
5. queue offline message envelopes when supported by the relay
6. expose operational health data

The relay is not intended to hold message plaintext.

### Inner Message Format

Encrypted relay message payloads contain JSON with this shape:

```json
{ "t": "<type>", "id": "<id>", "body": { ... }, "ts": 1713000000000 }
```

## Numbered Product Features

### 1. Group Key and Pairing

#### 1.1 Group key generation

The plugin should generate the first long-lived group key locally during bootstrap.

Expected outputs:
- derived `group_id`
- durable plugin-owned local key state
- a temporary pairing code
- a QR/invite payload containing pairing metadata for the client

#### 1.2 Group key persistence

The product should persist the long-lived key outside normal OpenClaw channel config.

Expected behavior:
- relay and debug TLS settings stay in `channels.chat94`
- the long-lived key lives in plugin-managed durable storage
- environment/config-based key input may remain as a migration/override path, not the primary workflow

#### 1.3 Group identity derivation

The product should derive `group_id` from the raw key rather than accepting an arbitrary external identifier as the primary source of truth.

#### 1.4 Pairing flow

The product should support:
1. plugin-initiated first-client pairing
2. client-initiated additional-client pairing
3. joiner proof exchange
4. wrapped-key transfer
5. durable storage of the received long-lived key

#### 1.5 Legacy pair-key migration

The product may continue to accept legacy `pairKey` naming during migration, but the canonical model is `groupKey` / `groupId`.

### 2. Relay Connectivity

#### 2.1 WebSocket connection

The plugin should connect to the configured relay over WebSocket.

#### 2.2 Hello handshake

The plugin should identify itself to the relay as role `plugin` using a protocol hello message with `group_id`, `app_version`, and `release_channel`. Relay `hello_ok.current_terms_version` is a numeric policy version; the plugin should compare it only if a user-facing consent/terms gate exists.

#### 2.3 Reconnection

The plugin should retry on connection loss or handshake rejection according to protocol-compatible backoff behavior.

#### 2.4 Multi-account support

The plugin should support multiple configured accounts with independent key state.

#### 2.5 Pairing-room transport

The plugin should support relay pairing-room traffic for the joiner-side workflow.

### 3. Secure Message Transport

#### 3.1 End-to-end encryption

The plugin should encrypt session plaintext using the shared group key before relay transport.

#### 3.2 Encrypted relay envelopes

The plugin should wrap encrypted content in relay message envelopes with nonce and ciphertext fields.

#### 3.3 Inner message encoding

The plugin should wrap plaintext content in the inner JSON format defined by the shared Swift client protocol spec before encryption.

#### 3.4 Pairing proof generation

The plugin should generate pairing proofs exactly as defined by the protocol.

#### 3.5 Wrapped-key handling

The plugin should unwrap a granted long-lived group key using the protocol-defined X25519 + XChaCha20-Poly1305 flow.

### 4. Messaging

#### 4.1 Inbound text

The product should accept app-to-plugin text messages and make them available to the OpenClaw side as direct inbound chat content.

#### 4.2 Outbound text

The product should send agent text responses back to the app as encrypted relay messages.

#### 4.3 Streaming text

The product should support token or chunk streaming through:
- `text_delta`
- `text_end`

#### 4.4 Status signaling

The product should support explicit agent status signaling through the encrypted `status` inner message type.

#### 4.5 Typing signals

The product should support typing and typing-stop signals at the relay envelope layer.

#### 4.6 Attachments and media

The product should eventually support non-text outbound/inbound media flows beyond plain text URL fallback.

### 5. OpenClaw Integration

#### 5.1 Channel registration

The plugin should register as an OpenClaw channel named `chat94`.

#### 5.2 Account configuration surface

The plugin should expose account configuration resolution and configured/unconfigured state to the host.

#### 5.3 Gateway lifecycle

The plugin should expose gateway startup behavior for each configured account.

#### 5.4 Outbound adapter

The plugin should expose outbound host operations for sending text and, eventually, richer content.

#### 5.5 Inbound dispatch

The plugin should hand inbound app messages into the OpenClaw runtime in a way that produces agent replies within the correct session context.

#### 5.6 Runtime-safe loading

The plugin should avoid loading runtime-only dependencies until the channel gateway actually starts.

#### 5.7 Pairing workflow surface

The plugin should expose host-usable OpenClaw CLI workflows for:
- first-time setup
- starting another pairing session
- viewing current status

### 6. Commands and Operator Workflows

#### 6.1 OpenClaw commands

The product should provide:

```bash
openclaw chat94 setup
openclaw chat94 pair
openclaw chat94 setup --no-pair
openclaw chat94 status
```

Expected operator-facing output:
- no relay/TLS/log-level prompts for normal users
- non-interactive pairing
- pairing code
- QR/invite payload
- relay connection status updates
- success/failure summary

#### 6.2 Build command

The repo should support:

```bash
npm run build
```

#### 6.3 Unit test command

The repo should support:

```bash
npm test
```

#### 6.4 Contract test command

The repo should support:

```bash
npm run test:contract
```

#### 6.5 Full test command

The repo should support:

```bash
npm run test:all
```

#### 6.6 Watch mode

The repo should support:

```bash
npm run test:watch
```

### 7. Configuration

#### 7.1 Environment variables

The product should support:

| Variable | Meaning | Default |
|----------|---------|---------|
| `CHAT94_GROUP_KEY` | manual raw group key override in base64url or hex | none |

#### 7.2 Config file shape

The product should support a channel config of this form:

```json
{
  "channels": {
    "chat94": {
      "enabled": true,
      "accounts": {
        "work": {
          "enabled": true
        }
      }
    }
  }
}
```

The long-lived `groupKey` is expected to live in plugin-managed durable storage rather than normal channel config.

The relay is fixed to the production chat94 endpoint and is not operator-configurable.

Legacy `groupKey` / `pairKey` config may still be accepted during migration or manual override scenarios.

#### 7.3 Plugin manifest contract

The plugin manifest should expose the required channel env vars for `chat94`.

### 8. Observability and Validation

#### 8.1 Relay health visibility

The system should expose relay health data that operators can use to verify server status and connected client counts.

#### 8.2 Verification workflow

The repo should provide commands that let operators verify:
- the code builds
- the unit suite passes
- relay contract behavior passes when the external relay binary is available

### 9. Future Capability Areas

These are intended future feature areas and are not part of the minimum contract unless promoted into numbered features above:
- reactions
- edit/delete
- replies/threading
- agent tools
- HTML cards
- link previews
- location sharing
- talk mode / voice
- multi-session support

## Command Surface Summary

### Product Commands

```bash
openclaw chat94 setup
openclaw chat94 pair
openclaw chat94 setup --no-pair
openclaw chat94 status
```

### Repository Commands

```bash
npm run build
npm test
npm run test:contract
npm run test:all
npm run test:watch
```

## Relationship To Status Tracking

`docs/status.md` must track implementation state against the numbered feature IDs above.

Example:
- `1.1` means group key generation
- `1.4` means pairing flow
- `4.3` means streaming text
- `5.5` means inbound dispatch into the OpenClaw runtime

Do not duplicate the full status matrix here when `docs/status.md` is the active source of implementation status.
