import { describe, expect, it, vi } from "vitest";
import { RegistrarClient, RegistrarError, generatePairingCode } from "../../src/pairing/registrar.js";

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("RegistrarClient", () => {
  it("registerPairing posts code+plugin_id with bearer auth (PROTOCOL §3.1)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com/",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { status: 200, body: { ok: true, expires_at: 1700000000000 } };
      }),
    });

    const res = await client.registerPairing({ code: "ABC-123", pluginId: "plugin-uuid", ttlSeconds: 300 });

    expect(res).toEqual({ ok: true, expiresAt: 1700000000000 });
    expect(captured?.url).toBe("https://registrar.chat4000.com/pair/register");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe("Bearer svc-token");
    expect(JSON.parse(String(captured?.init.body))).toMatchObject({
      code: "ABC-123",
      plugin_id: "plugin-uuid",
      ttl_seconds: 300,
    });
  });

  it("redeemPairing is public (no auth) and maps the response (PROTOCOL §3.2)", async () => {
    let authHeader: string | undefined = "set";
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((_url, init) => {
        authHeader = (init.headers as Record<string, string>).Authorization;
        return {
          status: 200,
          body: {
            gateway_url: "wss://gateway.chat4000.com/ws",
            user_id: "@u_x:chat4000.com",
            device_id: "DEV1",
            access_token: "tok",
          },
        };
      }),
    });

    const res = await client.redeemPairing({ code: "ABC-123" });

    expect(res).toEqual({
      gatewayUrl: "wss://gateway.chat4000.com/ws",
      userId: "@u_x:chat4000.com",
      deviceId: "DEV1",
      accessToken: "tok",
    });
    expect(authHeader).toBeUndefined();
  });

  it("getPairingStatus reports completion + user (PROTOCOL §3.3)", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((url) => {
        expect(url).toContain("/pair/status?code=ABC-123");
        return { status: 200, body: { status: "completed", user_id: "@u_x:chat4000.com" } };
      }),
    });

    const res = await client.getPairingStatus("ABC-123");
    expect(res).toEqual({ status: "completed", userId: "@u_x:chat4000.com" });
  });

  it("surfaces {errcode,error} as RegistrarError with status flags", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl: mockFetch(() => ({ status: 409, body: { errcode: "M_IN_USE", error: "code already in use" } })),
    });

    const err = await client.registerPairing({ code: "x", pluginId: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrarError);
    expect((err as RegistrarError).status).toBe(409);
    expect((err as RegistrarError).isConflict).toBe(true);
    expect((err as RegistrarError).errcode).toBe("M_IN_USE");
  });

  it("generatePairingCode returns a code within the §3.1 6–128 char bound", () => {
    const code = generatePairingCode();
    expect(code.length).toBeGreaterThanOrEqual(6);
    expect(code.length).toBeLessThanOrEqual(128);
  });
});
