import WebSocket from "ws";

const DEFAULT_KEEPALIVE_MS = 25_000;

export function attachWebSocketKeepalive(
  ws: WebSocket,
  intervalMs = DEFAULT_KEEPALIVE_MS,
): () => void {
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      ws.ping();
    } catch {
      // Ignore failed keepalive pings; close/error handlers own recovery.
    }
  }, intervalMs);

  const clear = () => clearInterval(timer);
  ws.once("close", clear);
  ws.once("error", clear);
  return clear;
}
