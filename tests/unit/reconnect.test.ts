import { describe, it, expect } from "vitest";
import { runWithReconnect } from "../../src/reconnect.js";

describe("reconnect", () => {
  // #14
  it("reconnects after disconnect", async () => {
    let connectCount = 0;
    const controller = new AbortController();

    await runWithReconnect(
      async () => {
        connectCount++;
        if (connectCount < 3) throw new Error("simulated disconnect");
        // Third time succeeds — abort to exit loop
        controller.abort();
      },
      {
        abortSignal: controller.signal,
        initialDelayMs: 10,
        maxDelayMs: 50,
      },
    );

    expect(connectCount).toBe(3);
  });

  // #15
  it("respects abort signal", async () => {
    const controller = new AbortController();
    let connectCount = 0;

    setTimeout(() => controller.abort(), 100);

    await runWithReconnect(
      async () => {
        connectCount++;
        throw new Error("always fail");
      },
      {
        abortSignal: controller.signal,
        initialDelayMs: 10,
        maxDelayMs: 20,
      },
    );

    expect(connectCount).toBeGreaterThan(0);
    expect(connectCount).toBeLessThan(50);
  });

  it("resets delay after success", async () => {
    const delays: number[] = [];
    let connectCount = 0;
    const controller = new AbortController();

    await runWithReconnect(
      async () => {
        connectCount++;
        if (connectCount === 1) throw new Error("fail once");
        if (connectCount === 2) return; // succeed — delay resets
        if (connectCount === 3) throw new Error("fail again");
        // connectCount 4: abort
        controller.abort();
      },
      {
        abortSignal: controller.signal,
        initialDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0,
        onReconnect: (delayMs) => delays.push(delayMs),
      },
    );

    // First failure → delay 10ms, success → reset, second failure → delay 10ms again (not 20)
    expect(delays.length).toBeGreaterThanOrEqual(2);
    // Second delay should be reset to initialDelayMs, not doubled
    expect(delays[1]).toBe(10);
  });

  it("shouldReconnect can stop retries", async () => {
    let connectCount = 0;

    await runWithReconnect(
      async () => {
        connectCount++;
        throw new Error("fatal");
      },
      {
        initialDelayMs: 10,
        shouldReconnect: () => false,
      },
    );

    expect(connectCount).toBe(1);
  });

  it("calls onError on each failure", async () => {
    const errors: string[] = [];
    let connectCount = 0;
    const controller = new AbortController();

    await runWithReconnect(
      async () => {
        connectCount++;
        if (connectCount <= 3) throw new Error(`error-${connectCount}`);
        controller.abort();
      },
      {
        abortSignal: controller.signal,
        initialDelayMs: 10,
        onError: (err) => errors.push(String(err)),
      },
    );

    expect(errors).toEqual([
      "Error: error-1",
      "Error: error-2",
      "Error: error-3",
    ]);
  });
});
