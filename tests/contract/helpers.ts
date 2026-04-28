import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const RELAY_BINARY = process.env.RELAY_BINARY
  ?? "/tmp/chat94-relay";

const BASE_PORT = 17890;
let portCounter = 0;

export type RelayInstance = {
  port: number;
  url: string;
  process: ChildProcess;
  kill: () => Promise<void>;
};

export async function startRelay(): Promise<RelayInstance> {
  const port = BASE_PORT + portCounter++;
  const dataDir = `/tmp/chat94-test-${randomUUID()}`;

  const proc = spawn(RELAY_BINARY, [], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_DATA_DIR: dataDir,
      RELAY_LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = `127.0.0.1:${port}`;
  await waitForReady(`http://${url}/health`, 5000);

  return {
    port,
    url,
    process: proc,
    kill: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        setTimeout(resolve, 2000);
      });
    },
  };
}

async function waitForReady(healthUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(healthUrl);
      if (resp.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Relay did not start within ${timeoutMs}ms`);
}

export type TestClient = {
  ws: WebSocket;
  send: (env: object) => void;
  recv: (timeoutMs?: number) => Promise<any>;
};

export async function connectClient(
  relayUrl: string,
  role: "app" | "plugin",
  groupId: string,
): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${relayUrl}/ws`);
    const pending: any[] = [];
    let waiter: { resolve: (v: any) => void; reject: (e: Error) => void } | null = null;
    let helloReceived = false;

    function dispatch(parsed: any) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(parsed);
      } else {
        pending.push(parsed);
      }
    }

    ws.on("message", (data: Buffer) => {
      const parsed = JSON.parse(data.toString());

      if (!helloReceived) {
        if (parsed.type === "hello_ok") {
          helloReceived = true;

          const send = (env: object) => ws.send(JSON.stringify(env));

          const recv = (timeoutMs = 2000): Promise<any> => {
            if (pending.length > 0) {
              return Promise.resolve(pending.shift());
            }
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                waiter = null;
                rej(new Error("recv timeout"));
              }, timeoutMs);
              waiter = {
                resolve: (v) => { clearTimeout(timer); res(v); },
                reject: (e) => { clearTimeout(timer); rej(e); },
              };
            });
          };

          resolve({ ws, send, recv });
        } else if (parsed.type === "hello_error") {
          reject(new Error(`Hello rejected: ${JSON.stringify(parsed.payload)}`));
        }
        return;
      }

      // After hello, all messages go to the queue
      dispatch(parsed);
    });

    ws.on("open", () => {
      ws.send(JSON.stringify({
        version: 1,
        type: "hello",
        payload: {
          role,
          group_id: groupId,
          device_token: null,
        },
      }));
    });

    ws.on("error", (err) => {
      if (!helloReceived) reject(err);
    });
  });
}

export function msgEnvelope(msgId: string, text: string) {
  return {
    version: 1,
    type: "msg",
    payload: {
      msg_id: msgId,
      nonce: Buffer.from("test-nonce").toString("base64"),
      ciphertext: Buffer.from(text).toString("base64"),
    },
  };
}

export function typingEnvelope(_groupId: string) {
  return {
    version: 1,
    type: "typing",
    payload: {},
  };
}
