import { describe, expect, it } from "vitest";

import {
  ALL_CANONICAL_STATUSES,
  BUCKETS,
  CARRIER_ACCEPTANCE_STALE_HOURS,
  EXCEPTION_REASONS,
  TRANSIT_STALE_DAYS,
  EXCLUDED_STATUSES,
  bucketForOrder,
  bucketForStatus,
  exceptionsForOrder,
  type BucketId,
} from "@/lib/fulfillment-buckets";
import {
  FULFILLMENT_STATUS_ORDER,
  isTerminal,
  normalizeLegacyStatus,
  type FulfillmentStatus,
} from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// THE QUEUE INVARIANT.
//
//   Every non-terminal order belongs to EXACTLY ONE operational bucket, or is
//   explicitly and documentedly excluded.
//
// This is the guard on a real defect, not a hypothetical. The admin had three
// fulfillment tabs — awaiting_fulfillment, shipped, delivered — while Shippo
// writes label_purchased, in_transit, out_for_delivery, delivered and returned.
// It never writes `shipped` at all. So a normal, fully automatic order left
// every named queue the instant its label was bought and did not come back
// until it was delivered. Twelve reachable states had no home.
//
// These tests enumerate from FULFILLMENT_STATUS_ORDER — the pipeline's own
// list — rather than a copy. Adding a canonical status without giving it a
// bucket fails here, which is the entire point.
// ---------------------------------------------------------------------------

describe("every canonical status has exactly one home", () => {
  it.each(FULFILLMENT_STATUS_ORDER)("%s maps to a bucket or a documented exclusion", (status) => {
    const bucket = bucketForStatus(status);

    // `undefined` means nothing knows about it. That is the failure this test
    // exists to catch: a new status added to the pipeline and forgotten here.
    expect(
      bucket,
      `"${status}" has no bucket and is not in EXCLUDED_STATUSES. `
        + "A status with no bucket is invisible to every operational queue — "
        + "add it to BUCKETS in fulfillment-buckets.ts, or document it as an exclusion.",
    ).not.toBeUndefined();

    if (bucket === null) {
      expect(EXCLUDED_STATUSES).toContain(status);
    }
  });

  it("no status appears in two buckets", () => {
    const seen = new Map<FulfillmentStatus, BucketId>();
    const duplicates: string[] = [];
    for (const bucket of BUCKETS) {
      for (const status of bucket.statuses) {
        const previous = seen.get(status);
        if (previous) duplicates.push(`${status}: ${previous} and ${bucket.id}`);
        seen.set(status, bucket.id);
      }
    }
    expect(duplicates, `a status in two buckets means one order in two queues: ${duplicates.join("; ")}`)
      .toEqual([]);
  });

  it("an excluded status is never also in a bucket", () => {
    for (const status of EXCLUDED_STATUSES) {
      const inBucket = BUCKETS.some((b) => b.statuses.includes(status));
      expect(inBucket, `"${status}" is both excluded and bucketed`).toBe(false);
    }
  });

  it("covers every status the pipeline defines, with none left over", () => {
    const bucketed = BUCKETS.flatMap((b) => b.statuses);
    const accounted = new Set<string>([...bucketed, ...EXCLUDED_STATUSES]);
    const missing = FULFILLMENT_STATUS_ORDER.filter((s) => !accounted.has(s));
    expect(missing, `unaccounted statuses: ${missing.join(", ")}`).toEqual([]);

    // And the reverse: a bucket must not name a status the pipeline retired.
    const unknown = bucketed.filter((s) => !FULFILLMENT_STATUS_ORDER.includes(s));
    expect(unknown, `buckets name statuses the pipeline does not define: ${unknown.join(", ")}`).toEqual([]);
  });

  it("exposes the same status list the pipeline does", () => {
    expect(ALL_CANONICAL_STATUSES).toEqual(FULFILLMENT_STATUS_ORDER);
  });
});

// ---------------------------------------------------------------------------
// LEGACY ROWS. Historical orders are NOT rewritten — they are normalised on
// read. Every legacy value still present in live data must therefore land
// somewhere sensible.
// ---------------------------------------------------------------------------
describe("legacy statuses on live rows still find a bucket", () => {
  const LEGACY = [
    "pending",
    "pending_payment",
    "unpaid",
    "awaiting_fulfillment",
    "processing",
    "sent_to_fulfillment",
    "fulfilled",
    "partially_fulfilled",
    "canceled",
  ];

  it.each(LEGACY)("%s normalises into a bucket or a documented exclusion", (legacy) => {
    const normalised = normalizeLegacyStatus(legacy);
    expect(normalised, `"${legacy}" is not recognised by normalizeLegacyStatus`).not.toBeNull();
    expect(bucketForStatus(legacy)).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE ONE THAT STARTED THIS. A paid order held back by the amount-mismatch
// check must be visible, and must NOT be treated as ready to ship.
// ---------------------------------------------------------------------------
describe("the amount-mismatch hold", () => {
  it("is an exception reason derived from existing columns, not a new one", () => {
    const hold = EXCEPTION_REASONS.find((e) => e.reason === "payment_hold");
    expect(hold).toBeDefined();
    expect(hold?.derivedFrom).toContain("payment_status = 'paid'");
    expect(hold?.derivedFrom).toContain("fulfillment_status");
  });

  it("is NOT in Ready, even though its status alone would put it there", () => {
    // The trap this test guards. LEGACY_STATUS_MAP normalises the raw value
    // `pending` to `paid`, and `paid` lives in READY — so classifying by status
    // alone drops a held order straight into the pick queue.
    expect(bucketForStatus("pending")).toBe("ready");

    // The row-level answer is the one the queues use, and it disagrees.
    const held = { payment_status: "paid", fulfillment_status: "pending" };
    expect(exceptionsForOrder(held)).toContain("payment_hold");
    expect(bucketForOrder(held)).toBe("exceptions");
  });

  it("does not mistake a normal paid order for a hold", () => {
    const normal = { payment_status: "paid", fulfillment_status: "awaiting_fulfillment" };
    expect(exceptionsForOrder(normal)).toEqual([]);
    expect(bucketForOrder(normal)).toBe("ready");
  });

  it("does not mistake an unpaid new order for a hold", () => {
    // Same raw `pending`, but the money never arrived — not an exception,
    // and documentedly excluded from operational queues.
    const fresh = { payment_status: "pending_payment", fulfillment_status: "pending" };
    expect(exceptionsForOrder(fresh)).toEqual([]);
  });

  it("every exception reason documents where it is derived from", () => {
    for (const reason of EXCEPTION_REASONS) {
      expect(reason.derivedFrom.length, `${reason.reason} has no derivation`).toBeGreaterThan(0);
      expect(reason.action.length, `${reason.reason} tells the operator nothing to do`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The buckets an operator actually works must agree with the lifecycle: work
// stops once the carrier has the parcel.
// ---------------------------------------------------------------------------
describe("operational shape", () => {
  it("marks exactly the buckets a human acts on", () => {
    const operational = BUCKETS.filter((b) => b.operational).map((b) => b.id);
    expect(operational).toEqual(["ready", "in_progress", "awaiting_carrier", "exceptions"]);
  });

  it("does not ask an operator to work terminal states, outside exceptions", () => {
    // `returned` is terminal for the CARRIER — no scan may move it again — but
    // it is emphatically live work for a human, who must choose between a
    // reship and a refund. That is why it sits in Exceptions and why Exceptions
    // is the one operational bucket allowed to hold a terminal status.
    for (const bucket of BUCKETS) {
      if (!bucket.operational || bucket.id === "exceptions") continue;
      const terminal = bucket.statuses.filter((s) => isTerminal(s));
      expect(terminal, `${bucket.id} contains terminal statuses: ${terminal.join(", ")}`).toEqual([]);
    }
  });

  it("gives every bucket a label and an actionable description", () => {
    for (const bucket of BUCKETS) {
      expect(bucket.label.length).toBeGreaterThan(0);
      expect(bucket.description.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// THE TWO SILENCES.
//
// Every other exception asks "is this state wrong?". These ask "has nothing
// happened for too long?" — the failure mode a store only discovers when the
// customer asks. A label the carrier never scanned and a parcel that stopped
// moving are both invisible without them, because no status is incorrect.
// ===========================================================================
describe("stale shipments cannot stay invisible", () => {
  const NOW = Date.parse("2026-08-23T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const daysAgo = (d: number) => hoursAgo(d * 24);

  const labelled = (purchasedAt: string) => ({
    payment_status: "paid",
    fulfillment_status: "label_purchased",
    label_purchased_at: purchasedAt,
  });

  it("a label the carrier never scanned becomes an exception", () => {
    expect(exceptionsForOrder(labelled(hoursAgo(CARRIER_ACCEPTANCE_STALE_HOURS + 1)), NOW))
      .toContain("carrier_never_scanned");
    expect(bucketForOrder(labelled(hoursAgo(CARRIER_ACCEPTANCE_STALE_HOURS + 1)), NOW))
      .toBe("exceptions");
  });

  it("does NOT fire on a label bought an hour ago", () => {
    // A parcel collected the same afternoon is the normal case, and a queue
    // that cries wolf on it is a queue the operator learns to ignore.
    expect(exceptionsForOrder(labelled(hoursAgo(1)), NOW)).toHaveLength(0);
    expect(bucketForOrder(labelled(hoursAgo(1)), NOW)).toBe("awaiting_carrier");
  });

  it("does not fire one hour BEFORE the threshold, and does at it", () => {
    expect(exceptionsForOrder(labelled(hoursAgo(CARRIER_ACCEPTANCE_STALE_HOURS - 1)), NOW)).toHaveLength(0);
    expect(exceptionsForOrder(labelled(hoursAgo(CARRIER_ACCEPTANCE_STALE_HOURS)), NOW))
      .toContain("carrier_never_scanned");
  });

  it("a parcel that stopped moving becomes an exception", () => {
    const stalled = {
      payment_status: "paid",
      fulfillment_status: "in_transit",
      updated_at: daysAgo(TRANSIT_STALE_DAYS + 1),
    };
    expect(exceptionsForOrder(stalled, NOW)).toContain("transit_stalled");
    expect(bucketForOrder(stalled, NOW)).toBe("exceptions");
  });

  it("a parcel scanned yesterday is moving normally", () => {
    const moving = {
      payment_status: "paid",
      fulfillment_status: "in_transit",
      updated_at: daysAgo(1),
    };
    expect(exceptionsForOrder(moving, NOW)).toHaveLength(0);
    expect(bucketForOrder(moving, NOW)).toBe("in_transit");
  });

  it("out for delivery can stall too", () => {
    expect(exceptionsForOrder({
      payment_status: "paid",
      fulfillment_status: "out_for_delivery",
      updated_at: daysAgo(TRANSIT_STALE_DAYS + 2),
    }, NOW)).toContain("transit_stalled");
  });

  it("a DELIVERED order never goes stale — it arrived", () => {
    expect(exceptionsForOrder({
      payment_status: "paid",
      fulfillment_status: "delivered",
      updated_at: daysAgo(400),
    }, NOW)).toHaveLength(0);
  });

  it("a missing timestamp does not read as 'just now'", () => {
    // Returning 0 for an absent timestamp would make an order with no clock
    // look permanently fresh and never age into an exception. It reports
    // nothing instead, which is the honest answer.
    expect(exceptionsForOrder({
      payment_status: "paid",
      fulfillment_status: "label_purchased",
      label_purchased_at: null,
    }, NOW)).toHaveLength(0);
    expect(exceptionsForOrder({
      payment_status: "paid",
      fulfillment_status: "label_purchased",
      label_purchased_at: "not-a-date",
    }, NOW)).toHaveLength(0);
  });

  it("falls back to shipped_at when updated_at is absent", () => {
    expect(exceptionsForOrder({
      payment_status: "paid",
      fulfillment_status: "in_transit",
      shipped_at: daysAgo(TRANSIT_STALE_DAYS + 3),
    }, NOW)).toContain("transit_stalled");
  });

  it("every reason has a definition an operator can read", () => {
    for (const reason of ["carrier_never_scanned", "transit_stalled"] as const) {
      const def = EXCEPTION_REASONS.find((r) => r.reason === reason);
      expect(def, `${reason} has no definition`).toBeDefined();
      expect(def!.label).not.toMatch(/_/);          // no snake_case leaking to the operator
      expect(def!.action.length).toBeGreaterThan(20);
      expect(def!.derivedFrom.length).toBeGreaterThan(10);
    }
  });

  it("the thresholds are business configuration, and named as such", () => {
    expect(CARRIER_ACCEPTANCE_STALE_HOURS).toBeGreaterThan(0);
    expect(TRANSIT_STALE_DAYS).toBeGreaterThan(0);
    // The action text quotes the live value, so moving the constant moves the
    // words the operator reads — they can never drift apart.
    expect(EXCEPTION_REASONS.find((r) => r.reason === "carrier_never_scanned")!.action)
      .toContain(String(CARRIER_ACCEPTANCE_STALE_HOURS));
    expect(EXCEPTION_REASONS.find((r) => r.reason === "transit_stalled")!.action)
      .toContain(String(TRANSIT_STALE_DAYS));
  });
});
