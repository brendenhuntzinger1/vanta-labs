import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";

function csvEscape(value: unknown) {
  let text = String(value ?? "");
  // Neutralize spreadsheet formula injection: a leading = + - @ (or tab/CR) in
  // an attacker-controlled cell (customer name/email) would execute as a formula
  // when the owner opens the export in Excel/Sheets. Prefix a single quote.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
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
  if (!canManageSettings(session.role)) {
    return NextResponse.json({ success: false, error: "Your role cannot export order data." }, { status: 403 });
  }

  // Page through ALL orders in chunks instead of a single 5000-row cap, so the
  // export is complete at 100k+ orders. Bounded by a hard page cap as a
  // runaway backstop.
  const CHUNK = 1000;
  const MAX_CHUNKS = 500; // 500k-order backstop
  const rows: Array<Record<string, unknown>> = [];
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const from = chunk * CHUNK;
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, customer_name, amount_paid, payment_status, fulfillment_status, tracking_number, referral_code, coupon_code, refund_amount, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + CHUNK - 1);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < CHUNK) break;
  }
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