import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { adjustInventoryLine, getInventoryReadiness, getInventoryRows } from "@/lib/admin-inventory";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

/**
 * GET /api/admin/inventory              rows + a freshly measured readiness summary
 * GET /api/admin/inventory?summary=1    readiness only, for the Settings screen
 *
 * The readiness summary is what the "Enforce inventory on the storefront"
 * switch checks before it will let the operator arm it. It is measured HERE,
 * against the database, every time it is asked for — a settings tab that has
 * been open since this morning must not be able to answer "is the catalog
 * populated?" from its own stale copy, because that is precisely the case where
 * flipping the switch silently unlists everything.
 */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const summaryOnly = new URL(request.url).searchParams.get("summary") === "1";
    if (summaryOnly) {
      const readiness = await getInventoryReadiness();
      return NextResponse.json({ success: true, readiness });
    }

    const [rows, readiness] = await Promise.all([getInventoryRows(), getInventoryReadiness()]);
    return NextResponse.json({ success: true, rows, readiness });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load inventory";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

interface InventoryPatchBody {
  productId?: string;
  doseId?: string | null;
  quantity?: number;
  lowStockThreshold?: number;
  /**
   * Packed weight of one unit in ounces. Present-and-null means "clear it"
   * (a dose then inherits its product), absent means "leave it alone" — so the
   * two are read apart with a key check rather than an `undefined` test.
   */
  shippingWeightOz?: number | null;
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageInventory(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage inventory." }, { status: 403 });
  }

  try {
    const body = await request.json() as InventoryPatchBody;

    if (!body.productId) {
      return NextResponse.json({ success: false, error: "productId is required" }, { status: 400 });
    }

    // `shippingWeightOz: null` is a real instruction (clear the override), not
    // an omission, so distinguish "key absent" from "key set to null".
    const touchesWeight = Object.prototype.hasOwnProperty.call(body, "shippingWeightOz");
    const shippingWeightOz = touchesWeight
      ? (body.shippingWeightOz === null || body.shippingWeightOz === undefined ? null : Number(body.shippingWeightOz))
      : undefined;

    await adjustInventoryLine({
      productId: body.productId,
      doseId: body.doseId ?? null,
      quantity: body.quantity,
      lowStockThreshold: body.lowStockThreshold,
      ...(touchesWeight ? { shippingWeightOz } : {}),
    });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "inventory_adjust",
      target_table: body.doseId ? "product_doses" : "products",
      target_id: body.doseId ?? body.productId,
      metadata: {
        quantity: body.quantity ?? null,
        lowStockThreshold: body.lowStockThreshold ?? null,
        // Weight changes cost real money on every future label, so they are
        // logged distinctly from "not touched" rather than collapsing both to
        // null.
        shippingWeightOz: touchesWeight ? shippingWeightOz : undefined,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update inventory";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
