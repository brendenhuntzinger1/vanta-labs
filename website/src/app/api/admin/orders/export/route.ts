import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings, canViewProfit } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getOrderProfitMap } from "@/lib/admin-profit";

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

  // Profit columns are internal — only for roles that can view profit. They come
  // from the shared profit engine so the export never disagrees with the admin
  // order/dashboard figures.
  const includeProfit = canViewProfit(session.role);

  // THE REVENUE COLUMNS HAVE TO DECOMPOSE. Since store credit and points became
  // contra-revenue, `gross_revenue` equals `amount_paid` on a redeeming order —
  // correct, but it means the export no longer shows that a redemption happened
  // at all, and no combination of the remaining columns adds up to it. The three
  // components (merchandise, other customer-paid fees, and the non-cash tender
  // deducted) are exported alongside it so a row can be reconciled by whoever
  // opens the file:
  //
  //   gross_revenue = merchandise_revenue + shipping_charged
  //                 + additional_revenue + sales_tax_collected
  //                 - credit_and_points_redeemed
  const profitHeader = [
    "gross_revenue",
    "merchandise_revenue",
    "additional_revenue",
    "credit_and_points_redeemed",
    "product_cost",
    "shipping_charged",
    "shipping_cost",
    "shipping_profit",
    "processor_fee",
    "ambassador_commission",
    "sales_tax_collected",
    "net_profit",
    "net_margin_percent",
    "profit_status",
  ];
  const profitByOrder = includeProfit
    ? await getOrderProfitMap(rows.map((row) => String(row.order_id)))
    : new Map();

  const fullHeader = includeProfit ? [...header, ...profitHeader] : header;

  const csv = [
    fullHeader.join(","),
    ...rows.map((row) => {
      const base = header.map((key) => csvEscape(row[key as keyof typeof row]));
      if (!includeProfit) return base.join(",");
      const p = profitByOrder.get(String(row.order_id));
      const profitCells = p
        ? [
            p.grossRevenue,
            p.merchandiseRevenue,
            p.additionalRevenue,
            p.creditRedeemed,
            p.cogs,
            p.shippingCharged,
            p.shippingCost,
            p.shippingProfit,
            p.processingFee,
            p.commission,
            p.taxCollected,
            p.profit,
            p.marginPercent,
            p.profitStatus,
          ].map((value) => csvEscape(value))
        : profitHeader.map(() => "");
      return [...base, ...profitCells].join(",");
    }),
  ].join("\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=orders-export-${new Date().toISOString().slice(0, 10)}.csv`,
    },
  });
}