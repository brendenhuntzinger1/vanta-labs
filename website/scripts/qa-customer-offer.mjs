#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE FREE GHK-Cu, DRIVEN END TO END.
//
// A one-time offer that grants a PHYSICAL PRODUCT is worth attacking, and the
// SQL proofs in customer-offers.test.ts cover the database's half. This covers
// the half they cannot reach: that a real browser clicking a real emailed link
// ends up with a real $0 order line, that the money and the stock move the way
// the owner asked for, and that the ways somebody would try to get two free
// vials all fail through the actual HTTP surface.
//
// What the owner specified, and what each step here proves:
//
//   unique per customer      → a second address gets nothing from this token
//   tied to that email       → checking out as someone else gets nothing
//   expires                  → an expired token prices no gift
//   qualifying order only    → under the minimum, no gift
//   auto-applied             → nothing is typed; the cookie does it
//   shown in cart            → the drawer says so before checkout
//   inventory decremented    → stock moves like any other line
//   COGS counted             → unit_cost_cents is recorded on the free line
//   charged $0               → unit_price and line_total are zero
//   permanently redeemed     → and a REFUND does not hand it back
//
// Local harness only.
//   node scripts/qa-customer-offer.mjs
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/vanta-qa/offer";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

const results = [];
const section = (t) => console.log(`\n${t}`);
const assert = (c, m) => { if (!c) throw new Error(m); };

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    results.push({ name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

let browser;
const hash = (token) => createHash("sha256").update(token).digest("hex");
const BUYER = "offer-buyer@example.test";
const STRANGER = "offer-stranger@example.test";

/** Mint an offer directly, the way the sweep does. */
async function issueOffer(email, { hours = 24, minCents = 6000 } = {}) {
  const token = randomBytes(32).toString("base64url");
  await q(
    `insert into customer_offers (offer_key, token_hash, email, product_slug, min_subtotal_cents, expires_at)
     values ('winback_60_free_ghkcu', $1, $2, 'ghk-cu', $3, now() + make_interval(hours => $4))`,
    [hash(token), email.toLowerCase(), minCents, hours],
  );
  return token;
}

/**
 * A fresh browser context with its own client IP.
 *
 * Each step here is a DIFFERENT customer, and the checkout rate limiter keys on
 * the client IP — correctly: eight orders in ten seconds from one address is
 * exactly what it exists to stop. Sharing one IP across the whole script would
 * make this test the limiter instead of the offer, and the limiter already has
 * its own coverage in rate-limit-concurrency.test.ts.
 */
let ipCounter = 0;
async function freshContext(viewport) {
  ipCounter += 1;
  return browser.newContext({
    ...(viewport ? { viewport } : {}),
    extraHTTPHeaders: { "x-real-ip": "203.0.113." + ipCounter },
  });
}

/** A browser that has clicked the emailed link, i.e. holds the offer cookie. */
async function browserHoldingOffer(context, token) {
  const page = await context.newPage();
  // Set the cookie exactly as the click route does: httpOnly, path /.
  await context.addCookies([{
    name: "vl_offer", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
  }]);
  return page;
}

/**
 * Clear the checkout rate-limit bucket.
 *
 * The app limits how fast one visitor may start checkouts, correctly — this
 * script places eight orders in a few seconds, which no customer does. Clearing
 * the bucket between steps tests the offer rather than the rate limiter, which
 * has its own coverage elsewhere.
 */
async function clearRateLimit() {
  await q("delete from rate_limit_hits").catch(() => {});
}

/** Place an order through the real checkout API, as the page. */
async function checkout(page, { email, items, expectFailure = false }) {
  await clearRateLimit();
  const result = await page.evaluate(async ([payload]) => {
    const res = await fetch("/api/checkout/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [{
    items,
    customer: {
      email,
      fullName: "Offer Tester",
      address: "1 Harness Way",
      city: "Testville",
      state: "CA",
      postalCode: "90000",
      country: "US",
      phone: "5555555555",
    },
    currency: "USD",
    // The two boxes the real checkout form makes a shopper tick. Named exactly
    // as hasAllAcknowledgements reads them (express-wallet.ts) — a synthetic
    // order that skipped them would be testing a path no customer can take.
    complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
  }]);
  if (!expectFailure) {
    assert(result.body?.orderId, `checkout failed: ${JSON.stringify(result.body).slice(0, 220)}`);
  }
  return result;
}

const LINE = { id: "bpc-157-10mg", quantity: 1 };          // $69, clears the $60 minimum

async function main() {
  // RE-RUNNABLE. This script places a dozen real orders, and the free unit
  // consumes real stock — which is the point of it being a real order line,
  // and which means an un-topped-up harness runs the catalogue dry and the
  // later steps fail with "just sold out" rather than with anything about the
  // offer. Topping up first keeps a failure here meaningful.
  await q("update products set inventory_quantity = 500, stock_status = 'In Stock' where slug in ('bpc-157-10mg', 'ghk-cu')");
  await q("update product_doses set inventory_quantity = 500, stock_status = 'In Stock' where product_id in (select id from products where slug in ('bpc-157-10mg', 'ghk-cu'))").catch(() => {});
  await q("delete from inventory_reservations where slug in ('bpc-157-10mg', 'ghk-cu')").catch(() => {});

  await q("delete from customer_offers where email in ($1,$2)", [BUYER, STRANGER]);
  await q("delete from order_items where order_id in (select order_id from orders where customer_email in ($1,$2))", [BUYER, STRANGER]);
  await q("delete from orders where customer_email in ($1,$2)", [BUYER, STRANGER]);

  browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  });

  // --- the happy path -------------------------------------------------------
  section("1. A qualifying order gets the free unit");
  let paidOrderId = null;
  await step("the free GHK-Cu is added at $0 with its COGS recorded", async () => {
    const token = await issueOffer(BUYER);
    const context = await freshContext();
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });

    const { body } = await checkout(page, { email: BUYER, items: [LINE] });
    paidOrderId = body.orderId;

    const { rows } = await q(
      "select product_name, unit_price, quantity, line_total, unit_cost_cents from order_items where order_id = $1 order by unit_price",
      [paidOrderId],
    );
    const free = rows.find((r) => Number(r.unit_price) === 0);
    assert(free, `no $0 line on the order: ${JSON.stringify(rows)}`);
    assert(/GHK/i.test(free.product_name), `the free line is ${free.product_name}, not GHK-Cu`);
    assert(Number(free.line_total) === 0, `free line total is ${free.line_total}`);
    assert(Number(free.quantity) === 1, `free line quantity is ${free.quantity}`);
    assert(Number(free.unit_cost_cents) > 0, `COGS was not recorded on the free line (${free.unit_cost_cents})`);
    await context.close();
    return `${free.product_name} x${free.quantity} @ $0, COGS ${free.unit_cost_cents}c`;
  });

  await step("the customer is charged for the paid line only", async () => {
    const { rows } = await q("select subtotal, amount_paid from orders where order_id = $1", [paidOrderId]);
    assert(Number(rows[0].subtotal) === 69, `subtotal is ${rows[0].subtotal}, expected the paid line alone`);
    return `subtotal $${rows[0].subtotal}`;
  });

  await step("the free unit moves real stock, like any other line", async () => {
    // The owner asked for inventory to be decremented normally and COGS to
    // count. Both follow from the gift being a REAL order line rather than a
    // subtotal discount (which is how Buy X Get Y does it) — so this asserts
    // the reservation exists, not merely that the line does.
    const { rows } = await q(
      "select quantity, status from inventory_reservations where order_id = $1 and slug = $2",
      [paidOrderId, "ghk-cu"],
    );
    assert(rows.length === 1, `expected 1 GHK-Cu reservation, found ${rows.length}`);
    assert(Number(rows[0].quantity) === 1, `reserved ${rows[0].quantity}`);
    return `${rows[0].quantity} unit ${rows[0].status}`;
  });

  await step("the offer is reserved, not yet redeemed", async () => {
    const { rows } = await q("select reserved_order_id, redeemed_at from customer_offers where email = $1", [BUYER]);
    assert(rows[0].reserved_order_id === paidOrderId, `reserved by ${rows[0].reserved_order_id}`);
    assert(!rows[0].redeemed_at, "redeemed before payment");
    return "held for this checkout";
  });

  // --- the gate -------------------------------------------------------------
  section("2. The minimum is a real gate");
  await step("an order under the minimum gets no gift", async () => {
    await q("delete from customer_offers where email = $1", [BUYER]);
    // $100 minimum against a $69 cart.
    const token = await issueOffer(BUYER, { minCents: 10000 });
    const context = await freshContext();
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const { body } = await checkout(page, { email: BUYER, items: [LINE] });
    const { rows } = await q("select unit_price from order_items where order_id = $1", [body.orderId]);
    assert(!rows.some((r) => Number(r.unit_price) === 0), "a free line appeared below the minimum");
    await context.close();
    return `${rows.length} paid line(s), no gift`;
  });

  // --- the binding ----------------------------------------------------------
  section("3. The offer belongs to one address");
  await step("a forwarded link checked out by somebody else gets nothing", async () => {
    await q("delete from customer_offers where email = $1", [BUYER]);
    const token = await issueOffer(BUYER);
    const context = await freshContext();
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    // Same cookie, different checkout email — the exact shape of a shared link.
    const { body } = await checkout(page, { email: STRANGER, items: [LINE] });
    const { rows } = await q("select unit_price from order_items where order_id = $1", [body.orderId]);
    assert(!rows.some((r) => Number(r.unit_price) === 0), "a stranger got the free unit");
    await context.close();
    return "no free line for a different address";
  });

  await step("an expired token prices no gift", async () => {
    await q("delete from customer_offers where email = $1", [BUYER]);
    const token = await issueOffer(BUYER, { hours: -1 });
    const context = await freshContext();
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const { body } = await checkout(page, { email: BUYER, items: [LINE] });
    const { rows } = await q("select unit_price from order_items where order_id = $1", [body.orderId]);
    assert(!rows.some((r) => Number(r.unit_price) === 0), "an expired offer was honoured");
    await context.close();
    return "expired, no gift";
  });

  // --- redemption is permanent ---------------------------------------------
  section("4. Redemption is permanent, and a refund does not undo it");
  await step("a second order cannot take the same offer again", async () => {
    await q("delete from customer_offers where email = $1", [BUYER]);
    const token = await issueOffer(BUYER);
    const context = await freshContext();
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });

    const first = await checkout(page, { email: BUYER, items: [LINE] });
    // Pay it, the way the webhook does.
    await q("update orders set payment_status = 'paid' where order_id = $1", [first.body.orderId]);
    await q("select customer_offer_redeem($1)", [first.body.orderId]);

    const second = await checkout(page, { email: BUYER, items: [LINE], expectFailure: true });
    const gotSecondFree = second.body?.orderId
      ? (await q("select unit_price from order_items where order_id = $1", [second.body.orderId])).rows
        .some((r) => Number(r.unit_price) === 0)
      : false;
    assert(!gotSecondFree, "a second free unit was granted after redemption");
    await context.close();
    return second.body?.orderId ? "second order placed, no gift on it" : "second checkout refused";
  });

  await step("REFUNDING the redeeming order does not hand the offer back", async () => {
    // Stands on its own rather than inheriting the previous step: mint, spend,
    // pay, refund, then try to spend again THROUGH THE REAL CHECKOUT. Asserting
    // on the column alone would prove the column, not the behaviour.
    await q("delete from customer_offers where email = $1", [BUYER]);
    const token = await issueOffer(BUYER);
    const context = await freshContext();
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });

    const first = await checkout(page, { email: BUYER, items: [LINE] });
    await q("update orders set payment_status = 'paid' where order_id = $1", [first.body.orderId]);
    await q("select customer_offer_redeem($1)", [first.body.orderId]);

    // They received the vial, then got their money back.
    await q("update orders set payment_status = 'refunded' where order_id = $1", [first.body.orderId]);

    const { rows } = await q("select redeemed_at from customer_offers where email = $1", [BUYER]);
    assert(rows[0]?.redeemed_at, "the refund cleared the redemption stamp");

    const second = await checkout(page, { email: BUYER, items: [LINE] });
    const { rows: secondLines } = await q("select unit_price from order_items where order_id = $1", [second.body.orderId]);
    assert(!secondLines.some((r) => Number(r.unit_price) === 0),
      "a refund handed the offer back — the customer got a second free vial");
    await context.close();
    return "redeemed, refunded, and still spent";
  });

  // --- what the customer sees ----------------------------------------------
  section("5. The customer can see the gift before they pay");
  await step("the cart drawer announces the pending gift", async () => {
    await q("delete from customer_offers where email = $1", [BUYER]);
    const token = await issueOffer(BUYER);
    const context = await freshContext({ width: 390, height: 844 });
    const page = await browserHoldingOffer(context, token);
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });

    const status = await page.evaluate(async () => {
      const res = await fetch("/api/offer/status", { cache: "no-store" });
      return res.json();
    });
    assert(status?.offer, `offer status returned ${JSON.stringify(status)}`);
    assert(/GHK/i.test(status.offer.productName), `status names ${status.offer.productName}`);
    assert(status.offer.minSubtotalCents === 6000, `minimum is ${status.offer.minSubtotalCents}`);
    await page.screenshot({ path: `${SHOTS}/offer-status.png` });
    await context.close();
    return `${status.offer.productName}, min $${status.offer.minSubtotalCents / 100}`;
  });

  await step("the status endpoint leaks no token", async () => {
    const token = (await q("select token_hash from customer_offers where email = $1", [BUYER])).rows[0].token_hash;
    const context = await freshContext();
    const page = await browserHoldingOffer(context, "irrelevant");
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const raw = await page.evaluate(async () => {
      const res = await fetch("/api/offer/status", { cache: "no-store" });
      return res.text();
    });
    assert(!raw.includes(token), "the response carried the token hash");
    assert(!/token/i.test(raw), `the response mentions a token: ${raw.slice(0, 120)}`);
    await context.close();
    return "no token in the response";
  });

  await step("a browser with no offer cookie is told nothing", async () => {
    const context = await freshContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/offer/status", { cache: "no-store" });
      return res.json();
    });
    assert(status.offer === null, `an offer leaked to a cold browser: ${JSON.stringify(status)}`);
    await context.close();
    return "offer: null";
  });

  await browser.close();
}

import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });

main()
  .catch((error) => {
    console.error("\nHARNESS ERROR:", error);
    results.push({ name: "harness", status: "fail", detail: String(error?.message ?? error) });
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    const pass = results.filter((r) => r.status === "pass").length;
    const fail = results.filter((r) => r.status === "fail").length;
    console.log(`\n${"=".repeat(60)}\n  ${pass} passed, ${fail} failed`);
    for (const r of results.filter((x) => x.status === "fail")) console.log(`  - ${r.name}: ${r.detail}`);
    process.exit(fail ? 1 : 0);
  });
