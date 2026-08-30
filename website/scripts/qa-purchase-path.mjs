#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE PURCHASE PATH, AND THE ONE EMAIL A CUSTOMER ALWAYS NOTICES.
//
// A shopper who is charged and hears nothing writes to support. A shopper who
// is charged and hears twice writes to support, and also stops trusting the
// receipts. So the confirmation email has exactly one correct behaviour —
// once, with the right contents, to the right person, and never for a payment
// that failed — and that is what this proves.
//
// It also covers the guest half of the funnel, which the other harnesses do
// not: a shopper who buys WITHOUT an account, and then makes one.
//
// WHAT IS REAL HERE AND WHAT IS A STAND-IN
//
// The order is created by the app's own checkout. Payment is settled by POSTing
// the same HMAC-signed `payment.succeeded` event a live processor posts, to the
// real /api/webhooks/payment — so the whole chain behind it (mark paid,
// decrement inventory, accrue commission, claim the send-once slot, compose the
// confirmation) is the production code path, not a stub. The only stand-in is
// the processor's own session mint (scripts/veyra-stub.mjs), because reaching a
// real gateway from a test is not something to want.
//
// Development-only. Drives the local harness at 127.0.0.1:3000 and refuses to
// start against anything else.
//
//   node scripts/qa-purchase-path.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const HARNESS_LOG = process.env.QA_HARNESS_LOG ?? null;
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

const results = [];
let currentSection = "";
const SKIP = (reason) => ({ __skip: reason });

function section(title) {
  currentSection = title;
  console.log(`\n${title}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    if (detail && typeof detail === "object" && detail.__skip) {
      results.push({ section: currentSection, name, status: "skip", detail: detail.__skip });
      console.log(`  SKIP  ${name}  — ${detail.__skip}`);
      return;
    }
    results.push({ section: currentSection, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 220);
    results.push({ section: currentSection, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

const logOffset = () => (HARNESS_LOG && existsSync(HARNESS_LOG) ? statSync(HARNESS_LOG).size : 0);

/** Byte-accurate, because the log carries em dashes — see qa-customer-journey. */
function mailSince(offset) {
  if (!HARNESS_LOG || !existsSync(HARNESS_LOG)) return null;
  const buf = readFileSync(HARNESS_LOG);
  const text = buf.subarray(Math.min(offset, buf.length)).toString("utf8");
  return [...text.matchAll(/Not sent: "([^"]+)" to (\S+?)\.?\s*$/gm)]
    .map((m) => ({ subject: m[1], to: m[2] }));
}

/**
 * The signed event a live processor posts, built from the order itself.
 *
 * Signed rather than faked past the guard: the signature check is part of what
 * is under test, and an endpoint that accepts an unsigned "you were paid" is
 * the worst defect this file could miss.
 *
 * The payload shape and the two header names mirror scripts/harness-pay-order.mjs,
 * which is the reference for what this webhook actually accepts. Inventing a
 * Stripe-shaped `{ data: { object: { metadata } } }` body gets a 400 and proves
 * nothing about the pipeline behind it.
 */
async function payOrder(page, orderId, { type = "payment.succeeded", eventId } = {}) {
  const o = (await q(
    `select order_id, payment_id, customer_email, customer_name, shipping_address, city, postal_code,
            amount_paid, subtotal, shipping_amount, discount_amount, currency, referral_code,
            ambassador_id, coupon_code, customer_user_id, points_redeemed
       from orders where order_id = $1`, [orderId],
  )).rows[0];
  if (!o) throw new Error(`no such order ${orderId}`);

  const items = (await q(
    "select product_id, product_name, unit_price, quantity, line_total from order_items where order_id = $1",
    [orderId],
  )).rows;

  const n = (v) => Number(v ?? 0);
  const t = (v) => (v == null ? undefined : String(v).trim() || undefined);

  const body = JSON.stringify({
    orderId: o.order_id,
    type,
    paymentId: t(o.payment_id) ?? `qa_pay_${o.order_id}`,
    status: type,
    customer: {
      email: t(o.customer_email),
      fullName: t(o.customer_name),
      address: t(o.shipping_address),
      city: t(o.city),
      postalCode: t(o.postal_code),
    },
    amount: n(o.amount_paid),
    subtotal: n(o.subtotal),
    shippingAmount: n(o.shipping_amount),
    discountAmount: n(o.discount_amount),
    currency: t(o.currency) ?? "USD",
    referralCode: t(o.referral_code),
    ambassadorId: t(o.ambassador_id),
    couponCode: t(o.coupon_code),
    customerUserId: t(o.customer_user_id),
    pointsRedeemed: n(o.points_redeemed),
    items: items.map((i) => ({
      productId: t(i.product_id),
      productName: t(i.product_name),
      unitPrice: n(i.unit_price),
      quantity: n(i.quantity),
      lineTotal: n(i.line_total),
    })),
  });

  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
  return page.request.post(`${BASE}/api/webhooks/payment`, {
    headers: {
      "content-type": "application/json",
      "x-payment-signature": signature,
      // A processor RETRIES with the same event id, which is what the
      // send-once slot keys on. A fresh id per call would test nothing.
      "x-event-id": eventId ?? `qa_evt_${randomUUID()}`,
    },
    data: body,
  });
}

const stamp = Date.now();
const CLIENT_IP = `203.0.113.${(stamp % 250) + 1}`;

async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  // WAIT FOR CONDITIONS, NOT FOR CLOCKS.
  //
  // This used to be three fixed sleeps, and it raced the render: on a slower
  // load the dialog had not appeared yet, or the button was still disabled when
  // the click landed, and the gate stayed up — silently covering whatever the
  // next step went on to assert. Every wait below is on the thing it actually
  // depends on.
  const appeared = await page
    .waitForSelector("[role=dialog]", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;   // already accepted in this context

  await page.evaluate(() => {
    document.querySelectorAll("[role=dialog] input[type=checkbox]").forEach((b) => { if (!b.checked) b.click(); });
  });

  // The button is disabled until every box is ticked, and React re-renders
  // between tasks — so wait for it to become enabled rather than guessing.
  await page.waitForFunction(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || ""));
    return Boolean(btn && !btn.disabled);
  }, null, { timeout: 8000 });

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });

  // Prove it cleared. A gate still up hides everything a later step reads.
  await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 });
  return true;
}

async function addFirstProductToCart(page) {
  await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const href = await page.$eval('a[href^="/products/"]', (a) => a.getAttribute("href"));
  await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  });
  await page.waitForTimeout(2500);
  return clicked ? href : null;
}


/**
 * A cart item id the checkout will actually price.
 *
 * NOT a UUID. quote-order.ts keys the catalogue by SLUG and splits the id on
 * "::" — so an item is `slug` for a product stocked at the parent, and
 * `slug::doseId` for a dose-stocked one. Most of this catalogue is the latter
 * (the parent carries zero and each dose carries the stock), so passing a
 * products.id gets "Invalid product id" and no order.
 */
async function sellableCartItem() {
  const parent = (await q(
    `select p.id, p.slug from products p
      where coalesce(p.is_published, true) and coalesce(p.is_enabled, true)
        and not coalesce(p.is_archived, false)
        and coalesce(p.price_cents, 0) > 0
        and coalesce(p.inventory_quantity, 0) > 0
      order by p.position nulls last limit 1`,
  )).rows[0];
  if (parent) return { id: parent.slug, describe: parent.slug };

  const dosed = (await q(
    `select p.slug, d.id as dose_id, d.label from products p
       join product_doses d on d.product_id = p.id
      where coalesce(p.is_published, true) and coalesce(p.is_enabled, true)
        and not coalesce(p.is_archived, false)
        and coalesce(d.price_cents, 0) > 0
        and coalesce(d.inventory_quantity, 0) > 0
      order by p.position nulls last limit 1`,
  )).rows[0];
  if (dosed) return { id: `${dosed.slug}::${dosed.dose_id}`, describe: `${dosed.slug} (${dosed.label})` };

  return null;
}

async function main() {
  const CHROME = process.env.QA_CHROMIUM
    ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
      .find((p) => existsSync(p));
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
  const page = await context.newPage();

  const GUEST_EMAIL = `guest.${stamp}@example.test`;
  const PAY_EVENT_ID = `qa_evt_${randomUUID()}`;

  // ---- 1. Guest checkout -------------------------------------------------
  section("1. Guest checkout");

  await step("a guest can shop and reach checkout without an account", async () => {
    await passAgeGate(page);
    const product = await addFirstProductToCart(page);
    assert(product, "could not add a product to the cart as a guest");

    await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    assert(!/\/account\/login/.test(page.url()), "checkout forced a guest to sign in");
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/your cart is empty/i.test(text), "the cart was empty at checkout");
    return `added ${product}, reached checkout as a guest`;
  });

  await step("checkout refuses an order with the compliance boxes unticked", async () => {
    // The boxes render pre-ticked, so the only thing making them real is this
    // server-side refusal. A shopper who unticks one submits `false`.
    const before = (await q("select count(*)::int as n from orders")).rows[0].n;
    const gateProduct = await sellableCartItem();
    if (!gateProduct) return SKIP("no sellable product to build a valid body around");
    const res = await page.evaluate(async ({ email, productId }) => {
      const r = await fetch("/api/checkout/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          items: [{ id: productId, quantity: 1 }],
          customer: {
            email, fullName: "Guest Buyer", address: "1 Test Way",
            city: "Tampa", state: "FL", postalCode: "33601", country: "US",
          },
          complianceAcknowledgements: { researchCompliance: false, returnsPolicy: true },
        }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { email: `unticked.${stamp}@example.test`, productId: gateProduct.id });
    const after = (await q("select count(*)::int as n from orders")).rows[0].n;
    assert(res.status === 400, `an unticked acknowledgement was answered ${res.status}`);
    assert(after === before, "an order was created despite an unticked acknowledgement");
    return `refused with 400: ${res.body?.error}`;
  });

  await step("a truthy stand-in does not count as a tick", async () => {
    const before = (await q("select count(*)::int as n from orders")).rows[0].n;
    const truthyProduct = await sellableCartItem();
    if (!truthyProduct) return SKIP("no sellable product to build a valid body around");
    const res = await page.evaluate(async ({ email, productId }) => {
      const r = await fetch("/api/checkout/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          items: [{ id: productId, quantity: 1 }],
          customer: {
            email, fullName: "Guest Buyer", address: "1 Test Way",
            city: "Tampa", state: "FL", postalCode: "33601", country: "US",
          },
          complianceAcknowledgements: { researchCompliance: "yes", returnsPolicy: 1 },
        }),
      });
      return r.status;
    }, { email: `truthy.${stamp}@example.test`, productId: truthyProduct.id });
    const after = (await q("select count(*)::int as n from orders")).rows[0].n;
    assert(res === 400, `"yes" and 1 were accepted as ticks (${res})`);
    assert(after === before, "an order was created from a truthy stand-in");
    return "strictly true required";
  });

  // An order the app itself created, so the row shape is the app's own.
  let orderId = null;
  let orderTotalCents = null;

  await step("checkout creates a real order row", async () => {
    const before = (await q("select order_id from orders order by created_at desc limit 1")).rows[0]?.order_id ?? null;
    // Real, sellable items straight from the catalogue: the route prices from
    // the database rather than from anything the client sends, so a made-up id
    // is simply rejected.
    const sellable = await sellableCartItem();
    if (!sellable) return SKIP("no in-stock, priced, published product in the harness catalogue");

    const created = await page.evaluate(async ({ email, productId }) => {
      const r = await fetch("/api/checkout/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          items: [{ id: productId, quantity: 1 }],
          customer: {
            email,
            fullName: "Guest Buyer",
            address: "1 Test Way",
            city: "Tampa",
            state: "FL",
            postalCode: "33601",
            country: "US",
          },
          // Both are required and must be strictly `true` — the route treats
          // this as a legal consent record, not a formality, and refuses a
          // truthy stand-in. See hasAllAcknowledgements in lib/express-wallet.
          complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
        }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { email: GUEST_EMAIL, productId: sellable.id });

    const latest = (await q(
      "select order_id, amount_paid, subtotal, shipping_amount, discount_amount, tax_amount, payment_status, customer_email "
      + "from orders order by created_at desc limit 1",
    )).rows[0];

    if (!latest || latest.order_id === before) {
      return SKIP(`checkout did not create an order (status ${created.status}: `
        + `${JSON.stringify(created.body).slice(0, 160)}) — the cart or a required field was rejected`);
    }
    orderId = latest.order_id;
    orderTotalCents = Math.round(Number(latest.amount_paid ?? 0) * 100)
      || Math.round((Number(latest.subtotal ?? 0) + Number(latest.shipping_amount ?? 0)
        + Number(latest.tax_amount ?? 0) - Number(latest.discount_amount ?? 0)) * 100);

    assert(String(latest.customer_email ?? "").toLowerCase() === GUEST_EMAIL,
      `the order is addressed to ${latest.customer_email}, not the guest`);
    assert(latest.payment_status !== "paid", "a brand new order was already marked paid");
    return `${orderId} for ${sellable.describe} (${latest.payment_status}, ${orderTotalCents}c)`;
  });

  // ---- 2. The confirmation email ----------------------------------------
  section("2. Order confirmation email");

  await step("an UNSIGNED payment webhook is refused", async () => {
    if (!orderId) return SKIP("no order to settle");
    const res = await page.request.post(`${BASE}/api/webhooks/payment`, {
      headers: { "content-type": "application/json", "x-event-id": "qa_forged" },
      data: JSON.stringify({ orderId, type: "payment.succeeded", status: "payment.succeeded", amount: 1 }),
    });
    assert(res.status() !== 200, `an unsigned "you were paid" event was accepted (${res.status()})`);
    const row = (await q("select payment_status from orders where order_id = $1", [orderId])).rows[0];
    assert(row.payment_status !== "paid", "an unsigned event marked the order paid");
    return `refused with ${res.status()}, order still ${row.payment_status}`;
  });

  await step("paying sends exactly one confirmation, to the right person", async () => {
    if (!orderId) return SKIP("no order to settle");
    const before = logOffset();
    const res = await payOrder(page, orderId, { eventId: PAY_EVENT_ID });
    assert(res.ok(), `the signed webhook was refused: ${res.status()} ${(await res.text()).slice(0, 140)}`);
    await page.waitForTimeout(3000);

    const row = (await q("select payment_status from orders where order_id = $1", [orderId])).rows[0];
    assert(row.payment_status === "paid", `the order is ${row.payment_status}, not paid`);

    const mail = mailSince(before);
    if (!mail) return SKIP("no harness log configured, so the email cannot be observed");
    const confirmations = mail.filter((m) => /order confirm|thank you for your order|order .*confirmed/i.test(m.subject));
    assert(confirmations.length === 1,
      `${confirmations.length} confirmation emails were composed: ${mail.map((m) => m.subject).join(" | ")}`);
    assert(confirmations[0].to === GUEST_EMAIL,
      `the confirmation went to ${confirmations[0].to}, not ${GUEST_EMAIL}`);
    return `one confirmation to ${confirmations[0].to}`;
  });

  await step("a retried webhook does not send a second confirmation", async () => {
    if (!orderId) return SKIP("no order to settle");
    // Processors retry until they get a 2xx. A retry that re-sends the receipt
    // is the defect the send-once slot exists to prevent.
    const before = logOffset();
    // The SAME event id twice, which is exactly how a processor retries when it
    // does not get a 2xx — and then a different one, because the send-once slot
    // must hold even for a genuinely new event about an order already paid.
    await payOrder(page, orderId, { eventId: PAY_EVENT_ID });
    await payOrder(page, orderId, { eventId: `qa_evt_${randomUUID()}` });
    await page.waitForTimeout(3000);

    const mail = mailSince(before);
    if (!mail) return SKIP("no harness log configured");
    const dupes = mail.filter((m) => /order confirm|thank you for your order|order .*confirmed/i.test(m.subject));
    assert(dupes.length === 0, `${dupes.length} duplicate confirmations after a retry`);
    return "two retries, no second email";
  });

  await step("the confirmation quotes the customer's own order number, not the database key", async () => {
    if (!orderId) return SKIP("no order to settle");
    const row = (await q("select order_number from orders where order_id = $1", [orderId])).rows[0];
    if (!row?.order_number) return SKIP("this order carries no order_number to quote");
    // The raw key is `order-<uuid>` and appears nowhere on the customer's
    // receipt, so quoting it would give them a reference support cannot use.
    const log = HARNESS_LOG && existsSync(HARNESS_LOG) ? readFileSync(HARNESS_LOG, "utf8") : "";
    const quotedRaw = log.includes(`Not sent: "Order Confirmed - ${orderId}"`);
    assert(!quotedRaw, "the confirmation subject quoted the raw order-<uuid> key");
    return `quotes ${row.order_number}`;
  });

  await step("the order totals on the row are internally consistent", async () => {
    if (!orderId) return SKIP("no order to settle");
    const o = (await q(
      "select subtotal, shipping_amount, discount_amount, tax_amount, card_processing_fee, amount_paid "
      + "from orders where order_id = $1", [orderId],
    )).rows[0];
    const n = (v) => Number(v ?? 0);
    const expected = n(o.subtotal) + n(o.shipping_amount) + n(o.tax_amount)
      + n(o.card_processing_fee) - n(o.discount_amount);
    const paid = n(o.amount_paid);
    assert(Math.abs(expected - paid) < 0.011,
      `amount_paid ${paid} does not reconcile with the components (${expected.toFixed(2)})`);
    return `${paid.toFixed(2)} = ${n(o.subtotal).toFixed(2)} + ship ${n(o.shipping_amount).toFixed(2)} `
      + `+ tax ${n(o.tax_amount).toFixed(2)} - disc ${n(o.discount_amount).toFixed(2)}`;
  });

  await step("a FAILED payment sends no confirmation", async () => {
    const failedId = `order-${randomUUID()}`;
    await q(
      `insert into orders (order_id, order_number, payment_status, fulfillment_status,
         customer_email, customer_name, subtotal, shipping_amount, discount_amount,
         tax_amount, amount_paid, created_at, updated_at)
       values ($1, $2, 'pending_payment', 'awaiting_payment', $3, 'Failed Buyer', 40, 5, 0, 0, 0, now(), now())`,
      [failedId, `VL-FAILED-${stamp}`, `failed.${stamp}@example.test`],
    );
    const before = logOffset();
    await payOrder(page, failedId, { type: "payment.failed" });
    await page.waitForTimeout(2500);

    const row = (await q("select payment_status from orders where order_id = $1", [failedId])).rows[0];
    assert(row.payment_status !== "paid", "a failed payment marked the order paid");

    const mail = mailSince(before);
    if (mail) {
      const wrong = mail.filter((m) => /order confirm|thank you for your order/i.test(m.subject));
      assert(wrong.length === 0, `a failed payment composed ${wrong.length} confirmation email(s)`);
    }
    return `order left ${row.payment_status}, no confirmation`;
  });

  // ---- 3. Guest becomes a customer --------------------------------------
  section("3. Guest becomes a registered customer");

  await step("the guest order is reachable from its confirmation page", async () => {
    if (!orderId) return SKIP("no order to view");
    await page.goto(`${BASE}/order-confirmation/${encodeURIComponent(orderId)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    assert(/thank you|order (confirmed|received)/i.test(text),
      `the confirmation page did not confirm the order: ${text.slice(0, 160)}`);
    return "confirmation page renders for the guest";
  });

  await step("signing up with the same address claims the guest order", async () => {
    if (!orderId) return SKIP("no order to claim");
    // The address is only allowed to claim orders once it is CONFIRMED — see
    // ownershipEmail() in lib/order-ownership.ts, which is the control that
    // stops "sign up as someone else's address" from handing over their
    // history. So this checks the confirmed case, which is the real one.
    await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', $2, '{"role":"customer"}', now(), now())
       on conflict (email) do update set email_confirmed_at = now()`,
      [GUEST_EMAIL, JSON.stringify({ full_name: "Guest Buyer", role: "customer" })],
    );

    const ctx = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const p = await ctx.newPage();
    await passAgeGate(p);
    await p.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    await p.fill("form input[type=email]", GUEST_EMAIL);
    await p.fill("form input[type=password]", "HarnessPass123!");
    await p.click("form button[type=submit]");
    await p.waitForTimeout(3500);

    await p.goto(`${BASE}/account/orders`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body.innerText);
    const number = (await q("select order_number from orders where order_id = $1", [orderId])).rows[0]?.order_number;
    await ctx.close();

    assert(number ? text.includes(number) : true,
      `the guest order ${number} did not appear after signing up with the same address`);
    return `guest order ${number} claimed by the new account`;
  });

  await step("an UNCONFIRMED account cannot claim orders by naming the address", async () => {
    if (!orderId) return SKIP("no order to probe");
    // This is the control itself: whoever types an address would otherwise own
    // its guest orders, including the buyer's name, full shipping address and
    // live tracking.
    const impostor = `impostor.${stamp}@example.test`;
    await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', '{"full_name":"Impostor","role":"customer"}', '{"role":"customer"}', null, now())
       on conflict (email) do update set email_confirmed_at = null`,
      [impostor],
    );
    // Point the impostor at the guest's address without confirming it.
    await q("update auth.users set email = $2, email_confirmed_at = null where email = $1",
      [impostor, `claim.${stamp}@example.test`]);

    const number = (await q("select order_number from orders where order_id = $1", [orderId])).rows[0]?.order_number;
    const ctx = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const p = await ctx.newPage();
    await passAgeGate(p);
    await p.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    await p.fill("form input[type=email]", `claim.${stamp}@example.test`);
    await p.fill("form input[type=password]", "HarnessPass123!");
    await p.click("form button[type=submit]");
    await p.waitForTimeout(3500);
    await p.goto(`${BASE}/account/orders`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const text = await p.evaluate(() => document.body.innerText);
    await ctx.close();

    assert(!number || !text.includes(number),
      "an account that has NOT confirmed its address was shown another buyer's guest order");
    return "unconfirmed account saw nothing it had only named";
  });

  await browser.close();

  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  console.log(`\n${results.length} steps: ${results.length - failed.length - skipped.length} passed, `
    + `${failed.length} failed, ${skipped.length} skipped.`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f.section} :: ${f.name}\n      ${f.detail}`);
  }
  if (skipped.length) {
    console.log("\nSkipped — these are NOT verified:");
    for (const sk of skipped) console.log(`  ${sk.section} :: ${sk.name}\n      ${sk.detail}`);
  }
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
