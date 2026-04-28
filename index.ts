import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerChat94Cli } from "./src/cli.js";
import { initializeChat94Telemetry } from "./src/telemetry.js";

initializeChat94Telemetry();

export {
  generateGroupKey,
  deriveGroupId,
  formatGroupQrUrl,
  generatePairingCode,
  normalizePairingCode,
  derivePairingRoomId,
  generatePairingJoinerKeypair,
  computePairingProof,
  wrapGroupKeyToJoiner,
  unwrapGroupKeyFromInitiator,
  generatePairKey,
  derivePairId,
  formatPairQrUrl,
} from "./src/crypto.js";
export { joinPairingSession, hostPairingSession } from "./src/pairing.js";
export {
  loadStoredGroupKey,
  resolveChat94KeyFilePath,
  resolveOpenClawHome,
  saveStoredGroupKey,
} from "./src/key-store.js";

export default defineBundledChannelEntry({
  id: "chat94",
  name: "chat94",
  description: "chat94 channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "chat94Plugin",
  },
  registerCliMetadata: registerChat94Cli,
});
