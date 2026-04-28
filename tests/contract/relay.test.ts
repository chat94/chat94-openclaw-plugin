/**
 * Contract tests — real relay server, real WebSocket connections.
 * The relay binary is started automatically before tests and killed after.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startRelay,
  connectClient,
  msgEnvelope,
  typingEnvelope,
  type RelayInstance,
} from "./helpers.js";

let relay: RelayInstance;

beforeAll(async () => {
  relay = await startRelay();
}, 10_000);

afterAll(async () => {
  await relay?.kill();
});

// ─── #18: Plugin connects to relay ──────────────────────────────────────────

describe("connection", () => {
  it("plugin connects and gets hello_ok", async () => {
    const { ws } = await connectClient(relay.url, "plugin", "contract-18");
    expect(ws.readyState).toBe(ws.OPEN);
    ws.close();
  });

  it("app connects and gets hello_ok", async () => {
    const { ws } = await connectClient(relay.url, "app", "contract-18b");
    expect(ws.readyState).toBe(ws.OPEN);
    ws.close();
  });
});

// ─── #19: App → Plugin routing ──────────────────────────────────────────────

describe("app to plugin routing", () => {
  it("message from app arrives at plugin", async () => {
    const pairId = "contract-19";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    app.send(msgEnvelope("msg-19", "hello from phone"));

    const received = await plugin.recv(2000);
    expect(received.type).toBe("msg");
    expect(received.payload.msg_id).toBe("msg-19");
    expect(Buffer.from(received.payload.ciphertext, "base64").toString()).toBe("hello from phone");

    app.ws.close();
    plugin.ws.close();
  });
});

// ─── #20: Plugin → App routing ──────────────────────────────────────────────

describe("plugin to app routing", () => {
  it("message from plugin arrives at app", async () => {
    const pairId = "contract-20";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    plugin.send(msgEnvelope("msg-20", "agent response"));

    const received = await app.recv(2000);
    expect(received.type).toBe("msg");
    expect(received.payload.msg_id).toBe("msg-20");
    expect(Buffer.from(received.payload.ciphertext, "base64").toString()).toBe("agent response");

    app.ws.close();
    plugin.ws.close();
  });
});

// ─── #21: Offline queue delivery ────────────────────────────────────────────

describe("offline queue", () => {
  it("messages queued while app offline are delivered on reconnect", async () => {
    const pairId = "contract-21";
    const plugin = await connectClient(relay.url, "plugin", pairId);

    // Send while app is offline
    plugin.send(msgEnvelope("q1", "queued-1"));
    plugin.send(msgEnvelope("q2", "queued-2"));
    plugin.send(msgEnvelope("q3", "queued-3"));

    // Wait for relay to process
    await new Promise((r) => setTimeout(r, 200));

    // App connects — should get all queued messages
    const app = await connectClient(relay.url, "app", pairId);

    const m1 = await app.recv(2000);
    expect(Buffer.from(m1.payload.ciphertext, "base64").toString()).toBe("queued-1");

    const m2 = await app.recv(2000);
    expect(Buffer.from(m2.payload.ciphertext, "base64").toString()).toBe("queued-2");

    const m3 = await app.recv(2000);
    expect(Buffer.from(m3.payload.ciphertext, "base64").toString()).toBe("queued-3");

    app.ws.close();
    plugin.ws.close();
  });
});

// ─── #22: Typing indicator forwarded ────────────────────────────────────────

describe("typing", () => {
  it("typing indicator from plugin reaches app", async () => {
    const pairId = "contract-22";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    plugin.send(typingEnvelope(pairId));

    const received = await app.recv(2000);
    expect(received.type).toBe("typing");

    app.ws.close();
    plugin.ws.close();
  });

  it("typing from app reaches plugin", async () => {
    const pairId = "contract-22b";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    app.send(typingEnvelope(pairId));

    const received = await plugin.recv(2000);
    expect(received.type).toBe("typing");

    app.ws.close();
    plugin.ws.close();
  });
});

// ─── #23: E2E encryption through relay ──────────────────────────────────────

describe("encryption e2e", () => {
  it("relay forwards encrypted blob without modification", async () => {
    const pairId = "contract-23";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    // App sends with specific nonce + ciphertext
    const nonce = Buffer.from("exactly-24-bytes-nonce!!").toString("base64");
    const ciphertext = Buffer.from("encrypted-payload-here").toString("base64");

    app.send({
      version: 1,
      type: "msg",
      payload: { msg_id: "enc-1", nonce, ciphertext },
    });

    const received = await plugin.recv(2000);
    // Relay must forward nonce and ciphertext exactly as-is
    expect(received.payload.nonce).toBe(nonce);
    expect(received.payload.ciphertext).toBe(ciphertext);

    app.ws.close();
    plugin.ws.close();
  });
});

// ─── #24: Multiple pairs don't cross-talk ───────────────────────────────────

describe("isolation", () => {
  it("messages from pair-A never reach pair-B", async () => {
    const appA = await connectClient(relay.url, "app", "iso-A");
    const pluginA = await connectClient(relay.url, "plugin", "iso-A");
    const appB = await connectClient(relay.url, "app", "iso-B");
    const pluginB = await connectClient(relay.url, "plugin", "iso-B");

    pluginA.send(msgEnvelope("iso-1", "for-A-only"));

    // App A should get it
    const msgA = await appA.recv(1000);
    expect(msgA.type).toBe("msg");

    // App B should NOT get it
    await expect(appB.recv(500)).rejects.toThrow("timeout");

    appA.ws.close();
    pluginA.ws.close();
    appB.ws.close();
    pluginB.ws.close();
  });
});

// ─── #26: Rapid messages maintain order ─────────────────────────────────────

describe("ordering", () => {
  it("50 rapid messages arrive in order", async () => {
    const pairId = "contract-26";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    for (let i = 0; i < 50; i++) {
      plugin.send(msgEnvelope(`ord-${String(i).padStart(3, "0")}`, `msg-${i}`));
    }

    const received: string[] = [];
    for (let i = 0; i < 50; i++) {
      const msg = await app.recv(3000);
      if (msg.type === "msg") {
        received.push(msg.payload.msg_id);
      }
    }

    expect(received.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(received[i]).toBe(`ord-${String(i).padStart(3, "0")}`);
    }

    app.ws.close();
    plugin.ws.close();
  });
});

// ─── #27: Health endpoint shows connections ─────────────────────────────────

describe("health", () => {
  it("health endpoint reflects connected clients", async () => {
    const pairId = "contract-27";
    const app = await connectClient(relay.url, "app", pairId);
    const plugin = await connectClient(relay.url, "plugin", pairId);

    await new Promise((r) => setTimeout(r, 200));

    const resp = await fetch(`http://${relay.url}/health`);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.connections.apps).toBeGreaterThanOrEqual(1);
    expect(body.connections.plugins).toBeGreaterThanOrEqual(1);

    app.ws.close();
    plugin.ws.close();
  });
});
