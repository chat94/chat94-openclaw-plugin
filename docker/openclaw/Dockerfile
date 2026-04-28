FROM node:22-slim

# Install OpenClaw latest stable
RUN npm install -g openclaw@2026.4.8

# Install curl for health check
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Create config directory
RUN mkdir -p /root/.openclaw

WORKDIR /root

EXPOSE 18789

# No CMD — we'll run setup interactively first, then gateway
