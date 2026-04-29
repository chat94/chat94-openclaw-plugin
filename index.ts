import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerChat4000Cli } from "./src/cli.js";
import { initializeChat4000Telemetry } from "./src/telemetry.js";

initializeChat4000Telemetry();

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
  resolveChat4000KeyFilePath,
  resolveOpenClawHome,
  saveStoredGroupKey,
} from "./src/key-store.js";

export default defineBundledChannelEntry({
  id: "chat4000",
  name: "chat4000",
  description: "chat4000 channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "chat4000Plugin",
  },
  registerCliMetadata: registerChat4000Cli,
});
