/**
 * Wait for the TikTok pixel to actually exist in the page.
 *
 * The consent gate makes this necessary. Accepting cookies dispatches
 * `vanta:cookie-consent` synchronously, but the pixel only exists a few
 * hundred milliseconds later — React has to re-render, Next has to inject the
 * script tag, and the browser has to execute it. Anything that reacts to the
 * consent event by immediately reading `window.ttq` therefore finds nothing and
 * gives up, which is how the most valuable ViewContent of all — the ad click's
 * landing page — went unreported.
 *
 * Polling rather than a load callback keeps this independent of how the script
 * is injected, and the bounded attempt count means a visitor who declined costs
 * a handful of no-op timer ticks and nothing more.
 */

export type PixelWaitOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to reading the real global. */
  isReady?: () => boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

/** Returns a cancel function. The callback runs at most once. */
export function whenPixelReady(callback: () => void, options: PixelWaitOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 6000;
  const isReady = options.isReady ?? (() => typeof window !== "undefined" && Boolean(window.ttq));
  const schedule = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimer = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let cancelled = false;
  let handle: unknown = null;
  let waited = 0;

  const tick = () => {
    if (cancelled) return;
    if (isReady()) {
      callback();
      return;
    }
    if (waited >= timeoutMs) return;
    waited += intervalMs;
    handle = schedule(tick, intervalMs);
  };

  tick();

  return () => {
    cancelled = true;
    if (handle !== null) cancelTimer(handle);
  };
}
