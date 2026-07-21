import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getPayoutHistory } from "@/lib/admin-ambassadors";

function escapeCsv(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

// Exports the actual payout LOG (each Mark-as-Paid event: date, amount, notes,
// ambassador) - distinct from export-payouts, which exports the per-ambassador
// balance summary. Supports optional from/to date range and ambassadorId.
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const ambassadorId = url.searchParams.get("ambassadorId");

    const fromTime = from ? new Date(from).getTime() : null;
    // Include the whole "to" day by pushing to end-of-day.
    const toTime = to ? new Date(to).getTime() + 24 * 60 * 60 * 1000 - 1 : null;

    let rows = await getPayoutHistory(1000);
    rows = rows.filter((row) => {
      if (ambassadorId && row.ambassadorId !== ambassadorId) return false;
      const time = new Date(row.createdAt).getTime();
      if (fromTime !== null && !Number.isNaN(fromTime) && time < fromTime) return false;
      if (toTime !== null && !Number.isNaN(toTime) && time > toTime) return false;
      return true;
    });

    const headers = ["Date Paid", "Ambassador", "Amount", "Notes"];
    const lines = [headers.join(",")];

    for (const row of rows) {
      lines.push([
        escapeCsv(new Date(row.createdAt).toISOString().slice(0, 10)),
        escapeCsv(row.ambassadorName),
        row.amount.toFixed(2),
        escapeCsv(row.note ?? ""),
      ].join(","));
    }

    return new NextResponse(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="payout-history-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export payout history";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
