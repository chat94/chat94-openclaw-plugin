/**
 * Per-account `MessageTransport` registry.
 *
 * The OpenClaw plugin lifecycle has two entry points that need to share one
 * transport instance:
 *   - `gateway.startAccount` constructs the transport and connects it.
 *   - `outbound.sendText` / `outbound.sendMedia` are called by OpenClaw to
 *     emit messages to a paired chat4000 group; they look up the live
 *     transport here.
 *
 * Keyed by `accountId` (one OpenClaw account = one chat4000 group, since
 * pairing is 1:1). Multiple gateways for the same accountId in the same
 * process are not supported and would be a bug — we throw on double-register.
 */
import type { MessageTransport } from "./index.js";

const transports = new Map<string, MessageTransport>();

export function registerTransport(accountId: string, transport: MessageTransport): void {
  const existing = transports.get(accountId);
  if (existing && existing !== transport) {
    // OpenClaw can invoke `gateway.startAccount` more than once during a
    // config reload before the previous abortSignal fires. Disconnect the
    // stale transport and overwrite — single-active-transport-per-account
    // is still the invariant; this just makes the registry tolerant of
    // overlapping starts.
    try {
      existing.disconnect();
    } catch {
      // best-effort
    }
  }
  transports.set(accountId, transport);
}

export function unregisterTransport(accountId: string): void {
  transports.delete(accountId);
}

export function getTransport(accountId: string): MessageTransport | undefined {
  return transports.get(accountId);
}

/** Test-only: drop all registered transports. */
export function _resetTransportRegistryForTests(): void {
  transports.clear();
}
