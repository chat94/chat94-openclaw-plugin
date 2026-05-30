/**
 * Human-device pairing (PROTOCOL §3).
 *
 * The plugin picks a pairing `code`, registers it with the registrar
 * (`/pair/register`, bearer SERVICE_TOKEN), and prints it (text + QR). The
 * chat4000 app redeems the code at the registrar (`/pair/redeem`) and is logged
 * in. The plugin polls `/pair/status` until `completed`, then (§3.3) invites the
 * returned `user_id` to a room so messages can flow.
 *
 * The QR encodes what the app needs to redeem: the registrar URL + code.
 */
import { RegistrarClient, generatePairingCode } from "./registrar.js";

export type StartHumanPairingResult = {
  code: string;
  expiresAt: number;
  /** URI the app reads to know where + what to redeem. */
  qrUri: string;
};

/** Register a fresh pairing code keyed to this plugin. */
export async function startHumanPairing(params: {
  registrar: RegistrarClient;
  registrarUrl: string;
  pluginId: string;
  ttlSeconds?: number;
  userId?: string;
}): Promise<StartHumanPairingResult> {
  const code = generatePairingCode();
  const result = await params.registrar.registerPairing({
    code,
    pluginId: params.pluginId,
    userId: params.userId,
    ttlSeconds: params.ttlSeconds,
  });
  return {
    code,
    expiresAt: result.expiresAt,
    qrUri: buildQrUri({ registrarUrl: params.registrarUrl, code }),
  };
}

export function buildQrUri(payload: { registrarUrl: string; code: string }): string {
  const params = new URLSearchParams({
    v: "2",
    registrar: payload.registrarUrl,
    code: payload.code,
  });
  return `chat4000://pair?${params.toString()}`;
}

/** Render an ASCII QR for the URI, if qrcode-terminal is available. */
export async function renderQr(uri: string, write: (line: string) => void): Promise<void> {
  write(`QR payload: ${uri}`);
  try {
    const moduleName = "qrcode-terminal";
    const qr = (await import(moduleName)) as {
      default?: { generate?: (v: string, o?: { small?: boolean }) => void };
      generate?: (v: string, o?: { small?: boolean }) => void;
    };
    const generate = qr.generate ?? qr.default?.generate;
    if (typeof generate === "function") {
      generate(uri, { small: true });
    }
  } catch {
    write("(Install optional dependency `qrcode-terminal` to render an ASCII QR here.)");
  }
}
