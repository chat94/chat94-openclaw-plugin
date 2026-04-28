/**
 * Run a connection function with exponential backoff + jitter.
 * Copied from Mattermost plugin pattern.
 *
 * - On success (resolve): reset delay
 * - On error (reject): double delay up to maxDelayMs
 * - Jitter prevents thundering herd on reconnect
 */
export async function runWithReconnect(
  connectFn: () => Promise<void>,
  opts: {
    abortSignal?: AbortSignal;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    onError?: (error: unknown) => void;
    onReconnect?: (delayMs: number) => void;
    shouldReconnect?: (error: unknown) => boolean;
  } = {},
): Promise<void> {
  const {
    abortSignal,
    initialDelayMs = 2_000,
    maxDelayMs = 60_000,
    jitterRatio = 0.2,
    onError,
    onReconnect,
    shouldReconnect = () => true,
  } = opts;

  let retryDelay = initialDelayMs;

  while (!abortSignal?.aborted) {
    try {
      await connectFn();
      // Connection ended normally (e.g., server closed gracefully)
      retryDelay = initialDelayMs;
    } catch (error) {
      if (abortSignal?.aborted) break;

      onError?.(error);

      if (!shouldReconnect(error)) break;

      // Apply jitter: delay ± jitterRatio
      const jitter = retryDelay * jitterRatio * (Math.random() * 2 - 1);
      const delayWithJitter = Math.max(initialDelayMs, retryDelay + jitter);

      onReconnect?.(delayWithJitter);

      await sleep(delayWithJitter, abortSignal);

      // Exponential backoff
      retryDelay = Math.min(retryDelay * 2, maxDelayMs);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
