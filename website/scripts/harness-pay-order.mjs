// Drive the REAL paid-order pipeline for a harness order.
//
// The mock gateway is unreachable on a production build (NODE_ENV is inlined as
// "production" at build time, and mock payments are hard-blocked there by
// design). So instead of weakening that control, this signs the same
// payment.succeeded event the mock gateway would have signed and POSTs it to
// the real /api/webhooks/payment route -- the identical code path a live
// processor callback takes: processPaymentWebhook -> signature verify ->
// mark paid -> inventory -> commission -> confirmation email -> fulfilment.
//
// Development-only. Reads the order straight out of the harness Postgres.
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import pg from "pg";

const orderId = process.argv[2];
const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";
const base = process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3000";
if (!orderId) {
  console.error("usage: node scripts/harness-pay-order.mjs <order_id>");
  process.exit(1);
}

const client = new pg.Client({
  connectionString:
    process.env.HARNESS_DB_URL ?? "postgres://postgres@localhost:55432/storefront",
});
await client.connect();

const { rows } = await client.query(
  `select order_id, payment_id, payment_status, customer_email, customer_name,
          shipping_address, city, postal_code, currency, subtotal, shipping_amount,
          discount_amount, amount_paid, referral_code, ambassador_id, coupon_code,
          customer_user_id, points_redeemed
     from orders where order_id = $1`,
  [orderId],
);
if (!rows.length) {
  console.error(`no such order: ${orderId}`);
  process.exit(1);
}
const o = rows[0];
const items = (
  await client.query(
    `select product_id, product_name, unit_price, quantity, line_total
       from order_items where order_id = $1`,
    [orderId],
  )
).rows;
await client.end();

const n = (v) => (v == null ? 0 : Number(v));
const s = (v) => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
};

const eventType = process.env.HARNESS_EVENT_TYPE ?? "payment.succeeded";
const body = JSON.stringify({
  orderId: o.order_id,
  type: eventType,
  paymentId: s(o.payment_id) ?? `harness_pay_${o.order_id}`,
  status: eventType,
  customer: {
    email: s(o.customer_email),
    fullName: s(o.customer_name),
    address: s(o.shipping_address),
    city: s(o.city),
    postalCode: s(o.postal_code),
  },
  amount: n(o.amount_paid),
  subtotal: n(o.subtotal),
  shippingAmount: n(o.shipping_amount),
  discountAmount: n(o.discount_amount),
  currency: s(o.currency) ?? "USD",
  referralCode: s(o.referral_code),
  ambassadorId: s(o.ambassador_id),
  couponCode: s(o.coupon_code),
  customerUserId: s(o.customer_user_id),
  pointsRedeemed: n(o.points_redeemed),
  items: items.map((i) => ({
    productId: s(i.product_id),
    productName: s(i.product_name),
    unitPrice: n(i.unit_price),
    quantity: n(i.quantity),
    lineTotal: n(i.line_total),
  })),
});

const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
const eventId = process.argv[3] ?? `harness_evt_${randomUUID()}`;

const res = await fetch(`${base}/api/webhooks/payment`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-payment-signature": signature,
    "x-event-id": eventId,
  },
  body,
});
console.log("HTTP", res.status, await res.text());
console.log("eventId:", eventId);
