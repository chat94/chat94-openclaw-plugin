/**
 * Plugin Matrix identity bootstrap (PROTOCOL §3).
 *
 * Two supported paths:
 *
 *   A. Direct (configureIdentity): the operator supplies an existing bot login
 *      — homeserver + userId (`@plugin_…`) + accessToken + deviceId. We persist
 *      it. A plugin_id is taken from the creds or generated/persisted locally.
 *
 *   B. Self-onboard (selfRedeemIdentity): per §3, "a plugin onboarding itself
 *      just registers a kind=plugin code and redeems it." The registrar mints a
 *      `@plugin_…` account, a device, and issues a plugin_id. Redeem returns
 *      {gateway_url, user_id, device_id, access_token, plugin_id} — but NOT the
 *      homeserver URL, so the caller pairs it with the env's homeserver.
 */
import { saveMatrixCredentials } from "../matrix/credentials.js";
import type { MatrixCredentials } from "../matrix/types.js";
import { getOrCreatePluginId } from "./instance.js";
import { RegistrarClient, generatePairingCode } from "./registrar.js";

export type ProvisionBotResult = {
  credentials: MatrixCredentials;
  credentialsPath: string;
};

/** Path A — persist operator-supplied Matrix bot credentials. */
export function configureIdentity(params: {
  accountId: string;
  credentials: MatrixCredentials;
}): ProvisionBotResult {
  const pluginId = params.credentials.pluginId ?? getOrCreatePluginId(params.accountId);
  const credentials: MatrixCredentials = { ...params.credentials, pluginId };
  const credentialsPath = saveMatrixCredentials(params.accountId, credentials);
  return { credentials, credentialsPath };
}

/** Path B — self-onboard via a `kind=plugin` registrar code (§3). */
export async function selfRedeemIdentity(params: {
  accountId: string;
  registrar: RegistrarClient;
  homeserver: string;
}): Promise<ProvisionBotResult> {
  const code = generatePairingCode();
  await params.registrar.registerPairing({ code, kind: "plugin" });
  const redeemed = await params.registrar.redeemPairing({
    code,
    deviceName: "chat4000 OpenClaw plugin",
  });
  const credentials: MatrixCredentials = {
    homeserver: params.homeserver,
    userId: redeemed.userId,
    accessToken: redeemed.accessToken,
    deviceId: redeemed.deviceId,
    // Prefer the registrar-issued plugin_id; fall back to a stable local one.
    pluginId: redeemed.pluginId ?? getOrCreatePluginId(params.accountId),
  };
  const credentialsPath = saveMatrixCredentials(params.accountId, credentials);
  return { credentials, credentialsPath };
}
