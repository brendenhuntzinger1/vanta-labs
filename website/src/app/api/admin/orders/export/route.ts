import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, customer_email, customer_name, amount_paid, payment_status, fulfillment_status, tracking_number, referral_code, coupon_code, refund_amount, created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  const rows = data ?? [];
  const header = [
    "order_id",
    "customer_email",
    "customer_name",
    "amount_paid",
    "payment_status",
    "fulfillment_status",
    "tracking_number",
    "referral_code",
    "coupon_code",
    "refund_amount",
    "created_at",
  ];

  const csv = [
    header.join(","),
    ...rows.map((row) => header.map((key) => csvEscape(row[key as keyof typeof row])).join(",")),
  ].join("\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=orders-export-${new Date().toISOString().slice(0, 10)}.csv`,
    },
  });
}