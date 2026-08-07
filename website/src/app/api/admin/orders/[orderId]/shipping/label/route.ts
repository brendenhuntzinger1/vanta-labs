import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { voidLabelForOrder } from "@/lib/shippo/service";
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


// PURCHASE REMOVED, DELIBERATELY.
//
// Labels are bought in Shippo's dashboard and nowhere else. This endpoint used
// to buy postage, and leaving it in place would mean two independent systems
// could each buy a label for the same order.
//
// The exactly-once claim in this codebase serializes callers of THIS app; it
// knows nothing about a purchase made by hand in Shippo's UI. Two systems, two
// labels, one parcel, and the second charge is not refundable by clicking
// undo. The only safe way to guarantee one label per order is for exactly one
// system to be able to buy one.
//
// Deleting the route rather than hiding the button matters: a hidden button
// still leaves a reachable endpoint that a stale tab, a bookmarked request or
// a retried fetch can hit.
//
// The label still arrives here — via the transaction_created webhook in
// src/lib/shippo/order-sync.ts, which records the real postage cost, tracking
// and carrier against the order.


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
