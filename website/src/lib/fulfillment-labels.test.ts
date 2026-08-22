import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE BATCH LABEL FLOW, PINNED AT THE SOURCE.
//
// Same technique as replacement-shipping.test.ts: these are ORDERING and
// WIRING properties between modules, and the thing that breaks them is an edit
// that looks locally reasonable. A behavioural test would need the whole Shippo
// and Supabase stack mocked to say something a source assertion says exactly.
//
// Each assertion below corresponds to a defect that was actually possible.
// ---------------------------------------------------------------------------

const labels = readFileSync("src/lib/fulfillment-labels.ts", "utf8");
const route = readFileSync("src/app/api/admin/fulfillment/labels/route.ts", "utf8");
const printRoute = readFileSync("src/app/api/admin/fulfillment/labels/print/route.ts", "utf8");
const workstation = readFileSync("src/components/fulfillment-workstation.tsx", "utf8");
const batches = readFileSync("src/lib/fulfillment-batches.ts", "utf8");

describe("the confirmed price is the charged price", () => {
  it("the batch purchase passes the REVIEWED rate id, not just `cheapest`", () => {
    // THE DEFECT: `selection: { cheapest: true }` with no rate id skips the
    // quoted-rate cache and re-quotes at purchase time, so a rate that moved
    // between the review and the click is bought silently and the confirmation
    // dialog's total is not what gets charged.
    const fn = labels.slice(labels.indexOf("export async function purchaseBatchLabels"));
    expect(fn).toContain("selection: rateId ? { rateId, cheapest: true } : { cheapest: true }");
    expect(fn).not.toMatch(/selection:\s*\{\s*cheapest:\s*true\s*\},/);
  });

  it("the review hands the rate id out so a caller can carry it", () => {
    expect(labels).toContain("rateId: cheapest.object_id ?? null");
  });

  it("the workstation sends the rate id with every order it buys", () => {
    expect(workstation).toContain("orderId: l.orderId, rateId: l.rateId");
  });

  it("the route accepts the {orderId, rateId} pair form", () => {
    expect(route).toContain("purchaseBatchLabels(targets");
  });
});

describe("nothing that renders can spend money", () => {
  it("only the POST handler reaches the purchase", () => {
    const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
    expect(get).not.toContain("purchaseBatchLabels");
    expect(get).toContain("reviewBatchLabels");
  });

  it("the review path never calls the purchase", () => {
    const review = labels.slice(
      labels.indexOf("export async function reviewBatchLabels"),
      labels.indexOf("export type PurchaseOutcome"),
    );
    expect(review).not.toContain("purchaseLabelForOrder");
    expect(review).toContain("getRatesForOrder");
  });

  it("the POST refuses without an explicit confirmation", () => {
    expect(route).toContain("body.confirmSpend !== true");
    // And the refusal comes BEFORE the purchase call.
    expect(route.indexOf("confirmSpend !== true")).toBeLessThan(route.indexOf("purchaseBatchLabels(targets"));
  });

  it("a single request cannot launch an unbounded spend", () => {
    expect(route).toContain("MAX_ORDERS_PER_PURCHASE");
    expect(route).toMatch(/orderIds\.length > MAX_ORDERS_PER_PURCHASE/);
  });
});

describe("ambiguity is never retried", () => {
  it("every unknown-outcome code becomes needs_verification", () => {
    for (const code of [
      "timeout", "network", "invalid_response",
      "missing_cost", "db_error", "cost_unrecorded", "purchase_in_progress",
    ]) {
      expect(labels).toContain(`"${code}"`);
    }
  });

  it("a thrown purchase is treated as ambiguous, not as a failure to retry", () => {
    const catchBlock = labels.slice(labels.indexOf("} catch (error) {", labels.indexOf("purchaseBatchLabels")));
    expect(catchBlock).toContain('outcome: "needs_verification"');
  });

  it("an order with an unresolved claim is never re-bought by the review", () => {
    expect(labels).toContain("row.label_purchase_claimed_at");
    expect(labels).toContain("A previous label purchase never confirmed");
  });
});

describe("label order matches packing order", () => {
  it("one ordering function serves review, purchase and print", () => {
    expect(labels).toContain("export async function batchOrdersInPackingOrder");
    // Review and print both go through it.
    expect(labels.match(/batchOrdersInPackingOrder\(batchId\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("that ordering is identical to the packing bench's", () => {
    // If these two ever diverge, the printed sheet stops matching the queue and
    // the wrong label goes on the wrong parcel.
    const ORDERING = `.order("paid_at", { ascending: true, nullsFirst: false })`;
    expect(labels).toContain(ORDERING);
    expect(batches).toContain(ORDERING);
  });

  it("a voided label is excluded from the printed sheet", () => {
    expect(labels).toContain("label_voided_at");
    expect(labels).toContain("function hasLiveLabel");
  });
});

describe("the merged label sheet", () => {
  it("never calls Shippo's purchase API — reprinting cannot buy postage", () => {
    expect(printRoute).not.toContain("purchaseLabel");
    expect(printRoute).not.toContain("/transactions/");
  });

  it("requires an admin session before anything else", () => {
    const body = printRoute.slice(printRoute.indexOf("export async function GET"));
    expect(body.indexOf("verifyAdminSessionFromRequest")).toBeLessThan(body.indexOf("batchLabelUrls"));
  });

  it("only fetches from Shippo's own label hosts", () => {
    expect(printRoute).toContain("isAllowedLabelHost");
    expect(printRoute).toContain('url.protocol !== "https:"');
    expect(printRoute).toContain("goshippo.com");
  });

  it("survives one unreachable label rather than losing the whole sheet", () => {
    expect(printRoute).toContain("skipped.push");
    expect(printRoute).toContain("X-Labels-Skipped");
  });

  it("is never cached — a reprint after a void must not serve a dead label", () => {
    expect(printRoute).toContain('"Cache-Control": "no-store, max-age=0"');
  });
});
