import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { purchaseLabelForOrder, voidLabelForOrder, type OrderLabel } from "@/lib/shippo/service";
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
 * Record the spend.
 *
 * Called for a genuine purchase AND for a failure that still produced a label,
 * because the audit log answers "what did this order cost us and who did it",
 * and a charge that only exists inside an error response is exactly the one
 * someone will need to find later. A reused label is not logged: it bought
 * nothing, and logging it would make one purchase look like several.
 */
async function auditLabelPurchase(input: {
  orderId: string;
  label: OrderLabel;
  username: string;
  request: Request;
  outcome: "purchased" | "purchased_not_saved" | "purchased_cost_unknown";
}) {
  const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
    action: "order_label_purchase",
    target_table: "orders",
    target_id: input.orderId,
    metadata: {
      outcome: input.outcome,
      shippoTransactionId: input.label.transactionId,
      shippoRateId: input.label.rateId,
      carrier: input.label.carrier,
      service: input.label.service,
      trackingNumber: input.label.trackingNumber,
      // Null when Shippo returned no usable amount. Never 0 — a 0 here would
      // read as "this label was free" in the audit trail.
      postageCostCents: input.label.postageCostCents,
      performedAt: input.label.purchasedAt ?? new Date().toISOString(),
      performedBy: input.username,
      ipAddress: getRequestIpAddress(input.request),
      userAgent: getRequestUserAgent(input.request),
    },
  });
  if (error) {
    // The postage is already bought. Failing the request over a missing audit
    // row would invite a second purchase, which is far worse than a gap here.
    console.error("Unable to audit label purchase for order", input.orderId, error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const { orderId } = await context.params;

  let rateId = "";
  try {
    const raw = await request.text();
    if (raw.trim()) {
      const body = JSON.parse(raw) as { rateId?: unknown; rate?: { object_id?: unknown } | null };
      // Accept either the id on its own or the whole rate object posted back
      // from the rates response — both are unambiguous, and rejecting the
      // second would be pedantry that costs an admin a failed purchase.
      rateId =
        (typeof body.rateId === "string" ? body.rateId.trim() : "") ||
        (typeof body.rate?.object_id === "string" ? body.rate.object_id.trim() : "");
    }
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!rateId) {
    return NextResponse.json(
      { success: false, error: "Choose a shipping service before buying a label." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await purchaseLabelForOrder(orderId, rateId, session.username);
  } catch (error) {
    // purchaseLabelForOrder returns typed failures and holds its claim on an
    // unknown outcome. Anything thrown from it is unexpected, so the answer must
    // not read as "safe to try again".
    console.error("Unexpected failure buying a shipping label for order", orderId, error);
    return NextResponse.json(
      {
        success: false,
        error: "The label purchase failed unexpectedly. Check the Shippo dashboard for this order before retrying.",
      },
      { status: 500 },
    );
  }

  if (!result.ok) {
    // Postage may still have been charged — audit it and hand the label back.
    if (result.label) {
      await auditLabelPurchase({
        orderId,
        label: result.label,
        username: session.username,
        request,
        outcome: result.code === "cost_unrecorded" ? "purchased_cost_unknown" : "purchased_not_saved",
      });
    }
    return NextResponse.json(
      {
        success: false,
        error: result.message,
        code: result.code,
        detail: result.detail ?? null,
        label: result.label ?? null,
      },
      { status: httpStatusForShippoError(result.code) },
    );
  }

  if (!result.data.reused) {
    await auditLabelPurchase({
      orderId,
      label: result.data,
      username: session.username,
      request,
      outcome: "purchased",
    });
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
