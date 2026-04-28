<div align="center">

# chat94 OpenClaw Plugin

Connect your **chat94** iPhone or Mac app to your **OpenClaw** agent.
End-to-end encrypted — the relay sees ciphertext only, never your conversations.

[![npm](https://img.shields.io/npm/v/@chat94/openclaw-plugin?color=brightgreen&label=npm)](https://www.npmjs.com/package/@chat94/openclaw-plugin)
[![license](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![openclaw](https://img.shields.io/badge/openclaw-%E2%89%A52026.4.1-orange)](https://openclaw.com)
[![status](https://img.shields.io/badge/status-active-success)](#)

</div>

---

## Install

```bash
openclaw plugin install @chat94/openclaw-plugin
openclaw gateway restart
openclaw chat94 setup
```

That's it. `setup` walks you through generating a local key and pairing with your device. After pairing, the plugin auto-connects whenever the gateway starts.

> **Note** — `gateway restart` works for launchd / systemd / schtasks. If you launched the gateway manually with `openclaw gateway run`, stop and rerun it instead.

To pair another device later:

```bash
openclaw chat94 pair
```

To check it's running:

```bash
openclaw chat94 status
```

---

## Useful commands

| Command | What it does |
|---|---|
| `openclaw chat94 status` | Connection state, key info, account |
| `openclaw chat94 sessions list` | All OpenClaw sessions you can bind to |
| `openclaw chat94 sessions current` | Current session binding for this account |
| `openclaw chat94 sessions bind --group X --session Y` | Link a chat94 group to an OpenClaw session |
| `openclaw chat94 sessions clear --group X` | Remove a binding |
| `openclaw chat94 telemetry status` | Is anonymous error reporting on? |
| `openclaw chat94 pair --pairing-log-level debug` | Pair with verbose logs |

Logs live at `~/.openclaw/plugins/chat94/logs/` — `runtime.log`, `pairing.log`, `errors.log`.

---

## Telemetry

Anonymous error reports help us fix bugs faster.

**Collected:** crash reports · stack traces · plugin & Node.js version · OS platform · anonymous install ID

**Never collected:** message content · AI prompts or responses · CLI args · env vars · file paths with your identity · API keys · your name, email, username, IP

Disable any time:

```bash
openclaw chat94 telemetry disable               # persistent
export CHAT94_TELEMETRY_DISABLED=1              # session
openclaw chat94 --no-telemetry <command>        # one command
```

Privacy policy → <https://chat94.com/privacy>

---

## Building from source

```bash
git clone git@github.com:chat94/chat94-openclaw-plugin.git
cd chat94-openclaw-plugin
npm install
npm run build
npm test
```

For a release build with Sentry telemetry baked in:

```bash
mkdir -p ~/.config/chat94
echo 'https://your-sentry-dsn' > ~/.config/chat94/sentry-dsn
npm run prepare-release
npm run build
```

`prepare-release` writes `src/telemetry-dsn.generated.ts` (gitignored, included in the npm package).

---

<div align="center">

**License** — [GPL-3.0-or-later](./LICENSE) · Copyright © 2026 NeonNode Limited

[chat94.com](https://chat94.com) · [Privacy](https://chat94.com/privacy) · [Terms](https://chat94.com/terms)

</div>
