# chat94 OpenClaw Plugin

OpenClaw channel plugin for chat94.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE). Copyright (C) 2026 NeonNode Limited.

## Telemetry

chat94-plugin sends anonymous error reports to help us fix bugs faster.

We collect:

- crash reports and stack traces
- plugin and Node.js version
- OS platform and architecture
- an anonymous install ID

We do not collect:

- message content, AI prompts, or AI responses
- command-line arguments
- environment variables
- file contents or filesystem paths containing your identity
- API keys, tokens, or credentials
- your name, email, or system username
- your IP address

Disable telemetry:

```bash
openclaw chat94 telemetry disable
export CHAT94_TELEMETRY_DISABLED=1
openclaw chat94 --no-telemetry <command>
```

Check status:

```bash
openclaw chat94 telemetry status
```

Privacy policy: https://chat94.com/privacy

### Release DSN

For local release builds, keep the Sentry DSN outside git:

```bash
mkdir -p ~/.config/chat94
printf '%s\n' 'https://your-sentry-dsn' > ~/.config/chat94/sentry-dsn
npm run prepare-release
npm run build
```

`npm run prepare-release` writes `src/telemetry-dsn.generated.ts`, which is ignored by git but included in the packaged plugin.
