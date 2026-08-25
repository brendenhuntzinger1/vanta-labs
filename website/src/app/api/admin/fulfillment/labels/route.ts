import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { batchLabelUrls, purchaseBatchLabels, reviewBatchLabels } from "@/lib/fulfillment-labels";
import { labelPurchasingEnabled, PURCHASING_DISABLED_MESSAGE } from "@/lib/shippo/service";

// ---------------------------------------------------------------------------
// GET  /api/admin/fulfillment/labels?batchId=…            review — SPENDS NOTHING
// GET  /api/admin/fulfillment/labels?batchId=…&view=urls  printable labels
// POST /api/admin/fulfillment/labels                      BUY — SPENDS MONEY
//
// The split between GET and POST is the safety property, not a REST convention.
// A page that renders, refreshes or is opened in a second tab issues GETs, and
// no GET in this file can spend a cent. Money moves only on a POST that names
// the orders explicitly.
//
// The POST body carries `orderIds`, NOT just a batch id. The set that gets
// bought is therefore the set the operator saw and confirmed, even if the batch
// changed between the review and the click.
// ---------------------------------------------------------------------------

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

/** One request must not be able to launch an unbounded spend. */
const MAX_ORDERS_PER_PURCHASE = 25;

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ success: false, error: "A batchId is required." }, { status: 400 });
  }

  try {
    if (url.searchParams.get("view") === "urls") {
      return NextResponse.json({ success: true, labels: await batchLabelUrls(batchId) });
    }
    return NextResponse.json({ success: true, review: await reviewBatchLabels(batchId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to review labels.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  // Accepts either bare ids or {orderId, rateId} pairs. The pair form carries
  // the rate the operator confirmed, so the purchase buys what was priced.
  const targets = Array.isArray(body.orderIds)
    ? body.orderIds
        .map((entry) =>
          typeof entry === "string"
            ? { orderId: entry, rateId: null as string | null }
            : {
                orderId: String((entry as Record<string, unknown>)?.orderId ?? ""),
                rateId:
                  typeof (entry as Record<string, unknown>)?.rateId === "string"
                    ? String((entry as Record<string, unknown>).rateId)
                    : null,
              },
        )
        .filter((t) => t.orderId.length > 0)
    : [];
  const orderIds = targets.map((t) => t.orderId);

  if (orderIds.length === 0) {
    return NextResponse.json(
      { success: false, error: "Name the orders to buy labels for." },
      { status: 400 },
    );
  }
  if (orderIds.length > MAX_ORDERS_PER_PURCHASE) {
    return NextResponse.json(
      {
        success: false,
        error: `Buy at most ${MAX_ORDERS_PER_PURCHASE} labels per request. Send the batch in chunks.`,
      },
      { status: 400 },
    );
  }

  // POLICY FIRST, BEFORE ANY PER-ORDER WORK.
  //
  // purchaseLabelForOrder refuses each line anyway — that is the real guard,
  // and it sits at the money boundary so every caller inherits it. Answering
  // here as well means a stray call gets ONE clear sentence instead of N
  // identical per-line refusals, and the batch loop never starts.
  if (!labelPurchasingEnabled()) {
    return NextResponse.json(
      { success: false, error: PURCHASING_DISABLED_MESSAGE },
      { status: 403 },
    );
  }

  // EXPLICIT CONFIRMATION, carried in the request itself. A caller that has not
  // acknowledged the spend cannot buy, so no stale tab, replayed fetch or
  // hand-crafted request reaches the purchase without saying it means to.
  if (body.confirmSpend !== true) {
    return NextResponse.json(
      { success: false, error: "This purchase was not confirmed." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await purchaseBatchLabels(targets, session.username);
  } catch (error) {
    console.error("Batch label purchase failed outright", error);
    return NextResponse.json(
      { success: false, error: "The purchase did not confirm. Review the batch before trying again." },
      { status: 500 },
    );
  }

  // AUDIT THE SPEND — what was actually bought, not what was asked for.
  const { error: auditError } = await supabaseAdmin.from("admin_audit_logs").insert({
    action: "fulfillment_batch_label_purchase",
    target_table: "orders",
    target_id: String(body.batchId ?? ""),
    metadata: {
      requested: orderIds.length,
      purchased: result.purchased,
      alreadyHadOne: result.alreadyHadOne,
      failed: result.failed,
      needsVerification: result.needsVerification,
      spentCents: result.spentCents,
      // Named individually so an unconfirmed purchase is traceable later.
      needsVerificationOrders: result.lines
        .filter((l) => l.outcome === "needs_verification")
        .map((l) => l.orderId),
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });
  if (auditError) {
    console.error("Unable to audit batch label purchase", auditError);
  }

  return NextResponse.json({ success: true, result });
}
