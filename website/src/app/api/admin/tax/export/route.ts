import { NextResponse } from "next/server";
import { businessDayKey } from "@/lib/business-day";
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
  // A FILING EXPORT THAT IS SHORT MUST SAY SO, IN THE FILE.
  //
  // getSalesTaxReport has always computed `truncated` and no caller has ever
  // read it. This CSV is what the owner opens to work out what they owe each
  // state; a silently partial one understates a tax liability and looks exactly
  // like a complete one. The warning goes FIRST, so it cannot be scrolled past,
  // and the totals row is relabelled below.
  if (report.truncated) {
    lines.push("WARNING: INCOMPLETE REPORT — DO NOT FILE FROM THIS FILE AS-IS.");
    lines.push("The read stopped at its row ceiling before every taxed order had been seen.");
    lines.push("Every figure below is a FLOOR: the tax actually owed is higher. Re-run per year (?year=YYYY) to narrow it.");
    lines.push("");
  }
  lines.push("SALES TAX BY STATE" + (year ? ` — ${year}` : " — all time"));
  lines.push(["State", "Orders", "Taxable Sales", "Tax Collected", "Tax Refunded", "Net Tax Due"].join(","));
  for (const s of report.byState) {
    lines.push([s.state, s.orders, s.taxableSales.toFixed(2), s.taxCollected.toFixed(2), s.taxRefunded.toFixed(2), s.netTax.toFixed(2)].map(csvSafeCell).join(","));
  }
  lines.push([report.truncated ? "TOTAL (PARTIAL — INCOMPLETE READ)" : "TOTAL", report.totals.orders, "", report.totals.taxCollected.toFixed(2), report.totals.taxRefunded.toFixed(2), report.totals.netTax.toFixed(2)].map(csvSafeCell).join(","));

  lines.push("");
  lines.push("ORDER DETAIL");
  lines.push(["Order Number", "Date", "State", "Rate %", "Taxable Sales", "Tax Collected", "Payment Status"].join(","));
  for (const r of report.rows) {
    lines.push([
      r.orderNumber,
      r.createdAt ? businessDayKey(new Date(r.createdAt)) : "",
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
      // The filename carries the warning too: a file saved to disk, mailed to an
      // accountant and opened next week has lost every banner but its name.
      "Content-Disposition": `attachment; filename=sales-tax-${year ?? "all"}-${businessDayKey(new Date())}${report.truncated ? "-INCOMPLETE" : ""}.csv`,
    },
  });
}
