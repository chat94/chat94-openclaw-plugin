# 🤖 chat4000 OpenClaw Plugin

> Connect your chat4000 iPhone or Mac app to your OpenClaw agent.

<p align="center">
  <a href="https://www.npmjs.com/package/@chat4000/openclaw-plugin"><img alt="npm" src="https://img.shields.io/npm/v/@chat4000/openclaw-plugin?label=npm"></a>
  <a href="https://github.com/chat4000/chat4000-openclaw-plugin"><img alt="openclaw" src="https://img.shields.io/badge/openclaw-%E2%89%A52026.4.1-orange"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <a href="https://chat4000.com"><img alt="homepage" src="https://img.shields.io/badge/web-chat4000.com-9b59ff"></a>
  <a href="https://t.me/chat4000official"><img alt="telegram" src="https://img.shields.io/badge/chat-@chat4000official-26a5e4?logo=telegram&logoColor=white"></a>
</p>

An OpenClaw channel plugin that routes messages between your OpenClaw agent and the [chat4000 iOS/macOS app](https://github.com/chat4000/chat4000-apple) over an end-to-end encrypted relay. Same crypto, same pairing model, same protocol as the [Rust CLI](https://github.com/chat4000/chat4000-cli) — your agent becomes one more participant in your encrypted group.

---

## 🚀 Install

```sh
openclaw plugin install @chat4000/openclaw-plugin
openclaw gateway restart
openclaw chat4000 setup
```

`setup` writes a local key, then walks you through pairing — host a room (prints code + QR for your phone) or join one with a code from another device. After pairing, the plugin auto-connects whenever the gateway starts.

**From source:**
```sh
git clone https://github.com/chat4000/chat4000-openclaw-plugin
cd chat4000-openclaw-plugin
npm install && npm run build
openclaw plugin install $(pwd)
```

> **Note** — `openclaw gateway restart` works for launchd / systemd / schtasks. If you started the gateway with `openclaw gateway run` in a terminal, stop it (Ctrl+C) and rerun.

---

## ⚡ Commands

```sh
openclaw chat4000 setup                    # first-time install + pair
openclaw chat4000 pair                     # add another device
openclaw chat4000 status                   # connection + key info
openclaw chat4000 sessions list            # OpenClaw sessions you can bind to
openclaw chat4000 sessions current         # current binding
openclaw chat4000 sessions bind ...        # link a chat4000 group to a session
openclaw chat4000 sessions clear ...       # remove a binding
openclaw chat4000 telemetry status         # is anonymous error reporting on?
openclaw chat4000 --help                   # full flag list
```

### Upgrading

```sh
openclaw plugins install --force @chat4000/openclaw-plugin@latest
openclaw gateway restart
```

`--force` is required because OpenClaw refuses to overwrite an existing plugin without
it. The gateway must be restarted to load the new code.

If you're in a container without systemd, restart manually:

```sh
pkill -9 -f openclaw
nohup openclaw gateway run > /tmp/gw.out 2>&1 & disown
```

Since 1.1.5, the ack store auto-recovers from any stale `<account>.sqlite.lock/`
directory left by a previously-killed gateway, so kill-and-restart is safe and
no manual cleanup is needed.

Pair with verbose logs:
```sh
openclaw chat4000 pair --pairing-log-level debug
```

---

## 🆕 What's new in 1.1.0

**Reliable delivery** — the plugin now implements protocol §6.6 acknowledgements end to end:

- **Flow A (`recv_ack`)** — outer plaintext ack the relay uses to evict per-recipient queue entries. Cumulative `up_to_seq` plus optional out-of-order `ranges`. Flushed on 32 pending seqs, 50 ms idle, or clean shutdown.
- **Flow B (inner `t: "ack"`)** — encrypted end-to-end receipt the originating app uses to flip its outbound message UI from "sent" to "delivered". Emitted as soon as the plugin decrypts and parses an inbound app `text`/`image`/`audio` — no waiting for the agent to start replying.
- **Reconnect replay** — `hello.last_acked_seq` is read from a per-account SQLite store on every reconnect; the relay redrives only what we haven't durably acked.
- **Redrive dedupe** — duplicate inner `msg_id` values are recognized across reconnects and not re-dispatched to the agent.
- **App-layer keepalive** — outer `ping` every 25 s of write-idle, distinct from the WebSocket frame keepalive; reconnect on missed `pong`.

Pre-ack relays continue to work unchanged — no `recv_ack` is emitted, no inner `ack` is emitted, no behavior regression.

---

## 🔒 Security model

- **End-to-end encrypted.** XChaCha20-Poly1305 with a 32-byte group key. The relay sees ciphertext only.
- **Group key is the only durable secret** — stored at `~/.openclaw/plugins/chat4000/keys/<account>.json` with `0600` perms.
- **Pairing** is a short low-entropy code with proof exchange that binds the code to the exact room participants.
- **No plaintext logging.** Even at `debug` level, message bodies aren't written to disk.
- **Relay is transport-only.** The relay never sees plaintext or routes by content — only by `group_id` (a SHA-256 of the group key).

---

## 📊 Telemetry

The plugin sends anonymous **error reports only** to help us fix bugs faster.

**We collect:** crash reports & stack traces · plugin & Node.js version · OS platform/arch · anonymous install ID
**We never collect:** message content · AI prompts/responses · CLI args · environment variables · file paths with your username · API keys · your name/email/system username · your IP

```sh
openclaw chat4000 telemetry status              # see current state
openclaw chat4000 telemetry disable             # opt out persistently
openclaw chat4000 --no-telemetry <command>      # opt out for one command
export CHAT4000_TELEMETRY_DISABLED=1            # opt out via env
```

Privacy policy: <https://chat4000.com/privacy>

---

## 📁 Local data

| Path | What |
|---|---|
| `~/.openclaw/plugins/chat4000/keys/<account>.json` | Group key (paired identity), `0600` |
| `~/.openclaw/plugins/chat4000/instance.json` | Per-device id + display name |
| `~/.openclaw/plugins/chat4000/session-bindings.json` | chat4000 group ↔ OpenClaw session links |
| `~/.openclaw/plugins/chat4000/state/<account>.sqlite` | Reliable-delivery ack watermark + msg_id dedupe (since 1.1.0), `0600` |
| `~/.openclaw/plugins/chat4000/logs/runtime.log` | Connection & relay events |
| `~/.openclaw/plugins/chat4000/logs/pairing.log` | Pairing protocol trace |
| `~/.openclaw/plugins/chat4000/logs/errors.log` | Uncaught errors + stack traces |
| `~/.config/chat4000/` | Telemetry config (`install-id`, `telemetry-enabled`) |

---

## 🛰 Relay

Default relay endpoint (hard-coded, not configurable):

- **WebSocket:** `wss://relay.chat4000.com/ws`
- **Health:** `https://relay.chat4000.com/health`

---

## 🧱 Repo layout

```text
chat4000-openclaw-plugin/
├── src/
│   ├── channel.ts              OpenClaw channel surface
│   ├── crypto.ts               XChaCha20-Poly1305 + X25519 pairing
│   ├── pairing.ts              joiner + initiator pairing flows
│   ├── monitor.ts              relay monitor with reconnect + ack wiring
│   ├── send.ts                 outbound transport (incl. inner ack)
│   ├── ack-store.ts            SQLite watermark + msg_id dedupe (Flow A/B state)
│   ├── recv-ack-batcher.ts     cumulative recv_ack emission (Flow A)
│   ├── session-binding.ts      group ↔ session mapping
│   ├── cli.ts                  openclaw chat4000 ... commands
│   └── telemetry.ts            Sentry init + PII scrubbing
├── tests/
│   ├── unit/                   77 unit tests
│   └── contract/               relay protocol contract tests
├── docker/                     dev compose stack (gateway + relay)
├── scripts/
│   └── publish_npm.py          build + publish pipeline
├── openclaw.plugin.json        OpenClaw plugin manifest
└── README.md
```

---

## 🛠 Build & test

```sh
npm install
npm run build
npm test                         # unit tests
npm run test:contract            # contract tests (needs RELAY_BINARY)
npm run test:all                 # both
```

For a release build with Sentry telemetry baked in:

```sh
mkdir -p ~/.config/chat4000
echo 'https://your-sentry-dsn' > ~/.config/chat4000/sentry-dsn
npm run prepare-release
npm run build
```

`prepare-release` writes `src/telemetry-dsn.generated.ts` (gitignored, included in the npm package).

---

## 🤝 Contributing

Contributions welcome. Open a PR against `main`.

Talk to the team:
- 📨 Telegram: <https://t.me/chat4000official>
- 🌐 Web: <https://chat4000.com>
- 📚 Docs: <https://chat4000.com/help>

---

## 📜 License

chat4000-openclaw-plugin is licensed under the **GNU General Public License v3.0** (GPL-3.0). See [LICENSE](./LICENSE) for the full text.

Copyright © 2026 NeonNode Limited. All rights reserved.

**Commercial licensing:** if you want to use this plugin in a way GPL-3.0 doesn't allow (e.g. proprietary/closed-source distribution), contact <contact@chat4000.com>.
