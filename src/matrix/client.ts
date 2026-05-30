/**
 * Matrix client lifecycle for one chat4000 account.
 *
 * Wraps matrix-js-sdk: builds the client from persisted credentials, brings up
 * Rust E2E crypto (PROTOCOL: all session content is end-to-end encrypted — if
 * crypto can't initialize, the channel does not start), runs the sync loop, and
 * surfaces decrypted room messages + connection state to the channel layer.
 *
 * The plugin uses the Matrix client-server API directly against the homeserver;
 * the WS Gateway (PROTOCOL §4) is for end-user devices, not required here.
 *
 * Reference: /tmp/openclaw/extensions/matrix/src/matrix/{client,sdk}.ts.
 */
import path from "node:path";
// fake-indexeddb/auto installs an in-memory IndexedDB into global scope so the
// Rust crypto WASM store has somewhere to live under Node.
// NOTE(persistence): in-memory only; durable crypto-store snapshotting to
// state/<account>/crypto is a follow-up (see reference idb-persistence.ts).
import "fake-indexeddb/auto";
import {
  ClientEvent,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  type Room,
  RoomEvent,
  SyncState,
} from "matrix-js-sdk";
import { ensureDir, resolveChat4000AccountStateDir } from "../paths.js";
import { decodeCommandEvent, decodeInboundEvent, type MatrixInboundCommand } from "./inbound.js";
import type {
  MatrixConnectionState,
  MatrixCredentials,
  MatrixInboundMessage,
} from "./types.js";

export type MatrixClientHandleOptions = {
  accountId: string;
  credentials: MatrixCredentials;
  initialSyncLimit?: number;
  abortSignal?: AbortSignal;
  onConnectionState?: (state: MatrixConnectionState) => void;
  onMessage?: (message: MatrixInboundMessage) => void;
  /** chat4000.command control events (PROTOCOL §5). */
  onCommand?: (command: MatrixInboundCommand) => void;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
};

/**
 * Live handle around a started Matrix client. `start()` resolves once the
 * initial sync completes; `stop()` tears the client down.
 */
export class MatrixClientHandle {
  readonly client: MatrixClient;

  private started = false;

  private readonly opts: MatrixClientHandleOptions;

  private readonly startedAtTs = Date.now();

  private constructor(client: MatrixClient, opts: MatrixClientHandleOptions) {
    this.client = client;
    this.opts = opts;
  }

  static async create(opts: MatrixClientHandleOptions): Promise<MatrixClientHandle> {
    const { credentials } = opts;
    const stateDir = ensureDir(resolveChat4000AccountStateDir(opts.accountId));
    // Reserved for future disk-backed crypto snapshots.
    void path.join(stateDir, "crypto");

    const client = createClient({
      baseUrl: credentials.homeserver,
      accessToken: credentials.accessToken,
      userId: credentials.userId,
      deviceId: credentials.deviceId,
    });

    // E2E is mandatory. initRustCrypto throwing here propagates and prevents the
    // channel from starting (no cleartext fallback).
    await client.initRustCrypto();

    return new MatrixClientHandle(client, opts);
  }

  /** Start sync; resolves on first successful sync (PREPARED/SYNCING). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client.on(ClientEvent.Sync, (state: SyncState) => {
      switch (state) {
        case SyncState.Prepared:
        case SyncState.Syncing:
          this.opts.onConnectionState?.("connected");
          break;
        case SyncState.Reconnecting:
        case SyncState.Error:
          this.opts.onConnectionState?.("reconnecting");
          break;
        case SyncState.Stopped:
          this.opts.onConnectionState?.("disconnected");
          break;
        default:
          break;
      }
    });

    this.client.on(RoomEvent.Timeline, (event: MatrixEvent, _room: Room | undefined) => {
      this.handleTimelineEvent(event);
    });

    this.opts.onConnectionState?.("connecting");
    await this.client.startClient({
      initialSyncLimit: this.opts.initialSyncLimit ?? 20,
    });
    await this.waitForInitialSync();

    if (this.opts.abortSignal) {
      this.opts.abortSignal.addEventListener("abort", () => void this.stop(), { once: true });
    }
  }

  private waitForInitialSync(): Promise<void> {
    return new Promise<void>((resolve) => {
      const onSync = (state: SyncState) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          this.client.off(ClientEvent.Sync, onSync);
          resolve();
        }
      };
      this.client.on(ClientEvent.Sync, onSync);
    });
  }

  private handleTimelineEvent(event: MatrixEvent): void {
    // Ignore our own echoes.
    if (event.getSender() === this.opts.credentials.userId) return;
    // Only act on live messages, not paginated history.
    if (event.getTs() < this.startedAtTs) return;

    const deliver = () => {
      const command = decodeCommandEvent(event);
      if (command) {
        this.opts.onCommand?.(command);
        return;
      }
      const decoded = decodeInboundEvent(event);
      if (decoded) this.opts.onMessage?.(decoded);
    };

    if (event.isEncrypted() && event.isBeingDecrypted?.()) {
      event.once(MatrixEventEvent.Decrypted, () => deliver());
      return;
    }
    deliver();
  }

  /** Mark a room read up to the given event (PROTOCOL: m.read.private receipt). */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    try {
      const room = this.client.getRoom(roomId);
      const event = room?.findEventById(eventId);
      if (!event) return;
      await this.client.sendReadReceipt(event);
    } catch (err) {
      this.opts.log?.debug?.(`read receipt failed: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      this.client.stopClient();
    } catch {
      // best-effort
    }
    this.opts.onConnectionState?.("disconnected");
  }
}
