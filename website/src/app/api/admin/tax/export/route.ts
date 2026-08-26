import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canViewProfit } from "@/lib/admin-roles";
import { getSalesTaxReport } from "@/lib/admin-tax-report";
import { csvSafeCell } from "@/lib/csv-safe";

// Sales-tax export for filing: a per-state summary (what you remit to each
// state) followed by the per-order detail backing it. ?year=2026 restricts to
// a calendar year; omit for all time.
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canViewProfit(session.role)) {
    return NextResponse.json({ success: false, error: "Your role cannot export tax data." }, { status: 403 });
  }

  const url = new URL(request.url);
  const yearRaw = Number(url.searchParams.get("year"));
  const year = Number.isInteger(yearRaw) && yearRaw >= 2020 && yearRaw <= 2100 ? yearRaw : undefined;

  const report = await getSalesTaxReport({ year });

  const lines: string[] = [];
  lines.push("SALES TAX BY STATE" + (year ? ` — ${year}` : " — all time"));
  lines.push(["State", "Orders", "Taxable Sales", "Tax Collected", "Tax Refunded", "Net Tax Due"].join(","));
  for (const s of report.byState) {
    lines.push([s.state, s.orders, s.taxableSales.toFixed(2), s.taxCollected.toFixed(2), s.taxRefunded.toFixed(2), s.netTax.toFixed(2)].map(csvSafeCell).join(","));
  }
  lines.push(["TOTAL", report.totals.orders, "", report.totals.taxCollected.toFixed(2), report.totals.taxRefunded.toFixed(2), report.totals.netTax.toFixed(2)].map(csvSafeCell).join(","));

  lines.push("");
  lines.push("ORDER DETAIL");
  lines.push(["Order Number", "Date", "State", "Rate %", "Taxable Sales", "Tax Collected", "Payment Status"].join(","));
  for (const r of report.rows) {
    lines.push([
      r.orderNumber,
      r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "",
      r.state,
      r.ratePercent,
      r.taxableSales.toFixed(2),
      r.taxCollected.toFixed(2),
      r.paymentStatus,
    ].map(csvSafeCell).join(","));
  }

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=sales-tax-${year ?? "all"}-${new Date().toISOString().slice(0, 10)}.csv`,
    },
  });
}
