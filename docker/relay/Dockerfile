FROM rust:1.91-slim

WORKDIR /app

# Native build deps required by openssl-sys during cargo build
RUN apt-get update && apt-get install -y --no-install-recommends \
  pkg-config \
  libssl-dev \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Copy entire relay repo
COPY . .

# Build
RUN cargo build --release

# Move binary to PATH
RUN cp target/release/clawconnect-relay /usr/local/bin/

# Create data directory
RUN mkdir -p /var/lib/relay

ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=7890
ENV RELAY_DATA_DIR=/var/lib/relay
ENV RELAY_LOG_LEVEL=info

EXPOSE 7890

HEALTHCHECK --interval=5s --timeout=3s \
  CMD curl -sf http://localhost:7890/health || exit 1

CMD ["clawconnect-relay"]
