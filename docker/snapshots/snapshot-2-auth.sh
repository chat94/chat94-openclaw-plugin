#!/bin/bash
# Snapshot 2: Run openclaw setup interactively — configures and authenticates
# You'll be prompted to answer questions and open a URL to log in.
set -e

echo "=== Snapshot 2: OpenClaw Setup & Authentication ==="

# Start from snapshot 1
docker rm -f chat94-openclaw 2>/dev/null || true
docker run -it --name chat94-openclaw \
  -p 18789:18789 \
  chat94/openclaw:snapshot-1-base \
  openclaw setup

echo ""
echo "Setup complete. Taking snapshot..."
docker commit chat94-openclaw chat94/openclaw:snapshot-2-authed

echo "=== Snapshot 2 saved: chat94/openclaw:snapshot-2-authed ==="
echo "Next: run snapshot-3-plugin.sh to install the Chat94 plugin"
