# chat4000-plugin: Sentry Telemetry Implementation Spec

## Overview

chat4000-plugin sends anonymous error reports through Sentry. Telemetry is on by default, with a first-run terminal notice and multiple opt-out paths.

## Collected

- crash reports and stack traces
- handled exceptions
- plugin version, Node.js version, OS platform and architecture
- anonymous install ID stored at `~/.config/chat4000/install-id`

## Never Collected

- message content, prompts, or AI responses
- command-line arguments
- environment variables
- file contents
- user-identifying filesystem paths
- API keys, tokens, or credentials
- user name, email, or system username

## Opt Out

Persistent:

```bash
openclaw chat4000 telemetry disable
```

Environment:

```bash
CHAT4000_TELEMETRY_DISABLED=1
```

Single invocation:

```bash
openclaw chat4000 --no-telemetry <command>
```

## Files

```text
~/.config/chat4000/
├── install-id
├── notice-shown
└── telemetry-enabled
```

## Sentry

Sentry is initialized only when telemetry is enabled and the built-in runtime DSN is set. The DSN is embedded in the packaged plugin through a local generated file; it is not passed through runtime environment variables or user config.

Sentry auth tokens, project creation credentials, and release-upload credentials must stay outside the repository and are never shipped with the plugin.

Local release builds read the DSN from `~/.config/chat4000/sentry-dsn` and generate `src/telemetry-dsn.generated.ts` with:

```bash
npm run prepare-release
```

`src/telemetry-dsn.generated.ts` is ignored by git.

Events are scrubbed before send:

- absolute user paths are rewritten
- command arguments and environment data are removed
- common token and credential patterns are redacted

Sentry project settings should also enable server-side PII and credential scrubbers.
