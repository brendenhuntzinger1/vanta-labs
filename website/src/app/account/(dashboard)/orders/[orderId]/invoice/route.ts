import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerOrderDetail } from "@/lib/account-orders";
import { isUnpaid } from "@/lib/order-status";
import { displayOrderReference } from "@/lib/order-reference";

function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orderId } = await context.params;
  const order = await getCustomerOrderDetail(user.id, user.email, decodeURIComponent(orderId)).catch(() => null);
  if (!order) {
    return new Response("Order not found", { status: 404 });
  }
  // An unpaid order has no invoice — it's a receipt of payment.
  if (isUnpaid(order.paymentStatus)) {
    return new Response("This order has no invoice yet — payment hasn't been completed.", { status: 400 });
  }

  const c = order.currency;
  const shipTo = [order.customerName, order.shippingAddress, [order.city, order.state, order.postalCode].filter(Boolean).join(", "), order.country]
    .filter(Boolean)
    .map((l) => esc(String(l)))
    .join("<br/>");

  const rows = order.items
    .map(
      (item) => `<tr>
        <td>${esc(item.productName)}${item.variantLabel ? `<span class="muted"> · ${esc(item.variantLabel)}</span>` : ""}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${money(item.unitPrice, c)}</td>
        <td class="num">${money(item.lineTotal, c)}</td>
      </tr>`,
    )
    .join("");

  const totals = [
    `<tr><td>Subtotal</td><td class="num">${money(order.subtotal, c)}</td></tr>`,
    order.discountAmount > 0 ? `<tr><td>Discount</td><td class="num">−${money(order.discountAmount, c)}</td></tr>` : "",
    `<tr><td>Shipping</td><td class="num">${order.shippingAmount > 0 ? money(order.shippingAmount, c) : "Free"}</td></tr>`,
    order.handlingFee > 0 ? `<tr><td>Handling</td><td class="num">${money(order.handlingFee, c)}</td></tr>` : "",
    order.taxAmount > 0 ? `<tr><td>Tax</td><td class="num">${money(order.taxAmount, c)}</td></tr>` : "",
    `<tr class="total"><td>Total paid</td><td class="num">${money(order.amountPaid, c)}</td></tr>`,
    order.refundAmount > 0 ? `<tr><td>Refunded</td><td class="num">−${money(order.refundAmount, c)}</td></tr>` : "",
  ].join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Invoice ${esc(displayOrderReference(order.orderNumber, order.orderId))} — Vanta Labs</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; background: #f4f4f5; margin: 0; padding: 32px 16px; }
  .sheet { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px; box-shadow: 0 10px 40px rgba(0,0,0,.08); }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: .04em; }
  .muted { color: #71717a; }
  .eyebrow { text-transform: uppercase; letter-spacing: .16em; font-size: 11px; color: #71717a; }
  h1 { font-size: 15px; margin: 2px 0 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 28px 0; }
  table { width: 100%; border-collapse: collapse; }
  .items th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #71717a; border-bottom: 1px solid #e4e4e7; padding: 8px 0; }
  .items td { padding: 10px 0; border-bottom: 1px solid #f1f1f3; font-size: 14px; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; max-width: 280px; margin-top: 16px; }
  .totals td { padding: 6px 0; font-size: 14px; }
  .totals .total td { font-weight: 700; border-top: 2px solid #e4e4e7; padding-top: 10px; }
  .note { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e4e4e7; font-size: 12px; color: #71717a; line-height: 1.6; }
  .btn { display: inline-block; margin: 0 0 20px; padding: 10px 18px; background: #0a0a0a; color: #fff; border-radius: 999px; font-size: 13px; text-decoration: none; border: none; cursor: pointer; }
  @media print { body { background: #fff; padding: 0; } .sheet { box-shadow: none; border-radius: 0; } .btn { display: none; } }
</style></head>
<body>
  <div class="sheet">
    <button class="btn" onclick="window.print()">Print / Save as PDF</button>
    <div class="top">
      <div>
        <div class="brand">VANTA LABS</div>
        <div class="muted" style="font-size:12px;margin-top:4px;">vantalabsresearch.com</div>
      </div>
      <div style="text-align:right;">
        <div class="eyebrow">Invoice</div>
        <h1>${esc(displayOrderReference(order.orderNumber, order.orderId))}</h1>
        <div class="muted" style="font-size:12px;margin-top:4px;">${new Date(order.paidAt ?? order.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="eyebrow">Billed to</div>
        <div style="font-size:14px;margin-top:6px;">${esc(order.customerName ?? user.email ?? "Customer")}<br/><span class="muted">${esc(user.email ?? "")}</span></div>
      </div>
      <div>
        <div class="eyebrow">Ship to</div>
        <div style="font-size:14px;margin-top:6px;">${shipTo || '<span class="muted">—</span>'}</div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals"><tbody>${totals}</tbody></table>

    <div style="margin-top:24px;font-size:13px;">
      <span class="eyebrow">Payment method</span><br/>
      <span style="color:#3f3f46;">${esc(order.paymentMethod ?? "—")}</span>
    </div>

    <div class="note">
      All products are sold strictly for laboratory and research use only — not for human or animal consumption.
      Memberships and orders are subject to the Vanta Labs terms of service. Thank you for your order.
    </div>
  </div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
