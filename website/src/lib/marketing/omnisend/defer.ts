import "server-only";

import { after } from "next/server";

/**
 * Run a piece of Omnisend work AFTER the response has been sent.
 *
 * Every order hook is called from a place that has already done the real
 * work — a payment webhook that must acknowledge inside the provider's
 * timeout, an admin action, a Shippo tracking update — and none of them may
 * wait on, or fail over, a marketing sync. next/server's after() is the
 * mechanism: the callback runs once the response is flushed, so a slow or
 * refused Omnisend request cannot add its latency to a checkout.
 *
 * after() throws when there is no request scope, and the order code is
 * reachable from places that have none — the reconciliation sweep, a script,
 * a test. The payment webhook's own Shippo deferral swallows that throw and
 * lets its sweep pick the order up; the same is true here, with one
 * difference: the work is started inline instead of dropped, because the
 * cancel and fulfilment events have no backstop of their own. It is not
 * awaited, so a caller without a request scope is still never delayed.
 *
 * The hooks already catch everything. The guard here is for the day someone
 * edits one so that it does not.
 */
export function deferOmnisend(label: string, run: () => Promise<unknown>): void {
  const guarded = async () => {
    try {
      await run();
    } catch (error) {
      console.error(`[omnisend/${label}] deferred work threw`, error);
    }
  };
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}
