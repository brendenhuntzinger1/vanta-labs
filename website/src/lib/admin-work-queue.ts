// ---------------------------------------------------------------------------
// WHAT IS WAITING FOR A HUMAN RIGHT NOW.
//
// The one question an owner opens Admin to answer, and the one number the
// dashboard never carried. It had ten tiles -- revenue rendered twice among
// them -- and none of them said how many orders were waiting to ship.
//
// This does NOT compute anything new. It reshapes the buckets the fulfilment
// workstation already derives (fulfillment-buckets.ts owns those definitions)
// so the nav and the dashboard cannot report a different number from the queue
// the operator will actually work.
//
// Kept pure and dependency-free so it is testable without a database, and so
// the same summary can be rendered by a server page or handed to a client
// component as props.
// ---------------------------------------------------------------------------

/** The shape getBucketCounts() returns. Duplicated structurally, not imported,
 *  because fulfillment-queues.ts is server-only and this runs on both sides. */
export interface WorkQueueBucket {
  id: string;
  label: string;
  description: string;
  operational: boolean;
  count: number;
}

export interface WorkQueueSummary {
  /** Paid, eligible, nothing done yet — the pick queue. */
  needsFulfillment: number;
  /** Picked or packed, not yet labelled. */
  inProgress: number;
  /** Held for a human decision. Worked FIRST — see fulfillment-buckets.ts. */
  exceptions: number;
  /** Unresolved `critical` system alerts. */
  openCriticalAlerts: number;
  /** Everything above. The headline "you have N things to do". */
  totalActionable: number;
}

/** A count that reached us as null, negative, NaN or a string becomes 0.
 *  A dashboard that renders "NaN orders waiting" is worse than a blank one. */
function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function countFor(buckets: readonly WorkQueueBucket[], id: string): number {
  return safeCount(buckets.find((bucket) => bucket.id === id)?.count);
}

/**
 * Reduce the operational buckets plus open criticals to the four numbers worth
 * putting in front of an owner.
 *
 * DELIBERATELY EXCLUDES in_transit, out_for_delivery and delivered. Those are
 * the carrier's states: nobody at Vanta does anything about them, and folding
 * them in would tell an owner with an empty pick queue that thirty things need
 * attention. `awaiting_carrier` is excluded for the same reason — the label is
 * bought and the parcel is waiting for a scan.
 */
export function summarizeWorkQueue(
  buckets: readonly WorkQueueBucket[],
  openCriticalAlerts: number,
): WorkQueueSummary {
  const needsFulfillment = countFor(buckets, "ready");
  const inProgress = countFor(buckets, "in_progress");
  const exceptions = countFor(buckets, "exceptions");
  const criticals = safeCount(openCriticalAlerts);

  return {
    needsFulfillment,
    inProgress,
    exceptions,
    openCriticalAlerts: criticals,
    totalActionable: needsFulfillment + inProgress + exceptions + criticals,
  };
}

/** An empty summary — the shape to fall back to when a read fails, so a
 *  degraded dashboard renders zeros rather than throwing the whole page. */
export const EMPTY_WORK_QUEUE: WorkQueueSummary = {
  needsFulfillment: 0,
  inProgress: 0,
  exceptions: 0,
  openCriticalAlerts: 0,
  totalActionable: 0,
};
