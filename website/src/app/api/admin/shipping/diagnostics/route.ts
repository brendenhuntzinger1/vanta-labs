import { NextResponse } from "next/server";

import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getShippoStatus } from "@/lib/shippo/config";
import { getShippoOrder } from "@/lib/shippo/client";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/admin/shipping/diagnostics
//
// Answers one question that cannot be answered from the database alone:
// do the Shippo ids we stored actually exist on the account these credentials
// belong to?
//
// It exists because "the database says synced, the dashboard shows nothing" has
// two completely different causes with opposite fixes:
//
//   ids resolve      -> the credentials and the dashboard are looking at
//                       different accounts, or different test/live views of one
//   ids do not       -> the token that wrote them is not the token in use now
//
// Guessing between those wasted real time. Asking Shippo settles it.
//
// READ ONLY. Every call is a GET. Nothing is created, nothing is bought,
// nothing is written back to the database -- running this can never make the
// situation worse, which is the point of a diagnostic.
//
// The token is never returned, only the mode its prefix implies. Addresses and
// customer detail are not echoed either; the answer needs only whether the
// object resolved.
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const status = getShippoStatus();
  if (!status.configured) {
    return NextResponse.json({
      success: true,
      shippo: status,
      verdict: "SHIPPO_API_TOKEN is not set on this deployment.",
      orders: [],
    });
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_number, order_id, shippo_order_id, shippo_shipment_id, parcel_declared_oz, parcel_weight_estimated")
    .eq("payment_status", "paid")
    .not("shippo_order_id", "is", null)
    .order("shippo_synced_at", { ascending: false, nullsFirst: false })
    .limit(10);

  if (error) {
    console.error("Unable to load orders for Shippo diagnostics", error);
    return NextResponse.json({ success: false, error: "Could not load orders." }, { status: 500 });
  }

  const rows = data ?? [];
  const orders = [];
  // Sequential: a handful of orders, and a burst of parallel GETs is a good way
  // to be rate-limited while diagnosing a problem.
  for (const row of rows) {
    const shippoOrderId = String(row.shippo_order_id);
    const result = await getShippoOrder(shippoOrderId);
    orders.push({
      orderNumber: row.order_number ?? row.order_id,
      shippoOrderId,
      // The whole point of the endpoint.
      existsOnThisAccount: result.ok,
      httpStatus: result.ok ? 200 : (result.status ?? null),
      reason: result.ok ? null : result.message,
      parcelAttached: Boolean(row.shippo_shipment_id),
      declaredOz: row.parcel_declared_oz,
      weightIsAGuess: row.parcel_weight_estimated,
    });
  }

  const resolved = orders.filter((order) => order.existsOnThisAccount).length;
  const missing = orders.length - resolved;

  return NextResponse.json({
    success: true,
    shippo: status,
    checked: orders.length,
    resolved,
    missing,
    verdict:
      orders.length === 0
        ? "No paid orders have been pushed to Shippo yet."
        : missing === 0
          ? `All ${resolved} order(s) exist on the account this token belongs to. If the dashboard looks empty, it is showing a different account or the other test/live view.`
          : resolved === 0
            ? "None of these orders exist on the account this token belongs to. The token in use now is not the one that created them."
            : `${resolved} order(s) resolve and ${missing} do not, so these ids were written by more than one set of credentials.`,
    orders,
  });
}
