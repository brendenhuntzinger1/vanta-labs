import { describe, expect, it, vi } from "vitest";
import { whenPixelReady } from "./pixel-ready";

/** A controllable clock, so the bounded wait can be tested without waiting. */
function fakeTimers() {
  const queue: { fn: () => void; at: number }[] = [];
  let now = 0;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      const handle = { fn, at: now + ms };
      queue.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle: unknown) => {
      const index = queue.indexOf(handle as { fn: () => void; at: number });
      if (index >= 0) queue.splice(index, 1);
    },
    advance(ms: number) {
      // Step to each timer's own due time rather than jumping the clock, so a
      // callback that schedules the next tick is honoured the way a real
      // interval chain would be.
      const target = now + ms;
      for (;;) {
        const next = queue.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        queue.splice(queue.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => queue.length,
  };
}

describe("waiting for the pixel", () => {
  it("runs immediately when it is already there", () => {
    const cb = vi.fn();
    whenPixelReady(cb, { isReady: () => true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires once the pixel appears later — the late-consent case", () => {
    // The regression this exists for: landing on a product page from an ad,
    // accepting cookies there, and losing ViewContent because the one check
    // happened before the pixel existed.
    const timers = fakeTimers();
    const cb = vi.fn();
    let ready = false;
    whenPixelReady(cb, { ...timers, isReady: () => ready, intervalMs: 100, timeoutMs: 1000 });
    expect(cb).not.toHaveBeenCalled();

    timers.advance(300);
    expect(cb).not.toHaveBeenCalled();
    ready = true;
    timers.advance(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than polling forever when consent is never given", () => {
    const timers = fakeTimers();
    const cb = vi.fn();
    whenPixelReady(cb, { ...timers, isReady: () => false, intervalMs: 100, timeoutMs: 500 });
    timers.advance(5000);
    expect(cb).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it("never fires after being cancelled", () => {
    const timers = fakeTimers();
    const cb = vi.fn();
    let ready = false;
    const cancel = whenPixelReady(cb, { ...timers, isReady: () => ready, intervalMs: 100, timeoutMs: 1000 });
    cancel();
    ready = true;
    timers.advance(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires at most once", () => {
    const timers = fakeTimers();
    const cb = vi.fn();
    whenPixelReady(cb, { ...timers, isReady: () => true, intervalMs: 100, timeoutMs: 1000 });
    timers.advance(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
