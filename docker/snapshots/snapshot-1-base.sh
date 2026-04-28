#!/bin/bash
# Snapshot 1: Build bare OpenClaw image (no config, no auth)
set -e

echo "=== Snapshot 1: Building OpenClaw base ==="

cd "$(dirname "$0")/.."

docker compose build openclaw

# Run it briefly to verify the install works
docker compose up -d openclaw
sleep 2

# It won't be healthy (no config yet) — that's fine
echo "OpenClaw installed. Taking snapshot..."
docker commit chat94-openclaw chat94/openclaw:snapshot-1-base

docker compose down

echo "=== Snapshot 1 saved: chat94/openclaw:snapshot-1-base ==="
echo "Next: run snapshot-2-auth.sh to set up and authenticate"
