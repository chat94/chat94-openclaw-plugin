// Per-account registry of live Matrix client handles.
//
// Replaces the v1 transport registry. The gateway registers a handle on
// startAccount; the outbound adapter looks it up to send.
import type { MatrixClientHandle } from "./matrix/client.js";

const handles = new Map<string, MatrixClientHandle>();

export function registerHandle(accountId: string, handle: MatrixClientHandle): void {
  handles.set(accountId, handle);
}

export function getHandle(accountId: string): MatrixClientHandle | undefined {
  return handles.get(accountId);
}

export function unregisterHandle(accountId: string): void {
  handles.delete(accountId);
}
