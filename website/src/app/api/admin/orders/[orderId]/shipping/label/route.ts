import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { purchaseLabelForOrder, voidLabelForOrder } from "@/lib/shippo/service";
import { httpStatusForShippoError } from "../error-status";

// ---------------------------------------------------------------------------
// POST   /api/admin/orders/<orderId>/shipping/label   buy the postage
// DELETE /api/admin/orders/<orderId>/shipping/label   void it and refund it
//
// The only two endpoints in this codebase that spend money at a carrier.
//
// AUTH. Admin session required on both, checked before anything else runs. A
// customer reaching POST would drain the Shippo balance; a customer reaching
// DELETE would cancel a label for a parcel already in a mail sack. There is no
// role gate beyond "is an admin": packing and shipping is the daily work of
// every account that gets into this dashboard, and making staff wait for a
// manager to void a mis-bought label would leave a wrong label live. Both
// actions are written to admin_audit_logs with who, when and what it cost.
//
// EXACTLY ONCE. This handler makes no attempt to de-duplicate; that lives in
// purchaseLabelForOrder's atomic claim, which is the only thing standing between
// a double-click and two charges. What matters here is the SHAPE of the answers:
//
//   * a repeat purchase returns 200 with `label.reused: true` — the same label,
//     not an error, because from the admin's point of view nothing went wrong;
//   * 409 (`purchase_in_progress`, `rate_expired`) means nothing was bought and
//     re-sending the identical request will not help;
//   * a failure that still carries a label (`db_error`, `cost_unrecorded`) means
//     POSTAGE WAS CHARGED. The label travels back in the response so it can
//     still be printed, and the spend is audited exactly as a success would be.
//     Nothing in that path invites a retry.
//
// Body: { "rateId": "<id from the rates endpoint>" }.
// ---------------------------------------------------------------------------

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}


/**
 * POST — buy the postage for ONE order.
 *
 * Restored (owner decision, 2026-08) under the inverse of the rule that removed
 * it: there must be exactly one system that can buy a label, and that system is
 * now Vanta. Shippo's dashboard stays available for recovery; the normal day
 * never opens it.
 *
 * This is reachable ONLY from an authenticated admin action. Nothing automatic
 * — no webhook, no cron, no render, no retry — calls it. The purchase requires
 * a deliberate POST with a rate selection in the body.
 *
 * Body: { rateId?, carrier?, serviceToken?, cheapest? } — see RateSelection.
 */
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const { orderId } = await context.params;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // An empty body is fine — it means "no explicit selection".
  }

  // `cheapest` must be asked for. Never inferred, so an empty body cannot
  // silently buy a different service than the operator reviewed.
  const selection = {
    rateId: typeof body.rateId === "string" ? body.rateId : null,
    carrier: typeof body.carrier === "string" ? body.carrier : null,
    serviceToken: typeof body.serviceToken === "string" ? body.serviceToken : null,
    cheapest: body.cheapest === true,
  };

  if (!selection.rateId && !selection.carrier && !selection.serviceToken && !selection.cheapest) {
    return NextResponse.json(
      { success: false, error: "Choose a shipping rate before buying a label.", code: "invalid_request" },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await purchaseLabelForOrder({ orderId, selection, actor: session.username });
  } catch (error) {
    // A throw here means we do not know whether Shippo charged. The claim is
    // still held by purchaseLabelForOrder, which is what stops a retry.
    console.error("Unexpected failure purchasing a shipping label for order", orderId, error);
    return NextResponse.json(
      { success: false, error: "The purchase did not confirm. Verify it before trying again." },
      { status: 500 },
    );
  }

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.message, code: result.code, detail: result.detail ?? null },
      { status: httpStatusForShippoError(result.code) },
    );
  }

  // AUDIT THE SPEND. `reused` distinguishes a real purchase from a refresh that
  // found the label already bought — without it, one purchase appears in the
  // audit log as several.
  const { error: auditError } = await supabaseAdmin.from("admin_audit_logs").insert({
    action: "order_label_purchase",
    target_table: "orders",
    target_id: orderId,
    metadata: {
      shippoTransactionId: result.data.transactionId,
      carrier: result.data.carrier,
      service: result.data.service,
      trackingNumber: result.data.trackingNumber,
      postageCostCents: result.data.postageCostCents,
      fulfillmentStatus: result.data.fulfillmentStatus,
      alreadyPurchased: result.data.reused,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });
  if (auditError) {
    console.error("Unable to audit label purchase for order", orderId, auditError);
  }

  return NextResponse.json({ success: true, label: result.data });
}


export async function DELETE(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const { orderId } = await context.params;

  let result;
  try {
    result = await voidLabelForOrder(orderId, session.username);
  } catch (error) {
    console.error("Unexpected failure voiding a shipping label for order", orderId, error);
    return NextResponse.json({ success: false, error: "Unable to void this label." }, { status: 500 });
  }

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.message, code: result.code, detail: result.detail ?? null },
      { status: httpStatusForShippoError(result.code) },
    );
  }

  const { error: auditError } = await supabaseAdmin.from("admin_audit_logs").insert({
    action: "order_label_void",
    target_table: "orders",
    target_id: orderId,
    metadata: {
      shippoTransactionId: result.data.transactionId,
      carrier: result.data.carrier,
      service: result.data.service,
      // The carrier accepted the refund but may not have settled it yet; the
      // recorded postage is cleared either way, so the audit trail records
      // which of the two it was.
      refundPending: result.data.refundPending,
      fulfillmentStatus: result.data.fulfillmentStatus,
      // `reused` means this call found the label already voided — a
      // double-click, distinguishable here from two separate voids.
      alreadyVoided: result.data.reused,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });
  if (auditError) {
    console.error("Unable to audit label void for order", orderId, auditError);
  }

  return NextResponse.json({ success: true, voided: result.data });
}
