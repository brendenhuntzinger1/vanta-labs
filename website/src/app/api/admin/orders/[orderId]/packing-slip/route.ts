import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getBusinessSettings } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Renders a printable packing slip for an order as a self-contained HTML
// document. The admin "Print packing slip" button opens this in a new tab and
// the browser's own print dialog handles the rest — no PDF dependency, and it
// prints cleanly (an @media print block hides everything but the slip).
export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orderId } = await context.params;

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select(
      "order_id, order_number, customer_name, customer_email, shipping_address, city, state, postal_code, country, phone, created_at, tracking_number, carrier, order_items(product_name, product_id, quantity, unit_price, line_total)",
    )
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    return new Response("Unable to load order", { status: 500 });
  }

  if (!order) {
    return new Response("Order not found", { status: 404 });
  }

  let storeName = "Vanta Labs";
  try {
    const business = await getBusinessSettings();
    if (business?.businessName) {
      storeName = String(business.businessName);
    }
  } catch {
    // Fall back to the default store name.
  }

  const orderNumber = String(order.order_number ?? order.order_id);
  const items = (order.order_items ?? []) as Array<{
    product_name?: string | null;
    product_id?: string | null;
    quantity?: number | null;
    unit_price?: number | null;
    line_total?: number | null;
  }>;

  const addressLines = [
    esc(order.customer_name),
    esc(order.shipping_address),
    [order.city, order.state, order.postal_code].filter(Boolean).map(esc).join(", "),
    esc(order.country),
    order.phone ? esc(order.phone) : "",
  ].filter(Boolean);

  const rows = items
    .map(
      (item) => `
      <tr>
        <td>${esc(item.product_name ?? item.product_id ?? "Item")}</td>
        <td class="num">${Number(item.quantity ?? 0)}</td>
        <td class="num">${money(Number(item.unit_price ?? 0))}</td>
        <td class="num">${money(Number(item.line_total ?? 0))}</td>
      </tr>`,
    )
    .join("");

  const totalUnits = items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
  const createdAt = order.created_at ? new Date(String(order.created_at)).toLocaleString("en-US") : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Packing slip · ${esc(orderNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 32px; }
  .slip { max-width: 720px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 16px; }
  .store { font-size: 20px; font-weight: 700; }
  .muted { color: #666; font-size: 12px; }
  h1 { font-size: 16px; margin: 24px 0 4px; text-transform: uppercase; letter-spacing: 0.08em; }
  .addr { line-height: 1.5; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; }
  th.num, td.num { text-align: right; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; }
  .toolbar { max-width: 720px; margin: 0 auto 20px; }
  .toolbar button { font-size: 13px; padding: 8px 16px; cursor: pointer; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print this packing slip</button></div>
  <div class="slip">
    <div class="head">
      <div>
        <div class="store">${esc(storeName)}</div>
        <div class="muted">Packing slip</div>
      </div>
      <div style="text-align:right">
        <div><strong>Order ${esc(orderNumber)}</strong></div>
        <div class="muted">${esc(createdAt)}</div>
        ${order.tracking_number ? `<div class="muted">${esc(order.carrier ?? "Tracking")}: ${esc(order.tracking_number)}</div>` : ""}
      </div>
    </div>

    <h1>Ship to</h1>
    <div class="addr">${addressLines.join("<br />")}</div>

    <h1>Items</h1>
    <table>
      <thead>
        <tr><th>Product</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Line total</th></tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">No items on record.</td></tr>`}</tbody>
      <tfoot>
        <tr><td>Total units</td><td class="num">${totalUnits}</td><td></td><td></td></tr>
      </tfoot>
    </table>

    <p class="muted" style="margin-top:32px">Thank you — ${esc(storeName)}</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
