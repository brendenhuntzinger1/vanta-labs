import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { getInventoryRows } from "@/lib/admin-inventory";
import { getInventoryHistory, toCsv } from "@/lib/inventory-ledger";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// CSV export: current stock, or the transaction history.
//
// Admin-gated to the same role that may CHANGE inventory. That is deliberate
// rather than lazy: these files expose per-SKU stock levels and movement over
// time, which is purchasing volume and sell-through -- competitive information,
// not an operational detail.
//
// Values are quoted and formula-guarded in csvCell(). A product name or an
// operator's reason beginning with =, + or @ executes as a formula when the
// file is opened in Excel or Sheets, and both fields are free text.
// ---------------------------------------------------------------------------

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function csvResponse(body: string, filename: string) {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Stock levels change constantly; a cached export is a wrong export.
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageInventory(session.role)) {
    return NextResponse.json(
      { success: false, error: "Your role does not have permission to export inventory." },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get("type") === "history" ? "history" : "levels";
  // Date only: these are filed and compared by day, and a colon in a filename
  // is awkward on Windows.
  const stamp = new Date().toISOString().slice(0, 10);

  if (kind === "history") {
    const limitParam = Number(url.searchParams.get("limit") ?? 1000);
    const history = await getInventoryHistory({
      limit: Number.isFinite(limitParam) ? limitParam : 1000,
      productId: url.searchParams.get("productId") ?? undefined,
    });

    const csv = toCsv(
      ["Date", "Product", "SKU", "Variant ID", "Type", "Change", "Before", "After", "Reason", "By", "Order"],
      history.map((row) => [
        row.createdAt,
        row.productName ?? row.productId,
        row.sku ?? "",
        row.doseId ?? "",
        row.typeLabel,
        // Explicit sign: "-3" reads unambiguously as a removal in a spreadsheet,
        // where a bare 3 in a "Change" column does not.
        row.delta > 0 ? `+${row.delta}` : String(row.delta),
        row.quantityBefore ?? "",
        row.quantityAfter ?? "",
        row.reason ?? "",
        row.actor ?? "system",
        row.orderId ?? "",
      ]),
    );
    return csvResponse(csv, `vanta-inventory-history-${stamp}.csv`);
  }

  const rows = await getInventoryRows().catch(() => []);
  const csv = toCsv(
    [
      "Product",
      "Variant",
      "SKU",
      "Quantity",
      "Low-stock threshold",
      "Status",
      "Unit weight (oz)",
      "Weight source",
    ],
    rows.map((row) => [
      row.productName,
      row.variantLabel ?? "",
      row.sku ?? "",
      row.inventoryQuantity,
      row.lowStockThreshold,
      row.isOutOfStock ? "Out of stock" : row.isLowStock ? "Low stock" : "In stock",
      row.effectiveShippingWeightOz,
      // Which number a label would actually use, and where it came from —
      // "not weighed yet" is the actionable state this column exists to surface.
      row.shippingWeightSource === "line"
        ? "Weighed"
        : row.shippingWeightSource === "inherited"
          ? "From product"
          : "Catalog default",
    ]),
  );
  return csvResponse(csv, `vanta-inventory-${stamp}.csv`);
}
