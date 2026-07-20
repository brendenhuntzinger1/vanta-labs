import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getPayoutDashboard } from "@/lib/admin-payouts";

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Payout report / invoice CSV — what's owed to the 3PL per order. Works even
// when the 3PL has no settlement API.
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Your role cannot export payouts." }, { status: 403 });
  }

  const { summary, rows } = await getPayoutDashboard();
  const header = [
    "Order Number", "Customer", "Payment Method", "Units", "Gross", "Shipping Collected",
    "Taxes/Fees Collected", "Processor Fees", "Net Revenue", "3PL Owed", "Profit", "Payout Status", "Date",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.order_number, r.customer_name ?? "", r.payment_method, r.units, r.gross, r.shippingCollected,
      r.taxesFeesCollected, r.processorFees, r.netRevenue, r.threeplOwed, r.profit, r.payoutStatus,
      new Date(r.created_at).toISOString().slice(0, 10),
    ].map(csvEscape).join(","));
  }
  lines.push("");
  lines.push([`Totals (${summary.orders} orders)`, "", "", "", summary.totalGross, "", "", "", summary.totalNetRevenue, summary.total3plOwed, summary.totalProfit, `Pending owed: ${summary.pendingPayoutTotal}`, ""].map(csvEscape).join(","));

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=3pl-payouts-${new Date().toISOString().slice(0, 10)}.csv`,
    },
  });
}
