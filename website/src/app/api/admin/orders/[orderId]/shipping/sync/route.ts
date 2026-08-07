import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { backfillOrderShipment, syncOrderToShippo } from "@/lib/shippo/order-sync";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Retry pushing an order into Shippo.
//
// The push happens automatically on payment, but it is best-effort by design:
// it must never block or fail a payment that has already been captured. So when
// it fails -- Shippo down, an address Shippo rejects, credentials not yet set --
// the order is paid and sitting in the admin with nowhere to ship from.
//
// This is the manual repair. It is the ONLY writing endpoint left in the
// shipping surface now that postage cannot be bought here, and it still cannot
// spend money: creating a Shippo order is a record, not a purchase.
// ---------------------------------------------------------------------------

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  const { orderId } = await context.params;
  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  // Clear a stale claim first.
  //
  // syncOrderToShippo releases its claim only when Shippo confirms nothing was
  // created; after a timeout it deliberately holds on, because the order may
  // exist and re-pushing would duplicate it in the Orders tab. That leaves a
  // permanently claimed order that automatic retries will never touch -- which
  // is correct for a machine and wrong for a human who has just looked in
  // Shippo and confirmed the order is not there.
  //
  // Pressing this button IS that confirmation. Only ever done deliberately, by
  // an authenticated admin, on an order with no Shippo id.
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("shippo_order_id, shippo_sync_claimed_at")
    .eq("order_id", orderId)
    .maybeSingle<{ shippo_order_id: string | null; shippo_sync_claimed_at: string | null }>();

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
  }

  // Already there -- but "there" has two meanings. An order can reach Shippo
  // with no parcel attached (the Order and its Shipment are separate calls, and
  // only the first is fatal), which shows up as blank dimensions and weight with
  // no rates. Reporting that as "already synced" is what left those orders
  // unrepairable: this was the only human-driven retry and it declined to act on
  // the one state that needed it.
  if (order.shippo_order_id) {
    const repair = await backfillOrderShipment(orderId);
    return NextResponse.json(
      repair.ok
        ? {
            success: true,
            alreadySynced: !repair.created,
            parcelAttached: repair.created,
            shippoOrderId: order.shippo_order_id,
          }
        : { success: false, error: repair.reason, retryable: repair.retryable },
      { status: repair.ok ? 200 : 502 },
    );
  }

  if (order.shippo_sync_claimed_at) {
    await supabaseAdmin
      .from("orders")
      .update({ shippo_sync_claimed_at: null })
      .eq("order_id", orderId)
      .is("shippo_order_id", null);
  }

  const result = await syncOrderToShippo(orderId);

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "order_shippo_sync_retry",
    target_table: "orders",
    target_id: orderId,
    metadata: {
      ok: result.ok,
      reason: result.ok ? null : result.reason,
      performedBy: session.username,
      performedAt: new Date().toISOString(),
      ipAddress,
      userAgent,
    },
  });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.reason, retryable: result.retryable },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    alreadySynced: !result.created,
    shippoOrderId: result.shippoOrderId,
  });
}
