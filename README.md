# 🤖 chat94 OpenClaw Plugin

> Connect your chat94 iPhone or Mac app to your OpenClaw agent.

<p align="center">
  <a href="https://www.npmjs.com/package/@chat94/openclaw-plugin"><img alt="npm" src="https://img.shields.io/npm/v/@chat94/openclaw-plugin?label=npm"></a>
  <a href="https://github.com/chat94/chat94-openclaw-plugin"><img alt="openclaw" src="https://img.shields.io/badge/openclaw-%E2%89%A52026.4.1-orange"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <a href="https://chat94.com"><img alt="homepage" src="https://img.shields.io/badge/web-chat94.com-9b59ff"></a>
  <a href="https://t.me/chat94official"><img alt="telegram" src="https://img.shields.io/badge/chat-@chat94official-26a5e4?logo=telegram&logoColor=white"></a>
</p>

An OpenClaw channel plugin that routes messages between your OpenClaw agent and the [chat94 iOS/macOS app](https://github.com/chat94/chat94-apple) over an end-to-end encrypted relay. Same crypto, same pairing model, same protocol as the [Rust CLI](https://github.com/chat94/chat94-cli) — your agent becomes one more participant in your encrypted group.

---

## 🚀 Install

```sh
openclaw plugins install @chat94/openclaw-plugin
openclaw gateway restart
openclaw chat94 setup
```

`setup` writes a local key, then walks you through pairing — host a room (prints code + QR for your phone) or join one with a code from another device. After pairing, the plugin auto-connects whenever the gateway starts.

**Pin a specific version or dist-tag:**
```sh
openclaw plugins install @chat94/openclaw-plugin@1.0.0
openclaw plugins install @chat94/openclaw-plugin@test     # pre-release channel
```

**From source:**
```sh
git clone https://github.com/chat94/chat94-openclaw-plugin
cd chat94-openclaw-plugin
npm install && npm run build
openclaw plugins install $(pwd)
```

> **Note** — `openclaw gateway restart` works for launchd / systemd / schtasks. If you started the gateway with `openclaw gateway run` in a terminal, stop it (Ctrl+C) and rerun. Inside a Docker container, `gateway restart` won't work — restart the container instead (`docker restart <name>`).

---

## 🔄 Update

```sh
openclaw plugins update @chat94/openclaw-plugin            # latest tracked version
openclaw plugins update @chat94/openclaw-plugin@1.0.1      # exact version
openclaw plugins update @chat94/openclaw-plugin@test       # latest test build
openclaw gateway restart
```

Pass the **full npm spec** (with dist-tag or version) — `openclaw plugins update chat94 --version X` is **not** a valid syntax. Update preserves your local state (keys, pairing, session bindings); only the plugin code is replaced.

---

## ⚡ Commands

```sh
openclaw chat94 setup                    # first-time install + pair
openclaw chat94 pair                     # add another device
openclaw chat94 status                   # connection + key info
openclaw chat94 sessions list            # OpenClaw sessions you can bind to
openclaw chat94 sessions current         # current binding
openclaw chat94 sessions bind ...        # link a chat94 group to a session
openclaw chat94 sessions clear ...       # remove a binding
openclaw chat94 telemetry status         # is anonymous error reporting on?
openclaw chat94 --help                   # full flag list
```

Pair with verbose logs:
```sh
openclaw chat94 pair --pairing-log-level debug
```

---

## 🔒 Security model

- **End-to-end encrypted.** XChaCha20-Poly1305 with a 32-byte group key. The relay sees ciphertext only.
- **Group key is the only durable secret** — stored at `~/.openclaw/plugins/chat94/keys/<account>.json` with `0600` perms.
- **Pairing** is a short low-entropy code with proof exchange that binds the code to the exact room participants.
- **No plaintext logging.** Even at `debug` level, message bodies aren't written to disk.
- **Relay is transport-only.** The relay never sees plaintext or routes by content — only by `group_id` (a SHA-256 of the group key).

---

## 📊 Telemetry

The plugin sends anonymous **error reports only** to help us fix bugs faster.

**We collect:** crash reports & stack traces · plugin & Node.js version · OS platform/arch · anonymous install ID
**We never collect:** message content · AI prompts/responses · CLI args · environment variables · file paths with your username · API keys · your name/email/system username · your IP

```sh
openclaw chat94 telemetry status              # see current state
openclaw chat94 telemetry disable             # opt out persistently
openclaw chat94 --no-telemetry <command>      # opt out for one command
export CHAT94_TELEMETRY_DISABLED=1            # opt out via env
```

Privacy policy: <https://chat94.com/privacy>

---

## 📁 Local data

| Path | What |
|---|---|
| `~/.openclaw/plugins/chat94/keys/<account>.json` | Group key (paired identity), `0600` |
| `~/.openclaw/plugins/chat94/instance.json` | Per-device id + display name |
| `~/.openclaw/plugins/chat94/session-bindings.json` | chat94 group ↔ OpenClaw session links |
| `~/.openclaw/plugins/chat94/logs/runtime.log` | Connection & relay events |
| `~/.openclaw/plugins/chat94/logs/pairing.log` | Pairing protocol trace |
| `~/.openclaw/plugins/chat94/logs/errors.log` | Uncaught errors + stack traces |
| `~/.config/chat94/` | Telemetry config (`install-id`, `telemetry-enabled`) |

---

## 🛰 Relay

Default relay endpoint (hard-coded, not configurable):

- **WebSocket:** `wss://relay.chat94.com/ws`
- **Health:** `https://relay.chat94.com/health`

---

## 🧱 Repo layout

```text
chat94-openclaw-plugin/
├── src/
│   ├── channel.ts              OpenClaw channel surface
│   ├── crypto.ts               XChaCha20-Poly1305 + X25519 pairing
│   ├── pairing.ts              joiner + initiator pairing flows
│   ├── monitor.ts              relay monitor with reconnect
│   ├── send.ts                 outbound transport
│   ├── session-binding.ts      group ↔ session mapping
│   ├── cli.ts                  openclaw chat94 ... commands
│   └── telemetry.ts            Sentry init + PII scrubbing
├── tests/
│   ├── unit/                   41 unit tests
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
mkdir -p ~/.config/chat94
echo 'https://your-sentry-dsn' > ~/.config/chat94/sentry-dsn
npm run prepare-release
npm run build
```

`prepare-release` writes `src/telemetry-dsn.generated.ts` (gitignored, included in the npm package).

---

## 🤝 Contributing

Contributions welcome. Open a PR against `main`.

Talk to the team:
- 📨 Telegram: <https://t.me/chat94official>
- 🌐 Web: <https://chat94.com>
- 📚 Docs: <https://chat94.com/help>

---

## 📜 License

chat94-openclaw-plugin is licensed under the **GNU General Public License v3.0** (GPL-3.0). See [LICENSE](./LICENSE) for the full text.

Copyright © 2026 NeonNode Limited. All rights reserved.

**Commercial licensing:** if you want to use this plugin in a way GPL-3.0 doesn't allow (e.g. proprietary/closed-source distribution), contact <contact@chat94.com>.
