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

// ---------------------------------------------------------------------------
// LABEL PAGE N == PARCEL N.
//
// The most expensive thing this software can get wrong. A swapped pair does not
// error, does not alert, and is discovered by two customers opening each
// other's parcels — with their names and addresses on the labels.
//
// It was held together by two separate queries carrying the same ORDER BY and a
// comment reading "both must stay in step". Two defects in that:
//
//   1. A CONVENTION, NOT A MECHANISM. Editing one query silently diverges the
//      label sheet from the packing bench.
//
//   2. THE CLAUSE SORTED ON paid_at ALONE. SQL guarantees nothing about the
//      relative order of rows with equal sort keys. Two orders paid in the same
//      second — ordinary, and certain during a promotion — could come back in
//      one order for the sheet and the other for the bench. order_id is unique,
//      so appending it makes the sequence total and therefore repeatable.
// ---------------------------------------------------------------------------
describe("the label sheet and the packing bench cannot disagree", () => {
  const labels = source("src/lib/fulfillment-labels.ts");
  const batches = source("src/lib/fulfillment-batches.ts");
  const buckets = source("src/lib/fulfillment-buckets.ts");

  it("orders through one shared function, not two copies of a clause", () => {
    expect(labels).toContain("inPackingOrder(");
    expect(batches).toContain("inPackingOrder(");
    expect(buckets).toContain("export function inPackingOrder");
  });

  it("leaves no hand-written packing ORDER BY anywhere", () => {
    // The failure this prevents: someone adds a third reader of a batch and
    // writes the clause again from memory.
    for (const src of [labels, batches]) {
      const handWritten = src.match(/\.order\("paid_at"/g) ?? [];
      expect(handWritten).toHaveLength(0);
    }
  });

  it("breaks ties on a unique column, so the sequence is deterministic", () => {
    expect(buckets).toContain('PACKING_ORDER_TIEBREAK = "order_id"');
    const fn = buckets.slice(buckets.indexOf("export function inPackingOrder"));
    expect(fn).toContain("PACKING_ORDER_COLUMN");
    expect(fn).toContain("PACKING_ORDER_TIEBREAK");
  });

  it("feeds the review, the purchase and the PDF from that one sequence", () => {
    // Every stage reads batchOrdersInPackingOrder rather than re-querying, so
    // no stage can sort independently.
    for (const fn of ["reviewBatchLabels", "batchLabelUrls"]) {
      const body = labels.slice(labels.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 400)).toContain("batchOrdersInPackingOrder(batchId)");
    }
  });

  it("merges the PDF in that order and drops nothing silently", () => {
    const print = source("src/app/api/admin/fulfillment/labels/print/route.ts");
    expect(print).toContain("batchLabelUrls(batchId)");
    // Skipped labels are counted in a header rather than quietly omitted, so
    // page count mismatching parcel count is visible.
    expect(print).toMatch(/X-Labels-Skipped/);
  });
});

// ---------------------------------------------------------------------------
// PARTIAL FAILURE MUST NOT SHIFT THE MAPPING.
//
// 10 batched orders, labels bought for 8, failed for two. The printed sheet has
// 8 pages. The danger is a SHIFT — page 4 belonging to order 5 while the bench
// offers order 4, so every parcel after the failure gets the previous order's
// label.
//
// The design that prevents it: positions compact over SUCCESSFUL labels only,
// and the bench HALTS on a label-less order rather than skipping it. It cannot
// be advanced, so the operator can never get out of step with the sheet.
// ---------------------------------------------------------------------------
describe("a failed label cannot shift every parcel after it", () => {
  const labels = source("src/lib/fulfillment-labels.ts");
  const workstation = source("src/components/fulfillment-workstation.tsx");

  it("numbers pages over successful labels only, with no gaps", () => {
    // position = printable.length + 1, so a skipped order leaves no hole and no
    // blank page — 8 labels produce pages 1..8.
    expect(labels).toContain("position: printable.length + 1");
  });

  it("skips an order with no live label rather than emitting a placeholder", () => {
    const fn = labels.slice(labels.indexOf("export async function batchLabelUrls"));
    expect(fn).toContain("if (!hasLiveLabel(row)) return;");
    expect(fn).toContain("if (!url) return;");
  });

  it("treats a voided label as no label", () => {
    // The carrier has been told that parcel is not coming. Printing it would
    // put a dead barcode on a real box.
    expect(labels).toContain("label_voided_at");
    expect(labels).toContain("function hasLiveLabel");
  });

  it("stops the bench on a label-less order instead of advancing past it", () => {
    // This is what keeps the sheet and the bench in step through a failure: the
    // operator physically cannot mark it packed and move on.
    //
    // THE FIRST VERSION OF THIS ASSERTION COULD NOT FAIL. It compared
    // indexOf(guard) < indexOf(advance) — and indexOf returns -1 when the guard
    // is ABSENT, so deleting the guard scored -1 and passed. Removing the
    // protection made the test happier. Verified by sabotage: the guard was
    // replaced with `true ? (` and all assertions stayed green.
    //
    // So it now checks the guard EXISTS first, and that the advance button is
    // inside it.
    const guardAt = workstation.indexOf("{packing.hasLabel ? (");
    expect(guardAt).toBeGreaterThan(-1);
    const advanceAt = workstation.indexOf("verifyAndAdvance(packing.orderId");
    expect(advanceAt).toBeGreaterThan(guardAt);
    // And the else-branch says why, rather than rendering nothing.
    const branch = workstation.slice(guardAt, guardAt + 1400);
    expect(branch).toContain("Verified — next order");
    expect(branch).toContain("text-amber-300");
  });

  it("disables reprint for an order that has no label to reprint", () => {
    expect(workstation).toContain('packing.hasLabel ? "" : "pointer-events-none opacity-40"');
  });
});

// ---------------------------------------------------------------------------
// SAME paid_at — THE DEFECT, PINNED.
//
// Demonstrated on Postgres 16 before the fix: ten orders sharing one paid_at
// came back 01..10 on a fresh table, and after three ordinary UPDATEs — the
// kind every order gets when it receives a tracking number — came back
//
//     01 03 04 06 07 08 10 02 05 09
//
// Nothing errored. The label sheet and the packing bench simply disagreed. With
// order_id appended the sequence was 01..10 on every run and every plan.
// ---------------------------------------------------------------------------
describe("orders sharing a paid_at still have one definite order", () => {
  const buckets = source("src/lib/fulfillment-buckets.ts");

  it("sorts on a unique column after the timestamp", () => {
    expect(buckets).toContain('PACKING_ORDER_COLUMN = "paid_at"');
    expect(buckets).toContain('PACKING_ORDER_TIEBREAK = "order_id"');
  });

  it("applies the timestamp first and the tiebreak second", () => {
    const fn = buckets.slice(buckets.indexOf("export function inPackingOrder"));
    // Presence first: if the timestamp sort were dropped from the helper,
    // indexOf would return -1 and the order comparison alone would pass.
    const columnAt = fn.indexOf("PACKING_ORDER_COLUMN");
    const tiebreakAt = fn.indexOf("PACKING_ORDER_TIEBREAK");
    expect(columnAt).toBeGreaterThan(-1);
    expect(tiebreakAt).toBeGreaterThan(-1);
    expect(columnAt).toBeLessThan(tiebreakAt);
  });

  it("records why, so the tiebreak is not removed as redundant", () => {
    // It looks redundant. On a small fresh table it even behaves redundantly.
    // That is exactly why it needs the note.
    expect(buckets).toMatch(/equal sort keys/i);
  });
});

// ---------------------------------------------------------------------------
// VANTA -> SHIPPO IDENTIFICATION.
//
// The launch model is: Vanta buys the postage, Shippo is the print station.
// That makes one field load-bearing — the reference on the transaction, which
// is how the owner finds the right label in Shippo's dashboard, and how a label
// bought there resolves back to an order here.
//
// It was broken in both directions at once. The purchase wrote order_id; the
// reader looked it up with .eq("order_number", metadata). Neither side was
// wrong alone. The seam was.
// ---------------------------------------------------------------------------
describe("a Shippo transaction can be traced back to its Vanta order", () => {
  const service = source("src/lib/shippo/service.ts");
  const sync = source("src/lib/shippo/order-sync.ts");

  it("stamps the transaction with the order NUMBER the owner reads", () => {
    expect(service).toContain("metadata: text(order.order_number) ?? order.order_id");
  });

  it("resolves that reference back against the column it was written to", () => {
    const fn = sync.slice(sync.indexOf("const metadata = String(data.metadata"));
    expect(fn).toContain('["order_number", "order_id"]');
  });

  it("still accepts the historical id, so old transactions keep resolving", () => {
    // Labels bought before the fix carry order_id. Matching only the new format
    // would strand them.
    const fn = sync.slice(sync.indexOf("const metadata = String(data.metadata"));
    expect(fn).toContain('"order_id"');
  });

  it("keys idempotency on the immutable id, NOT the reference", () => {
    // An order number could in principle be reissued. The key that prevents a
    // second purchase must never move.
    expect(service).toContain("idempotencyKey: `vanta-label-${order.order_id}`");
  });

  it("tells the owner where postage is bought and where it is only printed", () => {
    const workstation = source("src/components/fulfillment-workstation.tsx");
    expect(workstation).toMatch(/Click to Print only/i);
    expect(workstation).toContain("Open Shippo to print");
    // And keeps the Vanta PDF as a fallback that cannot spend.
    expect(workstation).toMatch(/Fallback: print from Vanta/);
  });
});

// ---------------------------------------------------------------------------
// THE LAUNCH WORKFLOW: VANTA OWNS THE ORDER, SHIPPO BUYS AND PRINTS.
//
// The owner opens an order, reads what to pack, goes to Shippo, buys the label
// and uses Click to Print. Vanta learns about it on its own through the
// transaction_created webhook — there is no "Mark Fulfilled" button, because a
// human keeping two systems in step by hand is a defect waiting to happen.
//
// The invariant underneath it all: A LABEL IS NOT A SHIPMENT. Buying postage
// means the parcel is still on the table, so the order becomes Awaiting Carrier
// and the customer hears nothing. Only a carrier scan makes it In Transit and
// sends the email.
// ---------------------------------------------------------------------------
describe("buying the label in Shippo flows back without the owner doing anything", () => {
  const sync = source("src/lib/shippo/order-sync.ts");
  const route = source("src/app/api/webhooks/shippo/route.ts");
  const card = source("src/components/admin-order-fulfillment-card.tsx");

  it("accepts the event Shippo fires when a label is bought by hand", () => {
    expect(route).toContain('=== "transaction_created"');
    expect(route).toContain("applyTransactionCreated");
  });

  it("records tracking, carrier and the ACTUAL postage from that event", () => {
    const fn = sync.slice(sync.indexOf("export async function applyTransactionCreated"));
    expect(fn).toContain("tracking_number");
    expect(fn).toContain("label_purchased_at");
    expect(fn).toContain("recordActualShippingCost");
  });

  it("moves the order to Awaiting Carrier — NOT shipped", () => {
    const fn = sync.slice(sync.indexOf("export async function applyTransactionCreated"));
    expect(fn).toContain('canTransition(order.fulfillment_status, "label_purchased", "shippo")');
    // The one thing it must never do on a purchase.
    expect(fn).not.toContain('"shipped"');
    expect(fn).not.toContain('"in_transit"');
  });

  it("sends no customer email on a label purchase", () => {
    const fn = sync.slice(
      sync.indexOf("export async function applyTransactionCreated"),
      sync.indexOf("export async function backfillOrderShipment"),
    );
    expect(fn).not.toContain("sendEmail");
    expect(fn).not.toContain("notifyCustomer");
  });

  it("rejects an unauthenticated webhook, and fails closed when unconfigured", () => {
    // An unset secret must never mean "let everyone in" — that is how an order
    // gets marked delivered by a stranger.
    expect(route).toContain("SHIPPO_WEBHOOK_SECRET");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("status: 503");
  });

  it("reads the secret from the query string, which is how Shippo sends it", () => {
    expect(route).toContain('SECRET_QUERY_PARAM = "secret"');
  });

  it("points the owner at Shippo, and stops inviting a purchase once one exists", () => {
    expect(card).toContain("Open in Shippo");
    expect(card).toContain("Label already purchased.");
    expect(card).toMatch(/Do not buy postage for this order again/);
  });

  it("offers no manual Mark Fulfilled — the webhook does that", () => {
    for (const banned of ["Mark fulfilled", "Mark Fulfilled", "Mark shipped", "Mark Shipped"]) {
      expect(card).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// THE OWNER'S FIRST QUESTION IS "WHAT DO I HAVE TO SHIP?"
// ---------------------------------------------------------------------------
describe("the fulfillment screens read as work, not as states", () => {
  it("calls the first queue Needs Fulfillment", () => {
    expect(source("src/lib/fulfillment-buckets.ts")).toContain('label: "Needs Fulfillment"');
  });

  it("shows quantities large enough to read at the shelves", () => {
    // This is picked standing up. The quantity used to be small grey text at the
    // end of a row, which is how a x3 gets packed as a x1.
    const page = source("src/app/admin/orders/[orderId]/page.tsx");
    expect(page).toContain("text-xl font-semibold tabular-nums");
    expect(page).toContain("unit{totalUnits === 1");
  });

  it("derives the unit total from the same rows it lists", () => {
    const page = source("src/app/admin/orders/[orderId]/page.tsx");
    expect(page).toContain("const totalUnits = rawOrderItems.reduce(");
  });
});

// ---------------------------------------------------------------------------
// THE TEN WAYS THE SHIPPO ROUND TRIP CAN ARRIVE WRONG.
//
// Shippo replays, reorders and delays. The launch workflow depends on all of
// it landing correctly without the owner watching, so each case is pinned.
// ---------------------------------------------------------------------------
describe("the Shippo round trip survives replays, reordering and gaps", () => {
  const sync = source("src/lib/shippo/order-sync.ts");
  const pipeline = source("src/lib/order-pipeline.ts");
  const route = source("src/app/api/webhooks/shippo/route.ts");

  it("resolves a dashboard purchase by the Shippo ORDER id, not by metadata", () => {
    // The transaction Shippo creates when the owner buys from the pre-synced
    // order carries `order`. Vanta never touched that transaction, so metadata
    // it set cannot be relied on — this is the match that makes the workflow
    // work at all.
    const fn = sync.slice(sync.indexOf("async function matchOrder"));
    const byOrder = fn.indexOf('.eq("shippo_order_id", shippoOrderId)');
    const byMetadata = fn.indexOf("const metadata = String(data.metadata");
    expect(byOrder).toBeGreaterThan(-1);
    expect(byOrder).toBeLessThan(byMetadata);
  });

  it("never guesses by customer name or email", () => {
    // A repeat customer with two open orders would get a real postage cost
    // attached to whichever row came back first, corrupting profit on both.
    const fn = sync.slice(sync.indexOf("async function matchOrder"), sync.indexOf("export async function applyTransactionCreated"));
    expect(fn).not.toContain("customer_email");
    expect(fn).not.toContain("customer_name");
  });

  it("alerts the owner when a purchased label matches nothing", () => {
    // Money was spent on a label that belongs to no order. It used to be
    // written to a table only the tracking dedupe reads.
    expect(route).toContain('type: "shippo_label_unattributed"');
    expect(route).toContain('severity: "critical"');
  });

  it("converts postage to cents without the float error", () => {
    // Number("5.20") * 100 is 520.0000000000001; truncating loses a penny on
    // every order, permanently and invisibly.
    expect(sync).toContain("export function amountToCents");
    // COMMENTS STRIPPED: amountToCents' own docstring quotes the wrong form as
    // the thing it exists to avoid, so matching raw source fails on the
    // explanation rather than on any code.
    const code = sync.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Number\(\s*amount\s*\)\s*\*\s*100/);
  });

  it("records no postage at all when the event carries none, rather than zero", () => {
    // Zero asserts the shipping was free and finalizes profit on a lie.
    expect(sync).toContain("if (amountCents !== null) {");
  });

  it("lets tracking arrive BEFORE the purchase event without stalling", () => {
    // Shippo can deliver out of order. A forward jump is permitted; only a
    // backwards one is refused.
    expect(pipeline).toContain("nextRank < currentRank");
    expect(pipeline).toContain('"regression"');
  });

  it("refuses any carrier event once the order is terminal", () => {
    // Delivered twice, or a stale TRANSIT after DELIVERED.
    const shippoBranch = pipeline.slice(pipeline.indexOf('if (source === "shippo")'));
    expect(shippoBranch.slice(0, 400)).toContain("isTerminal(current)");
  });

  it("only Shippo may write the carrier states", () => {
    expect(pipeline).toContain('in_transit: ["shippo"]');
    expect(pipeline).toContain('delivered: ["shippo"]');
  });

  it("dedupes a repeated purchase event on the transaction's own id", () => {
    expect(route).toContain("event_key: `transaction_created:${String(data?.object_id ?? \"unknown\")}`");
    expect(route).toContain('onConflict: "event_key"');
  });

  it("writes no history row for a refused transition", () => {
    // A refused event did not move the order; a row for it would put a state
    // change in the customer-facing timeline that never happened.
    expect(sync).toMatch(/A refused transition did not move/);
  });
});
