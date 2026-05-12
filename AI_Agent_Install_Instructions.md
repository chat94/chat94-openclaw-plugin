# AI Agent Install Instructions

> **Who this file is for:** another AI coding assistant (Claude Code, Codex, Cursor, etc.) operating in someone's terminal. The reader's job is to install the chat4000 OpenClaw plugin into the user's existing OpenClaw setup, then help the user pair at least one chat4000 client and verify the end-to-end flow.
>
> **What "done" looks like:** the user sends a message from their paired chat4000 client, the bubble shows two ticks (✓✓), and the OpenClaw agent's reply appears in the same client.

---

## 0. Locate OpenClaw and establish a session

**Before anything else, figure out which machine OpenClaw is on and how you can reach it.** This step is the most commonly skipped one, and skipping it leads to the agent quietly installing the plugin in the wrong place.

### 0.1. Ask the user where OpenClaw lives

OpenClaw can be:

- **Local** — running on the same machine you're operating on right now (your current shell environment).
- **Remote** — running on a server, VM, container host, or another developer machine. You need to connect to it before any of the install commands below will hit the right system.

If your existing context already strongly implies one of these (for example, the user has been editing files on a specific remote host this session, or `CLAUDE.md` / repo notes name a specific server, or there's an already-open SSH session in scope), **proactively offer that machine as the suggested target** rather than asking blind. Phrase it like:

> Based on context, I think OpenClaw is on `dev.example.com` — should I run the install there, or somewhere else?

Otherwise, ask plainly:

> Is OpenClaw running on this machine, or on a remote machine I need to connect to?

### 0.2. If remote, get the connection details

If remote, you need a way to run shell commands on that host. Ask the user, in order:

1. **Connection method** — SSH (default), `gcloud compute ssh`, `aws ssm start-session`, `kubectl exec`, `docker exec`, or something else?
2. **Address** — `user@host`, instance id, container name, etc.
3. **Auth** — does the SSH config already work (`ssh devbox` Just Works™), or do they need to point you at a specific identity file, jump host, or port? Don't guess; for security-sensitive things like SSH keys, ask explicitly. If it's not already in your context, the user has to tell you.
4. **A quick connectivity test** before anything else:

   ```bash
   ssh devbox "echo connected && uname -a"
   ```

   If that returns within a couple of seconds and prints `connected`, you're good. If it hangs or fails, fix that with the user before continuing — the rest of this document is wasted time otherwise.

From here on, every command in this document that says `openclaw …` or `~/.openclaw/…` is meant to run **on the OpenClaw host**, not on your local machine (unless they're the same). When you write commands, wrap them appropriately for the connection method, e.g.:

```bash
# Local:
openclaw plugin install @chat4000/openclaw-plugin

# Remote via SSH:
ssh devbox "openclaw plugin install @chat4000/openclaw-plugin"
```

### 0.3. Verify OpenClaw is actually installed there

Once you can reach the right machine, confirm OpenClaw exists on it:

```bash
openclaw --version                  # local
ssh devbox "openclaw --version"     # remote
```

If that command is not found, **stop**. Tell the user:

> OpenClaw is required and not detected on `<machine>`. Install OpenClaw first (use its own installation instructions), make sure `openclaw --version` works there, then re-run this setup.

Do not try to install OpenClaw yourself. The plugin is meaningless without it. This document does NOT walk through OpenClaw installation.

---

## 1. What you are about to do

This setup has four phases. Do them in order.

| Phase | What                                                        | Who does it |
| ----- | ----------------------------------------------------------- | ----------- |
| **0** | Locate OpenClaw (local vs remote) and open a session to it  | Mixed       |
| **1** | Install the chat4000 plugin into OpenClaw                   | You (AI)    |
| **2** | Install + pair one or more chat4000 clients (CLI/iOS/macOS) | Mixed       |
| **3** | Verify the round-trip with a real message                   | Mostly you  |

Phase 2 has three possible client types. The user chooses one or more:

- **CLI** — you can install this end-to-end with `brew`.
- **iOS app** — the user has to install it from the App Store themselves; you guide them.
- **macOS app** — the user has to install it from the Mac App Store themselves; you guide them.

Ask the user up front which clients they want. Most people pick one (the CLI is the easiest path for AI-driven setups; iOS is the most polished day-to-day experience).

---

## 2. Phase 1 — Install the plugin into OpenClaw

### 2.1. Install the npm package

The chat4000 channel plugin is published to npm as `@chat4000/openclaw-plugin`. OpenClaw installs plugins through its own CLI; do **not** run a bare `npm install`.

```bash
openclaw plugin install @chat4000/openclaw-plugin
```

Expected output ends with something like:

```
✓ Installed @chat4000/openclaw-plugin@<version>
```

If the command errors out:

- **`openclaw: command not found`** — Phase 0 prerequisite failed; the user does not actually have OpenClaw installed and reachable on PATH. Stop and tell them.
- **`unknown command "plugin"`** — the OpenClaw CLI on this machine is older or shaped differently than expected. Have the user run `openclaw --help` and look for the plugin-install subcommand under whatever name it uses (it might be `plugins install` plural on some versions). Pass the npm package name through that command.

### 2.2. Restart the OpenClaw gateway

This is mandatory. The plugin only gets picked up when the gateway process restarts and re-reads its plugin registry. Skipping this step is the single most common reason setup appears to succeed but pairing fails with "no such channel" or the plugin never connects.

Which restart command applies depends on how the user runs OpenClaw. Try, in this order:

```bash
# 1. If they run openclaw under docker (most common production setup):
docker restart openclaw-gateway

# 2. If they run it directly via `openclaw gateway run` in a terminal:
#    Tell them to Ctrl-C that process and start it again.

# 3. Some installs expose a built-in restart command:
openclaw gateway restart
```

You can't always tell which one applies. Best is to ask the user: "How do you currently run the OpenClaw gateway — under Docker, in a terminal, or some other way?" Then issue the matching command. If unsure, default to suggesting both `docker restart openclaw-gateway` and the manual Ctrl-C path and let them pick.

After the restart, confirm the plugin is registered:

```bash
openclaw chat4000 status
```

The first time this is run before pairing, it should show something like:

```
account: default
pairing log level: info
runtime log level: info
key source: missing
key file: /home/<user>/.openclaw/plugins/chat4000/keys/default.json
group id: (missing)
configured: no
```

`configured: no` is correct at this stage. If `openclaw chat4000 status` itself errors with "unknown command chat4000", the gateway restart didn't actually pick the plugin up. Restart again, and double-check the install command succeeded.

### 2.3. Start a pairing session

```bash
openclaw chat4000 pair
```

This single command does everything needed for the plugin side:

1. Writes the chat4000 channel config into the OpenClaw config file (if it isn't already there).
2. **If no local group key exists yet**, mints a fresh 32-byte one and writes it to `~/.openclaw/plugins/chat4000/keys/default.json` (chmod 600). On subsequent runs, the existing key is reused — so the first `pair` and every later `pair` are exactly the same command; only the first one mints.
3. Generates a pairing code like `ABCD-2346`, derives the matching room id, and starts a pairing session — prints the code plus a big ASCII banner plus an ASCII QR, and waits for a client to join.

Expected output during the wait (abridged):

```
Saved chat4000 settings.
Created local chat4000 key.
Key file: /home/<user>/.openclaw/plugins/chat4000/keys/default.json
Pairing code: ABCD-2346
...big ASCII banner with the code drawn as ASCII art...
QR payload: chat4000://pair?code=ABCD-2346
[1/5] Opening pairing session
[2/5] Connected to relay
[3/5] Waiting for client to join
```

(On the second and later runs of `pair`, the "Created local chat4000 key" line will be absent — the existing key is reused.)

It will **block** here until a client pairs. That is the cue to move to Phase 2. **Leave this terminal running** — do not kill it. If you need to run other commands, open a second terminal.

Take note of the pairing code (e.g. `ABCD-2346`) — Phase 2 needs it.

> Aside: there is also an `openclaw chat4000 setup` subcommand. It does the same `pair` flow internally, just with a couple of additional config-write side effects up front. For first-time installs you do NOT need it — `pair` alone is enough. Use `setup` only if the user explicitly asks to run an interactive wizard.

### 2.4. What you just created

After Phase 1, the user has these files on disk (Linux/macOS paths shown; on macOS the home is typically `/Users/<name>`):

```
~/.openclaw/plugins/chat4000/
├── keys/
│   └── default.json              ← 32-byte group key (chmod 600) — THE secret
├── state/
│   └── default.sqlite            ← ack high-water mark + dedupe table
├── instance.json                 ← per-install device id (random UUID)
├── session-bindings.json         ← which OpenClaw session chat4000 talks to (optional)
└── logs/
    ├── pairing.log               ← every pair_* frame, useful for diagnosing pairing
    ├── runtime.log               ← every msg/ack frame at runtime
    └── errors.log                ← stack traces for caught exceptions
```

If anything in the next phases goes wrong, those log files are the first place to look — `tail -f ~/.openclaw/plugins/chat4000/logs/pairing.log` while pairing, and `tail -f ~/.openclaw/plugins/chat4000/logs/runtime.log` while sending a test message, will show every frame the plugin sees on the wire.

---

## 3. Phase 2 — Install + pair a client

Three client options. Pick whichever the user asks for; you can also install more than one against the same plugin — each client just pairs separately, and they all sync the same encrypted thread.

### 3.1. Client: chat4000 CLI (AI-installable)

**Recommended for AI-driven setups.** End-to-end installable from the terminal, no App Store involvement.

#### 3.1.1. Install via Homebrew

```bash
brew install chat4000/tap/chat4000
```

Verify:

```bash
chat4000 --version
```

If brew isn't installed, the user has to install Homebrew first (https://brew.sh). Don't try to install brew yourself unless the user asks.

If brew is installed but the tap fails, the user can also `cargo install` from the chat4000-cli-rs repo (see `clawconnect-cli-rs/README.md`); that path is rare and only needed on platforms brew doesn't cover.

#### 3.1.2. Pair the CLI

The CLI is interactive by default. The simplest path:

```bash
chat4000 pair
```

It prompts:

```
Enter pairing code:
```

Paste the code from Phase 2.3 (`ABCD-2346`) and press Enter. Expected sequence:

```
• Opening pairing room…
✓ Paired.
[connected · group abcd1234…]
```

Both terminals — the plugin's `openclaw chat4000 pair` and the CLI's `chat4000 pair` — should print success at the same moment. The plugin terminal will now exit (pairing is one-shot) and is safe to close.

If `chat4000 pair` reports `Pairing cancelled` or `Pairing socket closed`, the plugin terminal probably timed out. Re-run `openclaw chat4000 pair` on the plugin side to start a fresh code, then re-run `chat4000 pair` on the client side.

#### 3.1.3. Sanity-check the CLI session

```bash
chat4000 status
```

Expected:

```
Status: paired
Group ID: <hex>
Relay handshake: ok
Config: ~/Library/Application Support/chat4000/group-config.json
History: ~/Library/Application Support/chat4000/history.jsonl
```

(`~/.local/share/chat4000/...` on Linux instead of `~/Library/Application Support/...`.)

The CLI is now ready for Phase 3 verification.

### 3.2. Client: chat4000 iOS app (user-installable only)

You **cannot** install this for the user. Walk them through it.

Give the user these steps verbatim:

1. On the iPhone, open the **App Store**.
2. Search for **chat4000** and install the app (publisher: NeonNode Ltd).
3. Open chat4000.
4. On the pairing screen, type the 8-character pairing code from earlier (`ABCD-2346`) into the boxes, **or** tap **Scan QR** and point the camera at the ASCII QR the plugin terminal printed during Phase 2.3.
5. When it shows "✓ Paired" / drops them into the chat view, pairing is done.

If the pairing window on the plugin side has already expired (default room TTL is 7 days but the visible code is one-shot per successful join), have the user trigger a new code:

```bash
openclaw chat4000 pair
```

…and try again with that code.

### 3.3. Client: chat4000 macOS app (user-installable only)

Same drill as iOS, but Mac App Store:

1. On the Mac, open the **Mac App Store** (the silver "A" icon, not the Apple's-software "App Store" inside System Settings).
2. Search **chat4000** and install.
3. Launch chat4000 from Applications.
4. On the pairing screen, type the 8-character code or paste it. The macOS app supports the same `chat4000://pair?code=…` URL — if the user can right-click the URL the plugin terminal prints, "Open URL" will deep-link straight into the pairing flow.
5. Wait for the chat view to appear.

Again: if the code has been consumed, re-issue with `openclaw chat4000 pair` and retry.

---

## 4. Phase 3 — Verify the round trip

At this point the user has:

- The plugin installed and registered in OpenClaw (Phase 1)
- At least one client paired (Phase 2)

The remaining check is that messages flow both ways with full delivery acks.

### 4.1. Send a test message

From whichever client the user paired:

**CLI:**

```bash
chat4000 send "ping"
```

The CLI prints two lines on success:

```
[14:23:08.412] you: ping ✓✓
[14:23:09.881] agent: <whatever the OpenClaw agent replied>
```

The `✓✓` is the success signal. Watch for it specifically.

**iOS / macOS:** type "ping" in the chat bubble and tap send. Watch the tick state on the outbound bubble:

- `·` (single dot) — sending, transient, expected for a fraction of a second
- `✓` (one check) — the relay accepted and queued the message
- `✓✓` (two checks) — **the plugin decrypted and processed it; this is the success state**
- `✗` (cross) — failure; see §5

### 4.2. What success looks like

For the setup to be **complete and working**, every one of these must hold:

1. The user's outbound bubble reaches `✓✓`. (One tick is not enough — that only proves the relay accepted the frame, not that the OpenClaw agent on the user's machine got it.)
2. An agent reply arrives in the same client within a reasonable window — usually seconds, but depends on the agent's tool use. The reply is a separate bubble from the user's outbound, marked as coming from the plugin / agent.
3. If the user paired multiple clients, both outbound and agent reply appear on **every** paired client. They all watch the same thread.

If all three hold, declare success and stop.

### 4.3. What partial success looks like (and what it means)

| Symptom                                          | What's actually wrong                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `·` never advances                               | Client cannot reach the relay. Network issue, or the client's `chat4000` config is stale.             |
| `✓` but never `✓✓`                                | Client → relay works; relay → plugin does not. The OpenClaw gateway is not running, OR the plugin isn't registered (Phase 1.2 not done), OR the plugin crashed (check `~/.openclaw/plugins/chat4000/logs/runtime.log` and `errors.log`). |
| `✓✓` but no agent reply                          | Plugin received the message but the OpenClaw agent dispatch failed. Check `~/.openclaw/plugins/chat4000/logs/runtime.log` for `runtime.ai_request_error` lines. Usually means the agent's model provider is not configured. Out of scope for this setup. |
| Reply arrives but client shows wrong sender name | Cosmetic, ignore for setup verification.                                                              |

---

## 5. Troubleshooting cheat sheet

### `openclaw chat4000 status` says `configured: no` after `pair`

The `pair` process did not write a key — possibly because the pairing session never completed and `pair` was cancelled mid-flight. Just run `openclaw chat4000 pair` again. The key gets written before the pairing handshake even starts, so a second run will reuse it and proceed straight to "Waiting for client to join".

If something is genuinely corrupted, nuke and start over:

```bash
openclaw chat4000 reset           # wipes local state for the default account
openclaw chat4000 pair             # mint + pair again
```

`reset` is destructive — it deletes the local key and the ack/dedup store. Any peers paired against the old key will fail to decrypt anything sent from the new key. That's fine if they're going to re-pair anyway.

### Pairing socket closes after ~60 seconds with no joiner

Normal idle timeout on the relay path. Re-issue with `openclaw chat4000 pair` and have the client join faster.

### "Pairing code mismatch" on the client side

Either the user typed the wrong code, OR — much rarer — the pairing room collided with someone else's. Re-issue with `openclaw chat4000 pair`, double-check the code character-for-character (the alphabet excludes `0`, `1`, `5`, `I`, `L`, `O`, `Q`, `S` to avoid lookalikes — if the user typed an O, that's actually a 0, etc.), and retry.

### The plugin terminal logs show `runtime.ai_request_error`

That's the OpenClaw agent failing, not chat4000. The plugin successfully decrypted the inbound message and forwarded it to the agent. Investigation moves to OpenClaw's agent config (API keys, model selection, etc.). Out of scope here — point the user at OpenClaw's own troubleshooting.

### "PLUGIN_ALREADY_CONNECTED" or "DEVICE_ALREADY_CONNECTED"

The relay still has a stale slot from a previous socket. Wait ~30 seconds and retry. If it persists, restart the OpenClaw gateway (Phase 1.2).

### Need to pair an additional device against the same group

Same command, no other steps. The existing group key is reused and a fresh pairing code is issued; the new device joins the same encrypted group as the previous ones:

```bash
openclaw chat4000 pair
```

### Need to start completely over

```bash
openclaw chat4000 reset           # wipes plugin-side state
# then on each client:
#   CLI:    chat4000 disconnect
#   iOS:    Settings → Disconnect (inside the chat4000 app)
#   macOS:  Settings → Disconnect (inside the chat4000 app)
# then:
openclaw chat4000 pair             # start clean
```

---

## 6. Quick command reference (plugin side)

```bash
# Lifecycle
openclaw plugin install @chat4000/openclaw-plugin   # install
docker restart openclaw-gateway                      # OR Ctrl-C + relaunch
openclaw chat4000 pair                               # mint key (if missing) + start a pairing session
openclaw chat4000 status                             # see current state
openclaw chat4000 reset                              # wipe local state (destructive)

# Pairing variants
openclaw chat4000 pair --code DEMO-2346              # use a fixed code instead of a random one
openclaw chat4000 pair-many --code DEMO-2346 --max 5 # continuous (review/demo mode)

# Telemetry control (anonymous error reporting, on by default)
openclaw chat4000 telemetry status
openclaw chat4000 telemetry disable
openclaw chat4000 telemetry enable

# Session binding — point chat4000 at an existing OpenClaw session
openclaw chat4000 sessions list
openclaw chat4000 sessions bind --session-key "agent:main:..."
openclaw chat4000 sessions current
openclaw chat4000 sessions clear
```

## 7. Quick command reference (CLI client side)

```bash
brew install chat4000/tap/chat4000                   # install
chat4000                                              # interactive TUI
chat4000 pair                                         # join via code (paste it when prompted)
chat4000 pair --host                                  # host a new pairing from CLI side
chat4000 send "hello"                                 # one-shot send + wait for reply
echo "hello" | chat4000 send                          # same, via stdin
chat4000 history -n 20                                # show last 20 messages
chat4000 status                                       # show pairing + handshake state
chat4000 disconnect                                   # forget local pairing
chat4000 guide                                        # full CLI help
```

---

## 8. Where to look in this repo

If something behaves unexpectedly and you need to inspect the plugin's actual behavior rather than guess:

| Topic                                    | File                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| What CLI subcommands exist + their flags | `src/cli.ts`                                          |
| How pairing actually runs on the wire    | `src/pairing.ts`                                      |
| How a paired channel handles messages    | `src/channel.ts`                                      |
| The transport / wire protocol            | `src/transport/relay.ts` and `src/transport/index.ts` |
| Where keys live on disk + permissions    | `src/key-store.ts`                                    |
| Ack high-water mark + dedupe database    | `src/ack-store.ts`                                    |
| Per-plugin runtime + pairing logs        | `src/runtime-logger.ts`, `src/pairing-logger.ts`      |
| Account config resolution                | `src/accounts.ts`                                     |
| OpenClaw session binding (optional)      | `src/session-binding.ts`                              |
| Streaming text dispatch invariants       | `src/stream-dispatcher.ts`                            |
| Type definitions for everything on wire  | `src/types.ts`                                        |
| Telemetry / Sentry opt-in plumbing       | `src/telemetry.ts`                                    |
| Product / architecture / status docs     | `docs/product.md`, `docs/architecture.md`, `docs/status.md` |

## 9. Sibling repos (other parts of the system)

This repo is **only the plugin**. The full chat4000 system spans several repos:

| Repo                              | What it is                                                          |
| --------------------------------- | ------------------------------------------------------------------- |
| `clawconnect-plugin` (this one)   | The OpenClaw plugin — what you just installed.                      |
| `clawconnect-cli-rs`              | The chat4000 CLI client (`brew install chat4000/tap/chat4000`).     |
| `clawconnect-client-swift`        | The iOS + macOS app source (App Store / Mac App Store distribution).|
| `chat4000.com`                    | Public marketing + help site (`chat4000.com/help`, `/support`).     |
| `homebrew-tap`                    | The Homebrew formula for the CLI.                                   |

If you need to dig into a client-side bug rather than a plugin bug:

- CLI behavior — `clawconnect-cli-rs/crates/chat4000/src/main.rs` (the TUI / one-shot commands) and `crates/chat4000-relay/src/lib.rs` (the WebSocket session).
- iOS/macOS behavior — `clawconnect-client-swift/chat4000/Sources/Gateway/WebSocketClient.swift` and `Sources/Views/ChatView.swift`.

The user-facing documentation site is at https://chat4000.com — the `/help` and `/support` pages mirror most of this content for human consumption.

---

## 10. Final checklist for the AI agent reading this

Before declaring setup complete, confirm each of these in order:

- [ ] Confirmed whether OpenClaw is local or remote, and (if remote) that you can run shell commands on the OpenClaw host (Phase 0.1–0.2).
- [ ] `openclaw --version` works on the OpenClaw host (Phase 0.3).
- [ ] `openclaw plugin install @chat4000/openclaw-plugin` exited successfully (Phase 1.1).
- [ ] The OpenClaw gateway was restarted after install (Phase 1.2).
- [ ] `openclaw chat4000 status` shows the plugin registered, even if `configured: no` initially (Phase 1.2).
- [ ] `openclaw chat4000 pair` printed a pairing code (Phase 1.3).
- [ ] At least one client paired successfully — code "Paired" / chat view visible (Phase 2).
- [ ] A test message sent from a paired client reached `✓✓` (Phase 4.1).
- [ ] An agent reply appeared in the client (Phase 4.2).

When all eight are checked, the setup is done. Hand off back to the user.
