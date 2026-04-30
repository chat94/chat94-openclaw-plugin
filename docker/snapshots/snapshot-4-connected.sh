#!/bin/bash
# Snapshot 4: Full stack — OpenClaw (with plugin) + Relay, connected
set -e

echo "=== Snapshot 4: Full Stack Connected ==="

cd "$(dirname "$0")/.."

# Stop any existing containers
docker compose down 2>/dev/null || true
docker rm -f chat4000-openclaw chat4000-relay 2>/dev/null || true

# Create network if not exists
docker network create clawnet 2>/dev/null || true

# Start relay
echo "Building and starting relay..."
docker compose build relay
docker compose up -d relay

# Wait for relay health
echo "Waiting for relay..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:7890/health > /dev/null 2>&1; then
    echo "Relay is healthy!"
    break
  fi
  sleep 1
done

# Start OpenClaw from snapshot-3 (with plugin)
echo "Starting OpenClaw with plugin..."
docker run -d --name chat4000-openclaw \
  --network clawnet \
  -p 18789:18789 \
  chat4000/openclaw:snapshot-3-plugin \
  openclaw gateway --port 18789

# Wait for OpenClaw health
echo "Waiting for OpenClaw..."
for i in $(seq 1 30); do
  if docker exec chat4000-openclaw curl -sf http://localhost:18789/health > /dev/null 2>&1; then
    echo "OpenClaw is healthy!"
    break
  fi
  sleep 1
done

# Verify relay shows plugin connection
sleep 2
echo ""
echo "=== Stack Status ==="
echo "Relay health:"
curl -s http://localhost:7890/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:7890/health
echo ""
echo "OpenClaw health:"
docker exec chat4000-openclaw curl -s http://localhost:18789/health | python3 -m json.tool 2>/dev/null || true
echo ""

# Snapshot relay
docker commit chat4000-relay chat4000/relay:snapshot-4-connected
echo "Relay snapshot saved: chat4000/relay:snapshot-4-connected"

# Snapshot openclaw (with live plugin connection state)
docker commit chat4000-openclaw chat4000/openclaw:snapshot-4-connected
echo "OpenClaw snapshot saved: chat4000/openclaw:snapshot-4-connected"

echo ""
echo "=== Snapshot 4 complete ==="
echo "To restore this state anytime:"
echo "  docker network create clawnet 2>/dev/null"
echo "  docker run -d --name chat4000-relay --network clawnet -p 7890:7890 chat4000/relay:snapshot-4-connected chat4000-relay"
echo "  docker run -d --name chat4000-openclaw --network clawnet -p 18789:18789 chat4000/openclaw:snapshot-4-connected openclaw gateway --port 18789"
