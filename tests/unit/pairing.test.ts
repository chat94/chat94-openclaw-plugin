import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { deriveGroupId, generateGroupKey } from "../../src/crypto.js";
import { hostPairingSession, joinPairingSession } from "../../src/pairing.js";

type RelayClient = {
  role: "initiator" | "joiner";
  socket: import("ws").WebSocket;
};

describe("pairing", () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it.skip("completes plugin-initiated pairing through the relay room flow", async () => {
    const groupKeyBytes = generateGroupKey();
    const groupId = deriveGroupId(groupKeyBytes);
    const events: string[] = [];

    let server: WebSocketServer;
    try {
      server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EPERM") {
        return;
      }
      throw error;
    }
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });

    const room = new Map<string, Partial<Record<"initiator" | "joiner", RelayClient>>>();

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const envelope = JSON.parse(raw.toString()) as {
          type: string;
          payload: Record<string, unknown>;
        };

        if (envelope.type === "pair_open") {
          const roomId = String(envelope.payload.room_id);
          const role = String(envelope.payload.role) as "initiator" | "joiner";
          const entry = room.get(roomId) ?? {};
          entry[role] = { role, socket };
          room.set(roomId, entry);
          socket.send(JSON.stringify({ version: 1, type: "pair_open_ok", payload: {} }));
          if (entry.initiator && entry.joiner) {
            entry.initiator.socket.send(JSON.stringify({ version: 1, type: "pair_ready", payload: null }));
            entry.joiner.socket.send(JSON.stringify({ version: 1, type: "pair_ready", payload: null }));
          }
          return;
        }

        const current = Array.from(room.values()).find(
          (entry) => entry.initiator?.socket === socket || entry.joiner?.socket === socket,
        );
        if (!current) {
          return;
        }

        if (envelope.type === "pair_complete") {
          current.initiator?.socket.close();
          current.joiner?.socket.close();
          return;
        }

        if (envelope.type === "pair_data" || envelope.type === "pair_cancel") {
          const target = current.initiator?.socket === socket ? current.joiner?.socket : current.initiator?.socket;
          target?.send(JSON.stringify(envelope));
        }
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      return;
    }
    const relayUrl = `ws://127.0.0.1:${address.port}`;
    const code = "ABCD-2346";

    const hostPromise = hostPairingSession({
      relayUrl,
      groupKeyBytes,
      code,
      onStatus: (status) => {
        events.push(status);
      },
    });

    const joinPromise = joinPairingSession({
      relayUrl,
      code,
    });

    const [hostResult, joinResult] = await Promise.all([hostPromise, joinPromise]);
    expect(hostResult.code).toBe(code);
    expect(joinResult.groupId).toBe(groupId);
    expect(joinResult.groupKeyBytes.equals(groupKeyBytes)).toBe(true);
    expect(events).toContain("connected");
    expect(events).toContain("waiting");
    expect(events).toContain("grant-sent");
    expect(events).toContain("completed");
  });
});
