import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { getInventoryRows } from "@/lib/admin-inventory";
import { getInventoryHistory, type InventoryTransactionType } from "@/lib/inventory-ledger";
import {
  adjustStock,
  receiveAllIncoming,
  receiveShipment,
  setIncoming,
  type ReceiveLine,
} from "@/lib/inventory-operations";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Every stock movement a human makes, behind one endpoint.
//
// One route rather than five because the Inventory page is a single screen and
// each action needs the same three things: an authenticated admin, the
// manage-inventory role, and a ledger row. Splitting them would duplicate that
// preamble four more times and give four more chances to forget one.
//
// Customer sales are NOT here. They decrement through the payment webhook's
// exactly-once claim, which is correct and deliberately untouched.
// ---------------------------------------------------------------------------

const ADJUSTMENT_TYPES = new Set<InventoryTransactionType>([
  "manual_add",
  "manual_subtract",
  "damaged",
  "lost",
  "correction",
  "refund_restock",
]);

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageInventory(session.role)) {
    return NextResponse.json(
      { success: false, error: "Your role does not have permission to change inventory." },
      { status: 403 },
    );
  }

  let body: {
    action?: string;
    productId?: string;
    doseId?: string | null;
    delta?: number;
    quantity?: number;
    type?: string;
    reason?: string;
    lines?: ReceiveLine[];
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  const action = String(body.action ?? "");
  // Attribution comes from the verified session, never the payload — a
  // client-supplied actor would let the ledger be signed with someone else's
  // name, which is worse than no attribution at all.
  const actor = session.username;

  try {
    if (action === "receive_shipment") {
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (lines.length === 0) {
        return NextResponse.json({ success: false, error: "Add at least one line to receive." }, { status: 400 });
      }
      const result = await receiveShipment({ lines, reason: body.reason ?? null, actor });
      return NextResponse.json({
        success: result.failed.length === 0,
        received: result.received,
        failed: result.failed,
        rows: await getInventoryRows().catch(() => []),
      });
    }

    if (!body.productId) {
      return NextResponse.json({ success: false, error: "productId is required." }, { status: 400 });
    }
    const ref = { productId: String(body.productId), doseId: body.doseId ?? null };

    if (action === "adjust") {
      const rawType = String(body.type ?? "correction") as InventoryTransactionType;
      const type = ADJUSTMENT_TYPES.has(rawType) ? rawType : "correction";
      const result = await adjustStock({
        ref,
        delta: Number(body.delta ?? 0),
        type,
        reason: body.reason ?? null,
        actor,
      });
      if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 400 });
      return NextResponse.json({ success: true, ...result, rows: await getInventoryRows().catch(() => []) });
    }

    if (action === "set_incoming") {
      const result = await setIncoming({ ref, quantity: Number(body.quantity ?? 0), actor });
      if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 400 });
      return NextResponse.json({ success: true, ...result, rows: await getInventoryRows().catch(() => []) });
    }

    if (action === "receive_incoming") {
      const result = await receiveAllIncoming({ ref, actor });
      if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 400 });
      return NextResponse.json({ success: true, ...result, rows: await getInventoryRows().catch(() => []) });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error("Inventory operation failed", action, error);
    return NextResponse.json({ success: false, error: "That inventory action could not be completed." }, { status: 500 });
  }
}

/** Inventory history, for the drawer on the Inventory page. */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageInventory(session.role)) {
    return NextResponse.json(
      { success: false, error: "Your role does not have permission to view inventory history." },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const history = await getInventoryHistory({
    productId: url.searchParams.get("productId") ?? undefined,
    doseId: url.searchParams.get("doseId") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
  });
  return NextResponse.json({ success: true, history });
}
