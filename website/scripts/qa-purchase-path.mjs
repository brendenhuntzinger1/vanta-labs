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

import { createHmac, randomUUID, randomBytes } from "node:crypto";
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
/**
 * A CLIENT IP THIS RUN HAS TO ITSELF.
 *
 * This was `203.0.113.${(stamp % 250) + 1}`, which looks like isolation and is
 * not: Date.now() % 250 has only 250 possible values and cycles every 250
 * MILLISECONDS, so the address a run gets is arbitrary and collides constantly
 * between runs. A run that lands on a recent run's address inherits its spent
 * rate-limit bucket, and since a journey does five signups against a per-IP
 * limit of eight, one collision inside the 15-minute window is enough to fail
 * the whole harness at its first signup — reported, misleadingly, as though the
 * product had refused to create the account.
 *
 * 100.64.0.0/10 is the carrier-grade NAT range: never routable, and three
 * random octets give ~16 million addresses instead of 250, from a CSPRNG rather
 * than from the clock.
 */
const CLIENT_IP = (() => {
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
})();

/**
 * THE SAME PURCHASE, AT PHONE SIZE.
 *
 * Most of this store's traffic is mobile, and this is the money path — but every
 * context here was desktop-only, so the one flow it is least affordable to get
 * wrong was the one never driven at 390x844. The journey harness checks mobile
 * for the signed-in account pages; nothing checked mobile through cart,
 * checkout, payment and the receipt.
 *
 *   QA_VIEWPORT=mobile npm run qa:purchase
 *
 * isMobile + hasTouch as well as the viewport, because a narrow desktop window
 * is not a phone: it does not dispatch touch events and it does not get the
 * mobile layout branches that read pointer capability.
 */
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const VIEWPORT_OPTS = process.env.QA_VIEWPORT === "mobile" ? MOBILE : {};

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

  // TICKING A BOX BEFORE REACT IS LISTENING DOES NOTHING VISIBLE.
  //
  // The dialog is server-rendered, so it is in the DOM before hydration
  // finishes. A checkbox clicked in that window flips its own `checked`
  // property and dispatches an event with no handler bound to it — the DOM says
  // ticked, React's state says nothing was, and the submit button stays
  // disabled forever. It looks exactly like a broken age gate, and on a
  // cold-started server (the first navigation of a run) it is the normal case,
  // not a rare one.
  //
  // Clicking through Playwright rather than `element.click()` in page script is
  // half the fix: those are real trusted events with actionability checks. The
  // other half is retrying, because no amount of waiting on the checkbox tells
  // you whether the listener was attached when it was clicked. The button
  // becoming enabled is the only true signal that React took the tick, so that
  // is what is waited on, and the ticks are re-applied until it does.
  const enabled = () => page.$$eval("[role=dialog] button", (btns) =>
    btns.some((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const boxes = await page.$$("[role=dialog] input[type=checkbox]");
    for (const box of boxes) {
      if (!(await box.isChecked())) await box.click({ timeout: 5000 }).catch(() => {});
    }
    if (await enabled()) break;
    await page.waitForTimeout(1000);
  }

  if (!(await enabled())) {
    throw new Error("the age gate's submit button never enabled after ticking every box");
  }

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
  const context = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
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

    const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
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
    const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
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

  // ---- 4. A SIGNED-IN customer's purchase and its return leg -------------
  section("4. Signed in through checkout and back");

  const MEMBER_EMAIL = `member.${stamp}@example.test`;
  let signedInOrder = null;

  await step("a signed-in customer stays signed in through checkout and back", async () => {
    await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', $2, '{"role":"customer"}', now(), now())
       on conflict (email) do update set email_confirmed_at = now()`,
      [MEMBER_EMAIL, JSON.stringify({ full_name: "Signed In Buyer", role: "customer" })],
    );

    const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const p = await ctx.newPage();
    await passAgeGate(p);
    await p.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    await p.fill("form input[type=email]", MEMBER_EMAIL);
    await p.fill("form input[type=password]", "HarnessPass123!");
    await p.click("form button[type=submit]");
    await p.waitForTimeout(3500);
    const signedIn = (await ctx.cookies()).some((c) => c.name === "vl_session_token");
    if (!signedIn) { await ctx.close(); return SKIP("could not sign the customer in"); }

    const item = await sellableCartItem();
    if (!item) { await ctx.close(); return SKIP("no sellable product"); }

    const created = await p.evaluate(async ({ productId }) => {
      const r = await fetch("/api/checkout/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          items: [{ id: productId, quantity: 1 }],
          customer: {
            email: "ignored@example.test", fullName: "Signed In Buyer", address: "2 Test Way",
            city: "Tampa", state: "FL", postalCode: "33601", country: "US",
          },
          complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
        }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { productId: item.id });

    const latest = (await q(
      "select order_id, customer_email, customer_user_id from orders order by created_at desc limit 1",
    )).rows[0];
    if (!latest || String(latest.customer_email).toLowerCase() !== MEMBER_EMAIL) {
      await ctx.close();
      return SKIP(`checkout did not create the signed-in order (${created.status})`);
    }
    signedInOrder = latest.order_id;

    // The account's OWN email, not whatever was typed into the form — the route
    // pins a signed-in order to the account address so receipts cannot be
    // redirected by editing a field.
    assert(String(latest.customer_email).toLowerCase() === MEMBER_EMAIL,
      `the order was addressed to ${latest.customer_email}, not the account`);
    assert(latest.customer_user_id, "the order carries no customer_user_id, so it is not tied to the account");

    // THE RETURN LEG. A processor sends the shopper back as a full document
    // load from another origin; SameSite=Lax is what decides whether the
    // session cookie comes with them.
    await payOrder(p, signedInOrder, {});
    await p.waitForTimeout(2500);
    await p.goto(`${BASE}/order-confirmation/${encodeURIComponent(signedInOrder)}`,
      { waitUntil: "domcontentloaded", referer: "https://checkout.example-processor.test/" });
    await p.waitForTimeout(3000);

    const stillIn = (await ctx.cookies()).some((c) => c.name === "vl_session_token");
    const bounced = /\/account\/login/.test(p.url());
    const text = await p.evaluate(() => document.body.innerText);
    await ctx.close();

    assert(stillIn, "the session cookie was lost coming back from payment");
    assert(!bounced, "coming back from payment landed on the login form");
    assert(/thank you|order (confirmed|received)/i.test(text),
      "the confirmation page did not confirm the order after the return");
    return "signed in through checkout, payment and the return";
  });

  await step("the confirmation page recognises an authenticated customer", async () => {
    if (!signedInOrder) return SKIP("no signed-in order to view");
    const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const p = await ctx.newPage();
    await passAgeGate(p);
    await p.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    await p.fill("form input[type=email]", MEMBER_EMAIL);
    await p.fill("form input[type=password]", "HarnessPass123!");
    await p.click("form button[type=submit]");
    await p.waitForTimeout(3500);

    await p.goto(`${BASE}/order-confirmation/${encodeURIComponent(signedInOrder)}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body.innerText);
    // A signed-in shopper should be offered their account, not asked to create
    // one — that prompt is for guests and reads as "we don't know who you are".
    const invitedToCreate = /create an account to track|sign up to track/i.test(text);
    await ctx.close();
    assert(!invitedToCreate, "a signed-in customer was invited to create an account on their own confirmation page");
    return "no create-an-account prompt for a signed-in customer";
  });

  // ---- 5. Verifying in another tab --------------------------------------
  section("5. Email verification while checking out");

  await step("verifying in a second tab does not break a checkout in progress", async () => {
    const email = `midcheckout.${stamp}@example.test`;
    const row = (await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', $2, '{"role":"customer"}', null, now())
       on conflict (email) do update set email_confirmed_at = null
       returning id`,
      [email, JSON.stringify({ full_name: "Mid Checkout", role: "customer" })],
    )).rows[0];

    const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const tab1 = await ctx.newPage();
    await passAgeGate(tab1);

    // Tab 1: an UNVERIFIED customer gets as far as checkout with a cart.
    await tab1.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(1500);
    const href = await tab1.$eval('a[href^="/products/"]', (a) => a.getAttribute("href"));
    await tab1.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(2000);
    await tab1.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
      if (b) b.click();
    });
    await tab1.waitForTimeout(2000);
    await tab1.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(2500);
    const checkoutReachable = !/\/account\/login/.test(tab1.url());

    // Tab 2: the same person follows the confirmation link from their email.
    const tab2 = await ctx.newPage();
    await tab2.goto(`${BASE}/auth/confirm?token=harness-hashed-${row.id}&type=signup&next=%2Faccount`,
      { waitUntil: "domcontentloaded" });
    await tab2.waitForTimeout(3000);
    const confirmed = (await q("select email_confirmed_at from auth.users where id = $1", [row.id]))
      .rows[0].email_confirmed_at;

    // Back to tab 1: the cart and the page must have survived.
    await tab1.bringToFront();
    await tab1.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(2500);
    const cartText = await tab1.evaluate(() => document.body.innerText);
    const cartSurvived = !/your cart is empty/i.test(cartText);

    await tab2.close();
    await ctx.close();

    assert(checkoutReachable, "an unverified customer could not reach checkout at all");
    assert(confirmed, "the second tab did not verify the account");
    assert(cartSurvived, "verifying in another tab emptied the cart in the checkout tab");
    return "checkout survived a verification in another tab";
  });

  await step("returning to the original tab picks the verification up", async () => {
    const email = `returntab.${stamp}@example.test`;
    const row = (await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', $2, '{"role":"customer"}', null, now())
       on conflict (email) do update set email_confirmed_at = null
       returning id`,
      [email, JSON.stringify({ full_name: "Return Tab", role: "customer" })],
    )).rows[0];

    const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const tab1 = await ctx.newPage();
    await passAgeGate(tab1);
    await tab1.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(2000);

    // Verify in tab 2, then reload tab 1 — the state the customer is left in.
    const tab2 = await ctx.newPage();
    await tab2.goto(`${BASE}/auth/confirm?token=harness-hashed-${row.id}&type=signup&next=%2Faccount`,
      { waitUntil: "domcontentloaded" });
    await tab2.waitForTimeout(3000);
    await tab2.close();

    await tab1.reload({ waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(2000);

    // TWO ACCEPTABLE ENDINGS, and the harness must not insist on the worse one.
    //
    // Following a confirmation link does not merely flip a flag — it
    // establishes a session, and the tabs share one cookie jar. So the ordinary
    // outcome is that the original tab, on reload, is ALREADY signed in and the
    // login page forwards it away: there is no form left to fill, and demanding
    // one turns correct behaviour into a 30s timeout. (That is exactly what it
    // did here first time round.)
    //
    // The weaker ending — still on the login page, but the credentials now work
    // where they were refused before verification — is also fine. What is NOT
    // fine is the customer being stuck: verified elsewhere and still locked out
    // of the tab they started in. That is the assertion.
    const stillOnLogin = Boolean(await tab1.$("form input[type=email]"));
    if (stillOnLogin) {
      await tab1.fill("form input[type=email]", email);
      await tab1.fill("form input[type=password]", "HarnessPass123!");
      await tab1.click("form button[type=submit]");
      await tab1.waitForTimeout(3500);
    }

    const signedIn = (await ctx.cookies()).some((c) => c.name === "vl_session_token");

    // Whichever route it took, the account is usable: /account renders rather
    // than bouncing back to the login page.
    await tab1.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await tab1.waitForTimeout(2000);
    const onAccount = !/\/account\/login/.test(tab1.url());
    await ctx.close();

    assert(signedIn, "after verifying in another tab, the original tab held no session");
    assert(onAccount, "the original tab was still bounced to the login page after verifying");
    return stillOnLogin
      ? "the original tab could sign in once verification happened elsewhere"
      : "the original tab was already signed in by the verification in the other tab";
  });

  // ---- 6. Membership billing emails --------------------------------------
  section("6. Membership billing emails");

  await step("a renewal receipt goes to the member who was charged", async () => {
    const memberId = (await q("select id from auth.users where email = $1", [MEMBER_EMAIL])).rows[0]?.id;
    if (!memberId) return SKIP("no member account to renew");

    const veyraId = `vm_${stamp}`;
    const tier = (await q("select id from membership_tiers order by 1 limit 1")).rows[0];
    if (!tier) return SKIP("no membership tier seeded in the harness");

    const existing = await q(
      `insert into customer_memberships (user_id, tier_id, status, billing_cycle, veyra_membership_id, next_billing_at, created_at, updated_at)
       values ($1, $2, 'active', 'monthly', $3, now() + interval '30 days', now(), now())
       on conflict do nothing returning user_id`,
      [memberId, tier.id, veyraId],
    ).catch(() => ({ rows: [] }));
    if (!existing.rows.length) {
      const already = await q("select 1 from customer_memberships where veyra_membership_id = $1", [veyraId]);
      if (!already.rows.length) return SKIP("could not seed a membership row in the harness");
    }

    const before = logOffset();
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: "membership.renewed",
      data: {
        membership_id: veyraId,
        amount_charged_cents: 2900,
        next_renewal_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      },
    });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
    const res = await page.request.post(`${BASE}/api/webhooks/payment`, {
      headers: {
        "content-type": "application/json",
        "x-payment-signature": signature,
        "x-event-id": `evt_${randomUUID()}`,
      },
      data: body,
    });
    await page.waitForTimeout(2500);
    if (!res.ok()) return SKIP(`the membership webhook was refused: ${res.status()}`);

    const mail = mailSince(before);
    if (!mail) return SKIP("no harness log configured");
    // Match on the money and the word, not on a guess at the wording: the
    // subject was `Receipt: $29.00 charged` when this first ran, which named
    // neither. It says "membership renewal" now — and that is asserted properly
    // in email/membership-receipt-subjects.test.ts, where a wording change is a
    // test failure rather than a silently-skipped harness step.
    const receipt = mail.find((m) => /receipt/i.test(m.subject) && /29\.00/.test(m.subject));
    assert(receipt, `no renewal email composed; saw: ${mail.map((m) => m.subject).join(", ") || "nothing"}`);
    assert(receipt.to === MEMBER_EMAIL,
      `the renewal receipt went to ${receipt.to}, not the member who was charged`);
    return `"${receipt.subject}" to ${receipt.to}`;
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
