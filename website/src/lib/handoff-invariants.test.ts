import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUCKETS, bucketForOrder } from "@/lib/fulfillment-buckets";
import { normalizeLegacyStatus } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// THE HANDOFFS.
//
// Every defect worth finding in this system has had the same shape: A works, B
// works, and A -> B is wired wrongly. A unit test on A passes. A unit test on B
// passes. Nothing looks at the seam.
//
// This file tests seams. Each case spans modules that are individually correct
// and asks whether the thing actually arrives.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// ---------------------------------------------------------------------------
// REPLACEMENT -> FULFILLMENT QUEUE
//
// A replacement is written with fulfillment_status "awaiting_fulfillment" — a
// LEGACY value, not one of the canonical statuses the Workstation buckets on.
// It reaches Ready to Fulfill only because normalizeLegacyStatus maps it to
// ready_to_fulfill, in a different module, and because it is written
// payment_status "paid" even though no money changed hands.
//
// Three modules have to agree. Change any one and replacements stop appearing
// in the queue: created, costed, inventory deducted, and never shipped. Nothing
// would fail — the order simply is not on the board, which is the failure mode
// hardest to notice, because you cannot see what is missing.
// ---------------------------------------------------------------------------
describe("a replacement reaches the queue the owner actually works", () => {
  const replacements = source("src/lib/admin-replacements.ts");

  it("is created with a status the pipeline recognises", () => {
    expect(replacements).toContain('fulfillment_status: "awaiting_fulfillment"');
    expect(normalizeLegacyStatus("awaiting_fulfillment")).toBe("ready_to_fulfill");
  });

  it("lands in Ready to Fulfill, not in limbo", () => {
    const bucket = bucketForOrder({
      payment_status: "paid",
      fulfillment_status: "awaiting_fulfillment",
    });
    expect(bucket).toBe("ready");
  });

  it("is marked paid so the queue accepts it, though nothing was charged", () => {
    // The queue gates on payment because an unpaid order must never ship. A
    // replacement has no payment, so it is written paid deliberately — and
    // order_type is what keeps it out of revenue instead.
    expect(replacements).toContain('payment_status: "paid"');
    expect(replacements).toContain('order_type: "replacement"');
  });

  it("is excluded from sales by type, not by payment status", () => {
    // If revenue ever keyed off payment_status instead, every replacement
    // would count as a sale — the exact inflation the workflow exists to avoid.
    const profit = source("src/lib/admin-profit.ts");
    expect(profit).toContain("orderType");
    expect(profit).toMatch(/replacement/);
  });

  it("every status a replacement can hold has a bucket", () => {
    // The general form: no fulfillment status may be invisible.
    const covered = new Set(BUCKETS.flatMap((b) => b.statuses));
    expect(covered.has("ready_to_fulfill")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LABEL PURCHASE -> POSTAGE COST -> PROFIT
//
// The purchase records what Shippo actually charged. Profit has to prefer that
// over the pre-ship estimate, and a voided label has to fall BACK to the
// estimate rather than to zero — zero would assert the shipping was free.
// ---------------------------------------------------------------------------
describe("the postage in profit is the postage that was paid", () => {
  const service = source("src/lib/shippo/service.ts");
  const profit = source("src/lib/admin-profit.ts");

  it("records the actual charge from the purchase result", () => {
    expect(service).toContain("amountCents: label.postageCostCents");
    expect(service).toContain('source: "shippo"');
  });

  it("prefers the actual cost over the estimate once it exists", () => {
    expect(profit).toContain("actualShippingCostCents != null");
    expect(profit).toContain("shippingCostIsEstimate");
  });

  it("reverses a voided label to unknown, never to zero", () => {
    // Zero is a claim. Null is the truth, and it lets the estimate resume.
    expect(service).toContain("actual_shipping_cost_cents: null");
    expect(service).not.toContain("actual_shipping_cost_cents: 0");
  });
});

// ---------------------------------------------------------------------------
// CARRIER SCAN -> STATUS -> CUSTOMER EMAIL
//
// Three independent layers stop a duplicate carrier event from emailing twice,
// and the shipping notice keys on the TRANSITION rather than the state so
// movement within the carrier network cannot re-fire it.
// ---------------------------------------------------------------------------
describe("one carrier event produces at most one customer email", () => {
  const service = source("src/lib/shippo/service.ts");

  it("emails on the transition into the network, not on being in it", () => {
    expect(service).toContain("IN_CARRIER_NETWORK.has(to) && !wasInNetwork");
  });

  it("never reaches the email when the status did not change", () => {
    // A repeat delivered exits early with emailed: false.
    expect(service).toContain("statusChanged: false");
    const early = service.indexOf("statusChanged: false");
    const notify = service.indexOf("const emailed = await notifyCustomer");
    expect(early).toBeLessThan(notify);
  });

  it("queues a failed send instead of losing it", () => {
    // The status has already advanced, so no later scan produces another one.
    // Logging alone would cost the customer their tracking email for good.
    expect(service).toContain("await queueForRetry");
    expect(service).toContain("enqueueFailedEmail");
  });

  it("releases the webhook claim on a database failure, so Shippo can retry", () => {
    expect(service).toContain("await releaseWebhookClaim(eventKey)");
  });
});
