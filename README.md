# chat94 OpenClaw Plugin

Connect your chat94 iPhone or Mac app to your OpenClaw agent. Messages flow over an end-to-end encrypted relay — the relay sees ciphertext only, never your conversations.

## Install

```bash
# 1. Install the plugin
openclaw plugin install @chat94/openclaw-plugin

# 2. Restart the OpenClaw gateway (however you run it)
#    docker restart openclaw-gateway
#    or kill and rerun: openclaw gateway run

# 3. Pair with your chat94 app
openclaw chat94 setup

# 4. Verify it's running
openclaw chat94 status
```

`setup` walks you through generating a local key and pairing with your device. After that the plugin auto-connects whenever the gateway starts.

To pair another device later:

```bash
openclaw chat94 pair
```

## Useful commands

```bash
openclaw chat94 status                 # connection + key info
openclaw chat94 sessions list          # see OpenClaw sessions
openclaw chat94 sessions current       # current binding for this account
openclaw chat94 sessions bind ...      # link a chat94 group to an OpenClaw session
openclaw chat94 telemetry status       # is telemetry on?
```

## Telemetry

Anonymous error reports help us fix bugs faster.

**We collect:** crash reports, stack traces, plugin and Node.js version, OS platform/architecture, an anonymous install ID.

**We do NOT collect:** message content, AI prompts or responses, command-line arguments, environment variables, file paths containing your identity, API keys or credentials, your name, email, username, or IP address.

Disable any time:

```bash
openclaw chat94 telemetry disable               # persistent
export CHAT94_TELEMETRY_DISABLED=1              # session
openclaw chat94 --no-telemetry <command>        # one command
```

Privacy policy: https://chat94.com/privacy

## Building from source

```bash
npm install
npm run build
npm test
```

For release builds with Sentry telemetry baked in:

```bash
mkdir -p ~/.config/chat94
echo 'https://your-sentry-dsn' > ~/.config/chat94/sentry-dsn
npm run prepare-release
npm run build
```

`prepare-release` writes `src/telemetry-dsn.generated.ts` (gitignored, but included in the published package).

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
Copyright © 2026 NeonNode Limited.
