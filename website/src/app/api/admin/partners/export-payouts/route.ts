import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getAdminPartnerRows } from "@/lib/partner-portal";

function escapeCsv(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "admin") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await getAdminPartnerRows({ status: "all" });
    const headers = [
      "Partner Name",
      "Email",
      "Referral Code",
      "Status",
      "Commission %",
      "Total Revenue",
      "Total Orders",
      "Pending Commissions",
      "Paid Commissions",
      "Clicks",
      "Conversion Rate %",
    ];

    const lines = [headers.join(",")];

    for (const row of rows) {
      lines.push([
        escapeCsv(row.name),
        escapeCsv(row.email ?? ""),
        escapeCsv(row.referralCode),
        escapeCsv(row.status),
        row.commissionPercent.toFixed(2),
        row.totalRevenue.toFixed(2),
        String(row.totalOrders),
        row.pendingCommissions.toFixed(2),
        row.paidCommissions.toFixed(2),
        String(row.clicks),
        row.conversionRate.toFixed(2),
      ].join(","));
    }

    return new NextResponse(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="partner-payouts-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export payouts";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
