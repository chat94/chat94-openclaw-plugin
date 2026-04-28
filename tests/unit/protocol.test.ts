import { describe, it, expect } from "vitest";
import type { InnerMessage, RelayEnvelope } from "../../src/types.js";

describe("protocol", () => {
  it("hello message has correct format", () => {
    const hello: RelayEnvelope = {
        version: 1,
        type: "hello",
        payload: {
          role: "plugin",
          group_id: "test-group",
          device_token: null,
          app_version: "1.0.0",
          release_channel: "production",
        },
    };

    const parsed = JSON.parse(JSON.stringify(hello));
        expect(parsed.version).toBe(1);
        expect(parsed.type).toBe("hello");
        expect(parsed.payload.role).toBe("plugin");
        expect(parsed.payload.group_id).toBe("test-group");
        expect(parsed.payload.device_token).toBeNull();
        expect(parsed.payload.app_version).toBe("1.0.0");
        expect(parsed.payload.release_channel).toBe("production");
  });

  it("msg envelope has correct format", () => {
    const msg: RelayEnvelope = {
      version: 1,
      type: "msg",
      payload: {
        msg_id: "uuid-123",
        nonce: "base64nonce==",
        ciphertext: "base64ct==",
      },
    };

    const parsed = JSON.parse(JSON.stringify(msg));
    expect(parsed.type).toBe("msg");
    expect(parsed.payload.msg_id).toBe("uuid-123");
    expect(parsed.payload.nonce).toBe("base64nonce==");
  });

  it("pairing envelope formats", () => {
    const pairOpen: RelayEnvelope = {
      version: 1,
      type: "pair_open",
      payload: {
        role: "joiner",
        room_id: "abc123",
      },
    };
    const pairData: RelayEnvelope = {
      version: 1,
      type: "pair_data",
      payload: {
        t: "grant",
        proof: "proof==",
        wrapped_key: {
          ephemeral_pub: "pub==",
          nonce: "nonce==",
          ciphertext: "ct==",
        },
      },
    };
    const pairComplete: RelayEnvelope = {
      version: 1,
      type: "pair_complete",
      payload: {
        status: "ok",
      },
    };

    expect(JSON.parse(JSON.stringify(pairOpen))).toEqual(pairOpen);
    expect(JSON.parse(JSON.stringify(pairData))).toEqual(pairData);
    expect(JSON.parse(JSON.stringify(pairComplete))).toEqual(pairComplete);
  });

  it("inner text message format", () => {
    const inner: InnerMessage = {
      t: "text",
      id: "msg-1",
      from: {
        role: "plugin",
        device_id: "plugin-instance",
        device_name: "OpenClaw chat94",
        app_version: "1.0.0",
        bundle_id: "@chat94/openclaw-plugin",
      },
      body: { text: "hello" },
      ts: 1713000000000,
    };
    const parsed = JSON.parse(JSON.stringify(inner));
    expect(parsed).toEqual(inner);
    expect(parsed.from.app_version).toBe("1.0.0");
    expect(parsed.from.bundle_id).toBe("@chat94/openclaw-plugin");
  });

  it("inner streaming and status formats", () => {
    const delta: InnerMessage = {
      t: "text_delta",
      id: "stream-1",
      body: { delta: "hel" },
      ts: 1713000000000,
    };
    const end: InnerMessage = {
      t: "text_end",
      id: "stream-1",
      body: { text: "hello" },
      ts: 1713000000001,
    };
    const status: InnerMessage = {
      t: "status",
      id: "status-1",
      body: { status: "typing" },
      ts: 1713000000002,
    };

    expect(JSON.parse(JSON.stringify(delta))).toEqual(delta);
    expect(JSON.parse(JSON.stringify(end))).toEqual(end);
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });

  it("inner image message format", () => {
    const image: InnerMessage = {
      t: "image",
      id: "img-1",
      body: {
        data_base64: "/9j/4AAQSkZJRgABAQAAAQABAAD",
        mime_type: "image/jpeg",
      },
      ts: 1713000000003,
    };

    expect(JSON.parse(JSON.stringify(image))).toEqual(image);
  });
});
