// Lazy barrel — only imported when gateway starts.
// Prevents bundled entry from loading heavy runtime code.
export { monitorChat4000Provider } from "./monitor.js";
export { hostPairingSession, joinPairingSession } from "./pairing.js";
export {
  sendMessageChat4000,
  sendStreamDelta,
  sendStreamEnd,
  sendStatus,
  registerSender,
  unregisterSender,
} from "./send.js";
export { recoverQueuedChat4000Deliveries } from "./deferred-delivery.js";
