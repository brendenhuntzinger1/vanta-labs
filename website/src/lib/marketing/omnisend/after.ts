import { after } from "next/server";

/**
 * Run a marketing hook after the response has gone, and never let it fail
 * the request.
 *
 * Every Omnisend hook is called from a place that has already done the real
 * work — a consent row written, a cart row written, a preference saved — and
 * none of that work may wait on, or fail over, a marketing sync. Next's
 * after() is the right tool inside a request scope: the callback runs once
 * the response is on its way and the platform keeps the function alive for
 * it. Outside a request scope after() THROWS, so a library function that can
 * be reached from a script or a test falls back to fire-and-forget rather
 * than turning the marketing hook into the thing that broke the caller.
 *
 * The work is a thunk rather than a promise so nothing starts until the
 * scheduler decides where it runs, and so the caller can put the dynamic
 * import of the hooks module inside it — which keeps cart-recovery.ts, which
 * hooks.ts imports, free of a static cycle.
 */
export function omnisendAfter(work: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await work();
    } catch (error) {
      console.error("[omnisend/after] hook failed", error);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
