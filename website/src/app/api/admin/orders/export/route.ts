import { NextResponse } from "next/server";
import { businessDayKey } from "@/lib/business-day";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings, canViewProfit } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getOrderProfitMap } from "@/lib/admin-profit";
import { readAllRowsBounded } from "@/lib/supabase-page";

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

  // Page through ALL orders so the export is complete at 100k+ orders.
  //
  // THIS USED TO HAND-ROLL THE PAGER THAT supabase-page.ts DELETED (F-A-9), and
  // it had both of the two ingredients that got the old `readAllRows` removed:
  // a FIXED STRIDE (`from = chunk * CHUNK`) and STOP-ON-SHORT-PAGE
  // (`if (batch.length < CHUNK) break;`). PostgREST's `max-rows` is a project
  // setting this code cannot observe; set anywhere below 1000 it makes every
  // page short, so the loop stopped on the first one and the whole orders table
  // exported as a single page — silently, as a valid CSV. The bounded pager
  // stops only on an EMPTY page and advances by the rows actually received.
  //
  // `created_at` alone is not a stable page key either: it is not unique, so
  // ties could repeat or skip a row across a page boundary. `order_id` breaks
  // them, the same tiebreak admin-reconciliation.ts adds for the same reason.
  let rows: Array<Record<string, unknown>>;
  let truncated: boolean;
  try {
    ({ rows, truncated } = await readAllRowsBounded<Record<string, unknown>>(
      (from, to) => supabaseAdmin
        .from("orders")
        .select("order_id, customer_email, customer_name, amount_paid, payment_status, fulfillment_status, tracking_number, referral_code, coupon_code, refund_amount, created_at")
        .order("created_at", { ascending: false })
        .order("order_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
      { maxRows: 500_000, label: "orders export" },
    ));
  } catch (error) {
    // The pager throws on a page error where the old loop returned; keep the
    // response the caller already handles.
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
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
  //                 + additional_revenue - credit_and_points_redeemed
  //                 + sales_tax_collected  <- ONLY when the store counts sales
  //                    tax as profit (profit / count_sales_tax_as_profit).
  //
  // THE TAX TERM IS CONDITIONAL AND THE CODED DEFAULT IS OFF (M-12). The
  // identity above used to be stated unconditionally, but order-profit.ts adds
  // the tax term only under `countTaxAsProfit`, and admin-control.ts ships
  // `countSalesTaxAsProfit: false` "BY OWNER'S DECISION" — so on a default
  // store the columns do NOT sum, tax is a pass-through, and a reader
  // reconciling a row would conclude the export was broken. Which branch was in
  // force is not derivable from the other columns either, so it is exported as
  // its own per-row boolean rather than left to be inferred.
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
    "tax_counted_as_profit",
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
            p.taxCountedAsProfit,
            p.profit,
            // `null` when there is no revenue to take a proportion of, which
            // csvEscape writes as an EMPTY CELL. Deliberate: a spreadsheet
            // column of margins must not carry a 0 that averages in as "broke
            // even" on orders that lost money. Covered by
            // margin-never-flatters-a-loss.test.ts.
            p.marginPercent,
            p.profitStatus,
          ].map((value) => csvEscape(value))
        : profitHeader.map(() => "");
      return [...base, ...profitCells].join(",");
    }),
    // A clipped export must not look like a complete one. `truncated` is
    // observed by the pager (it probes one row past the ceiling), so this line
    // appears only when orders were genuinely left behind.
    ...(truncated
      ? [csvEscape(`TRUNCATED: export stopped at ${rows.length} orders. Narrow the range and export again.`)]
      : []),
  ].join("\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=orders-export-${businessDayKey(new Date())}.csv`,
    },
  });
}