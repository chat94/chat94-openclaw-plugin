#!/bin/bash
# Snapshot 3: Install Chat4000 plugin into OpenClaw
set -e

echo "=== Snapshot 3: Install Chat4000 Plugin ==="

cd "$(dirname "$0")/.."

# Make sure OpenClaw is running from authed snapshot
if ! docker ps | grep -q chat4000-openclaw; then
  echo "Starting OpenClaw from snapshot-2..."
  docker run -d --name chat4000-openclaw \
    --network clawnet \
    -p 18789:18789 \
    chat4000/openclaw:snapshot-2-authed \
    openclaw gateway --port 18789
  sleep 3
fi

# Copy plugin source into container
echo "Copying plugin into container..."
docker cp ../../ chat4000-openclaw:/tmp/chat4000-plugin

# Install the plugin
echo "Installing plugin..."
docker exec chat4000-openclaw openclaw plugins install /tmp/chat4000-plugin

# Configure plugin to point at relay container
echo "Configuring plugin..."
docker exec chat4000-openclaw sh -c 'cat > /root/.openclaw/openclaw.json << EOF
{
  "gateway": {
    "token": "test-token-chat4000-e2e",
    "dangerouslyDisableDeviceAuth": true
  },
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o-mini"
    }
  },
  "channels": {
    "chat4000": {
      "relayUrl": "ws://chat4000-relay:7890",
      "pairId": "e2e-test-pair",
      "encryption": "nacl-box"
    }
  }
}
EOF'

# Restart to pick up plugin
echo "Restarting gateway with plugin..."
docker exec chat4000-openclaw openclaw gateway restart 2>/dev/null || true

# Snapshot
docker commit chat4000-openclaw chat4000/openclaw:snapshot-3-plugin
echo "=== Snapshot 3 saved: chat4000/openclaw:snapshot-3-plugin ==="
