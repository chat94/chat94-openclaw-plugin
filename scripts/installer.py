#!/usr/bin/env python3
"""installer.py — installs the chat4000 OpenClaw plugin from npm,
restarts the OpenClaw gateway, and starts a pairing session.

Pure stdlib. Designed to be downloaded by install.sh and executed as a
one-shot. ANSI colors, no third-party deps (PostHog events use stdlib
HTTPS, not the SDK).

PostHog events fired:
  - installer_started
  - installer_openclaw_detected          {openclaw_version}
  - installer_pkg_installed              {plugin_version}
  - installer_gateway_restarted          {method}
  - installer_failed                     {stage, error_class, error_msg}
  - installer_handing_off_to_pair

Same install_id as the OpenClaw plugin's Sentry/PostHog so the
installer funnel correlates with later runtime events.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

# ─── Constants ────────────────────────────────────────────────────────────

REPO_URL = "https://github.com/chat4000/chat4000-openclaw-plugin"
NPM_PACKAGE = "@chat4000/openclaw-plugin"

# Public PostHog credentials — same project the iOS / Mac apps and the
# Hermes plugin use. Hardcoded so the installer can fire pre-install
# events before the plugin (which embeds the same key) exists locally.
POSTHOG_API_KEY = "phc_s49DnTamyFDnEC6MyumNmmjjf7p455LXCVzPE94hPemZ"
POSTHOG_HOST = "https://us.i.posthog.com"
POSTHOG_CAPTURE_URL = f"{POSTHOG_HOST}/capture/"

# ─── ANSI ─────────────────────────────────────────────────────────────────

if sys.stdout.isatty():
    C_RED = "\033[1;31m"
    C_GRN = "\033[1;32m"
    C_YEL = "\033[1;33m"
    C_BLU = "\033[1;34m"
    C_MAG = "\033[1;35m"
    C_CYN = "\033[1;36m"
    C_DIM = "\033[2m"
    C_BOLD = "\033[1m"
    C_RST = "\033[0m"
else:
    C_RED = C_GRN = C_YEL = C_BLU = C_MAG = C_CYN = C_DIM = C_BOLD = C_RST = ""

def say(msg: str) -> None: print(f"{C_CYN}>{C_RST} {msg}")
def ok(msg: str) -> None: print(f"{C_GRN}✓{C_RST} {msg}")
def warn(msg: str) -> None: print(f"{C_YEL}⚠{C_RST} {msg}")
def err(msg: str) -> None: print(f"{C_RED}✗{C_RST} {msg}", file=sys.stderr)
def hdr(msg: str) -> None:
    line = "━" * 63
    print(f"\n{C_MAG}{line}{C_RST}\n{C_MAG}{C_BOLD}{msg}{C_RST}\n{C_MAG}{line}{C_RST}\n")

def banner() -> None:
    print(f"\n{C_MAG}┌─────────────────────────────────────────────────────────────┐{C_RST}")
    print(f"{C_MAG}│{C_RST}  {C_MAG}{C_BOLD}🔐 chat4000{C_RST}  ·  {C_BLU}{C_BOLD}OpenClaw plugin installer{C_RST}                     {C_MAG}│{C_RST}")
    print(f"{C_MAG}│{C_RST}  {C_DIM}Native iPhone / Mac / CLI app for your OpenClaw agent{C_RST}       {C_MAG}│{C_RST}")
    print(f"{C_MAG}└─────────────────────────────────────────────────────────────┘{C_RST}\n")

# ─── install_id (matches what the plugin will reuse later) ────────────────

def resolve_install_id() -> str:
    cfg = Path.home() / ".config" / "chat4000"
    path = cfg / "install-id"
    try:
        if path.exists():
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        new_id = str(uuid.uuid4())
        cfg.mkdir(parents=True, exist_ok=True)
        path.write_text(new_id + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return new_id
    except Exception:
        return str(uuid.uuid4())

# ─── PostHog (stdlib HTTPS, no SDK) ───────────────────────────────────────

_SESSION_ID = str(uuid.uuid4())
_TELEMETRY_DISABLED = (
    os.environ.get("CHAT4000_TELEMETRY_DISABLED", "").strip().lower() in ("1", "true", "yes")
    or "--no-telemetry" in sys.argv
)

def track(event: str, props: Optional[dict] = None) -> None:
    if _TELEMETRY_DISABLED:
        return
    enriched = {
        "source": "openclaw-plugin-installer",
        "installer_version": "1.0.0",
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "os_platform": sys.platform,
        "session_id": _SESSION_ID,
    }
    if props:
        enriched.update(props)
    body = json.dumps({
        "api_key": POSTHOG_API_KEY,
        "event": event,
        "distinct_id": resolve_install_id(),
        "properties": enriched,
    }).encode("utf-8")
    req = urllib.request.Request(
        POSTHOG_CAPTURE_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass

# ─── Detection ────────────────────────────────────────────────────────────

def detect_openclaw() -> Optional[tuple[str, str]]:
    """Return (openclaw_path, version) or None."""
    path = shutil.which("openclaw")
    if not path:
        return None
    try:
        out = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=10,
        )
        version_line = (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else "unknown"
        # Strip "OpenClaw " prefix if present
        m = re.search(r"\b(\d+\.\d+\.\d+\S*)", version_line)
        version = m.group(1) if m else version_line
    except Exception:
        version = "unknown"
    return (path, version)

def detect_restart_method() -> Optional[str]:
    """Return one of:
      - 'openclaw-restart' (openclaw gateway restart exists and managed by launchd/systemd)
      - 'docker'           (openclaw-gateway container running)
      - None               (no automatic restart — user must do it manually)
    """
    # Check docker first — if a container named openclaw-gateway is running,
    # `docker restart` is the unambiguous path.
    docker = shutil.which("docker")
    if docker:
        try:
            r = subprocess.run(
                [docker, "ps", "--filter", "name=openclaw-gateway", "--format", "{{.Names}}"],
                capture_output=True, text=True, timeout=5,
            )
            if "openclaw-gateway" in (r.stdout or ""):
                return "docker"
        except Exception:
            pass
    # Otherwise, try `openclaw gateway restart` — it's idempotent for
    # launchd / systemd / schtasks installs. For bare `openclaw gateway
    # run` installs it'll print a "process not managed" message; we
    # treat that as fall-through and tell the user.
    return "openclaw-restart"

# ─── Install steps ────────────────────────────────────────────────────────

def install_plugin(openclaw: str, force: bool) -> None:
    """Try `openclaw plugins install` (plural, current) first; fall back
    to `openclaw plugin install` (singular, older). Both forms exist
    depending on the OpenClaw version."""
    base_cmds = [
        [openclaw, "plugins", "install", NPM_PACKAGE],   # canonical (2026.4+)
        [openclaw, "plugin", "install", NPM_PACKAGE],    # legacy
    ]
    last_exc: Optional[subprocess.CalledProcessError] = None
    for cmd in base_cmds:
        if force:
            cmd = cmd[:3] + ["--force"] + cmd[3:]
        say(f"$ {' '.join(cmd)}")
        try:
            subprocess.run(cmd, check=True)
            return
        except subprocess.CalledProcessError as exc:
            last_exc = exc
            # If openclaw said "unknown command", try the other shape.
            # Anything else is a real install failure — bail immediately.
            continue
    if last_exc is not None:
        raise last_exc

def restart_gateway(method: str) -> bool:
    """Returns True if a restart was actually issued."""
    if method == "docker":
        docker = shutil.which("docker")
        if not docker:
            return False
        say("$ docker restart openclaw-gateway")
        r = subprocess.run([docker, "restart", "openclaw-gateway"], capture_output=True, text=True)
        if r.returncode != 0:
            warn(f"docker restart failed: {r.stderr.strip()[:200]}")
            return False
        return True
    if method == "openclaw-restart":
        openclaw = shutil.which("openclaw") or "openclaw"
        say(f"$ {openclaw} gateway restart")
        r = subprocess.run(
            [openclaw, "gateway", "restart"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            return True
        # Print whatever openclaw said so the user has context.
        out = (r.stderr or r.stdout).strip()
        if out:
            warn(out[:500])
        return False
    return False

def verify_plugin_registered(openclaw: str) -> bool:
    """Try `openclaw chat4000 status` — if the subcommand exists, the
    plugin is loaded."""
    try:
        r = subprocess.run(
            [openclaw, "chat4000", "status"],
            capture_output=True, text=True, timeout=10,
        )
        # Even when 'configured: no', exit code is 0 if the subcommand
        # is registered. Non-zero typically means 'unknown command'.
        return r.returncode == 0
    except Exception:
        return False

def reset_local_state() -> None:
    state_dir = Path.home() / ".openclaw" / "plugins" / "chat4000"
    if state_dir.exists():
        warn(f"Removing {state_dir} (key + ack store) — already-paired devices will fail to decrypt until re-paired.")
        ans = input(f"{C_YEL}Continue? [y/N]:{C_RST} ").strip().lower()
        if ans not in ("y", "yes"):
            say("Reset cancelled.")
            return
        shutil.rmtree(state_dir, ignore_errors=True)
        ok(f"Removed {state_dir}")

# ─── Main ─────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="chat4000 OpenClaw plugin installer",
        add_help=True,
    )
    parser.add_argument("--no-pair", action="store_true",
                        help="install + restart only, don't start pairing")
    parser.add_argument("--no-restart", action="store_true",
                        help="install only, don't touch the gateway")
    parser.add_argument("--reset", action="store_true",
                        help="wipe local key + ack store (destructive)")
    parser.add_argument("--force", action="store_true",
                        help="pass --force to `openclaw plugin install` (re-install in place)")
    parser.add_argument("--no-telemetry", action="store_true",
                        help="disable PostHog + Sentry for this run")
    args = parser.parse_args()

    banner()
    track("installer_started")

    # 1. Detect openclaw ----------------------------------------------------
    detected = detect_openclaw()
    if detected is None:
        err("OpenClaw not found on PATH. Install OpenClaw first, then re-run.")
        err("  Docs: https://openclaw.com/install")
        track("installer_failed", {"stage": "detect_openclaw", "error_class": "NotFound"})
        return 1
    openclaw_path, openclaw_version = detected
    ok(f"OpenClaw:  {C_CYN}{openclaw_path}{C_RST}  {C_DIM}({openclaw_version}){C_RST}")
    track("installer_openclaw_detected", {"openclaw_version": openclaw_version, "openclaw_path": openclaw_path})

    # 2. Reset mode ---------------------------------------------------------
    if args.reset:
        hdr("Reset mode (destructive)")
        reset_local_state()

    # 3. Install ------------------------------------------------------------
    hdr(f"📦 Installing {NPM_PACKAGE} into OpenClaw")
    try:
        install_plugin(openclaw_path, force=args.force)
    except subprocess.CalledProcessError as exc:
        err(f"`openclaw plugin install` exited {exc.returncode}.")
        err("Common causes:")
        err("  - npm registry unreachable from this host (proxy / offline)")
        err(f"  - The OpenClaw on this host doesn't support `plugin install` — try `{openclaw_path} --help`")
        err("  - Permissions on the OpenClaw plugins directory")
        track("installer_failed", {
            "stage": "plugin_install",
            "error_class": type(exc).__name__,
            "error_msg": str(exc)[:200],
        })
        return 1
    ok("Plugin installed.")
    track("installer_pkg_installed", {"plugin_package": NPM_PACKAGE})

    # 4. Restart gateway ----------------------------------------------------
    if args.no_restart:
        warn("Skipping gateway restart (--no-restart).")
        warn("The plugin is installed but NOT loaded until the gateway restarts.")
    else:
        hdr("🔁 Restarting OpenClaw gateway")
        method = detect_restart_method()
        restarted = False
        if method is not None:
            restarted = restart_gateway(method)
        if restarted:
            ok(f"Gateway restarted via {method}.")
            track("installer_gateway_restarted", {"method": method})
            # Give the gateway a moment to re-register plugins.
            import time
            time.sleep(2)
        else:
            warn("Could not auto-restart the gateway.")
            warn("If you run OpenClaw under Docker: docker restart openclaw-gateway")
            warn("If you run `openclaw gateway run` in a terminal: Ctrl-C it and start again.")
            warn("If you run under launchd / systemd: try `openclaw gateway restart`.")
            track("installer_gateway_restart_skipped", {"reason": "no_method"})

    # 5. Verify the plugin is registered ------------------------------------
    if verify_plugin_registered(openclaw_path):
        ok("Plugin registered (`openclaw chat4000 status` works).")
    else:
        warn("`openclaw chat4000 status` failed — the gateway may still be starting up.")
        warn("If this persists, restart the gateway manually and re-run pair.")

    # 6. Pair --------------------------------------------------------------
    if args.no_pair:
        warn("Skipping pair (--no-pair). When ready, run:")
        print(f"  {C_CYN}{openclaw_path} chat4000 pair{C_RST}")
        return 0

    hdr("📱 Pairing a device")
    print(f"{C_DIM}Scan the QR with the chat4000 iOS/macOS app, or paste the code into the CLI client.{C_RST}")
    print(f"{C_DIM}Press Ctrl-C any time to cancel.{C_RST}\n")
    track("installer_handing_off_to_pair")
    # exec so pair owns the real tty — user can Ctrl-C cleanly.
    os.execv(openclaw_path, [openclaw_path, "chat4000", "pair"])

if __name__ == "__main__":
    sys.exit(main())
