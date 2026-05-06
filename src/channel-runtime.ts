// Lazy barrel — only imported when gateway starts.
// Prevents bundled entry from loading heavy runtime code (relay transport,
// pairing crypto, ack store) until OpenClaw activates the channel.
export { RelayMessageTransport } from "./transport/relay.js";
export { hostPairingSession, joinPairingSession } from "./pairing.js";
export {
  registerTransport,
  unregisterTransport,
  getTransport,
} from "./transport/registry.js";
