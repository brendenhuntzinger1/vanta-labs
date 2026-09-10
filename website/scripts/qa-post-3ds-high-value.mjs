#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE POST-3DS HIGH-VALUE PAYMENT PATH — the one that was broken, and the one
// that must never break again.
//
// WHY THIS EXISTS
//
// Until 2026-09-09 this store had NEVER taken an order of $200 or more. Seven
// tried; all seven died. The largest payment that had ever succeeded was
// $194.98. The cause was processor-side 3-D Secure: Veyra requested a challenge,
// the iframe printed "Additional verification is required for this payment",
// greyed out its own pay button, and offered the shopper no code field, no bank
// app and no redirect. The charge was never submitted to the issuer at all, so
// there was no decline code, no payment event, and nothing for the shopper to
// do. Five orders from two shoppers (~$620) were lost to it on 2026-09-08 alone.
//
// Veyra then removed 3DS from the account, and the very next high-value attempt
// behaved like ordinary card processing:
//
//   VL-4AFCDF39  $269.35  payment.failed  vtxn_497fdeb1…   86s   insufficient_funds
//   VL-D56BA5B4  $269.35  paid            vtxn_d2e00c45…  112s
//
// One shopper, two attempts three minutes apart. The first reached his BANK and
// came back with a real decline code; his bank sent him an approval prompt; he
// approved it and retried; the retry paid. That is the first order at or above
// $200 this store has ever settled, and the whole shape of it — a definitive
// decline, an out-of-band bank confirmation, then a successful retry — is now a
// normal customer journey rather than an exotic one.
//
// THIS FILE IS THAT JOURNEY, AS A TEST. It exists so that no later fix to the
// verification UX, the decline copy, the idempotency guards or the reconciler
// can quietly put the $200 wall back. Run it before and after any payment
// change.
//
// WHAT IS REAL HERE AND WHAT IS A STAND-IN
//
// Real: the catalogue, the quote, /api/checkout/create-session, the order and
// item rows, the inventory hold, the HMAC-signed webhook, /api/webhooks/payment
// and every side effect behind it (mark paid, decrement stock, accrue
// commission, claim the send-once slot, compose the receipt), the order-status
// poll the payment page lives on, and the amount handed to the processor.
//
// A stand-in: the processor's session mint (scripts/veyra-stub.mjs), because
// reaching a real gateway from a test is not something to want. The stub logs
// the request body, which is what lets this file assert that the cents we ask
// Veyra to charge are exactly the cents on the order row — the amount-integrity
// claim that matters most and is otherwise invisible.
//
// NOT covered, and deliberately: Veyra's own iframe. It is cross-origin and
// cannot be driven here. What this proves is OUR side of the handoff.
//
// Development-only. Drives the local harness and refuses to start anywhere else.
//
//   node scripts/qa-post-3ds-high-value.mjs
//   QA_VIEWPORT=mobile node scripts/qa-post-3ds-high-value.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";
const DEFAULT_HARNESS_LOG = `${process.env.QA_LOG_DIR ?? "/tmp/vanta-qa"}/harness.log`;
const HARNESS_LOG = process.env.QA_HARNESS_LOG
  ?? (existsSync(DEFAULT_HARNESS_LOG) ? DEFAULT_HARNESS_LOG : null);

/**
 * WHERE THE SENT MAIL ACTUALLY IS, UNDER EITHER PROVIDER.
 *
 * Every email assertion below used to read ONLY the app's stdout, matching the
 * line NoopEmailProvider prints ("Not sent: ..."). That provider runs ONLY when
 * no real one is configured — so the moment the harness is pointed at
 * scripts/smtp-sink.mjs, which docs/BROWSER-TESTING-RUNBOOK.md tells you to do
 * for the marketing, lifecycle and gift suites, every step here reads a log
 * that cannot contain what it is looking for.
 *
 * The two halves of that runbook therefore contradicted each other, and only
 * one configuration could be right at a time. Measured 2026-09-10: with the
 * documented SMTP sink running, three steps of qa:journey reported "no email
 * composed" for three emails that had been composed, addressed and delivered
 * perfectly well — and because qa:all chains on &&, the run stopped there and
 * qa:purchase, qa:highvalue, qa:amounts, qa:edge, qa:crawl and qa:abuse never
 * ran at all.
 *
 * BOTH providers append to captured-emails.jsonl — the noop one writes it as it
 * declines to send, the sink writes it on delivery — so that file is the one
 * surface that is true in either configuration. Prefer it; keep the stdout
 * reader as the fallback for a harness running the noop provider with no
 * capture directory set, so this is strictly more capable than before and never
 * less.
 */
const MAIL_CAPTURE = `${process.env.EMAIL_CAPTURE_DIR ?? process.env.QA_LOG_DIR ?? "/tmp/vanta-qa"}/captured-emails.jsonl`;
/** One resolution, used by BOTH the offset and the reader, so they cannot disagree. */
const mailSource = () => (existsSync(MAIL_CAPTURE) ? MAIL_CAPTURE : HARNESS_LOG);

const VEYRA_LOG = process.env.QA_VEYRA_LOG ?? `${process.env.QA_LOG_DIR ?? "/tmp/vanta-qa"}/veyra.log`;

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

/**
 * THE THRESHOLD THIS FILE IS ABOUT.
 *
 * $200 was never OUR number — it was the processor's 3DS trigger. These carts
 * straddle it so that "the application treats every amount identically" is
 * measured rather than assumed: if any gate were reintroduced anywhere in
 * quote -> create-session -> Veyra -> webhook, the two sides of this boundary
 * would stop behaving the same way.
 */
const THRESHOLD = 200;

const stamp = Date.now();
const CLIENT_IP = (() => {
  // CGNAT, from a CSPRNG: a per-IP rate-limit bucket must not be shared with
  // another harness run. See the same note in qa-purchase-path.mjs.
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
})();
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const VIEWPORT_OPTS = process.env.QA_VIEWPORT === "mobile" ? MOBILE : {};

const SHOPPER = `hv.${stamp}@example.test`;
const PASSWORD = "HarnessPass123!";

const client = new pg.Client({ connectionString: DB });
const q = (text, params) => client.query(text, params);

let passed = 0;
let failed = 0;
let skipped = 0;
const skips = [];
const SKIP = (reason) => ({ __skip: reason });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(Math.min(title.length, 74)));
}

async function step(name, fn) {
  try {
    const result = await fn();
    if (result && result.__skip) {
      skipped += 1;
      skips.push(`${name} — ${result.__skip}`);
      console.log(`  SKIP  ${name}  — ${result.__skip}`);
      return null;
    }
    passed += 1;
    console.log(`  PASS  ${name}${result ? `  — ${result}` : ""}`);
    return result;
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
    return null;
  }
}

const logOffset = () => {
  const source = mailSource();
  return source && existsSync(source) ? statSync(source).size : 0;
};

/** Emails the app composed since `offset`. Mirrors qa-purchase-path.mjs. */
function mailSince(offset) {
  const source = mailSource();
  if (!source || !existsSync(source)) return null;
  // Sliced as BYTES, not characters. statSync().size is a byte count and
  // String.prototype.slice counts UTF-16 code units, so a source containing an
  // em dash (every "Delivered — order" line has one) drifts the two apart and
  // the window silently starts past the lines being looked for. That reported
  // "no email composed" for emails that had been composed perfectly well.
  const buf = readFileSync(source);
  const text = buf.subarray(Math.min(offset, buf.length)).toString("utf8");

  if (source === MAIL_CAPTURE) {
    // One JSON object per delivered message. A half-written trailing line, or a
    // window that opened mid-line, simply does not parse and is dropped rather
    // than throwing and failing a step for a reason that is not about email.
    return text
      .split("\n")
      .map((line) => {
        if (!line.trim()) return null;
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((m) => ({ subject: String(m.subject ?? ""), to: String(m.to ?? "") }));
  }

  // The address runs to end-of-line; the trailing full stop is the log's, not
  // part of the address.
  return [...text.matchAll(/Not sent: "([^"]+)" to (\S+?)\.?\s*$/gm)]
    .map((m) => ({ subject: m[1], to: m[2] }));
}

const veyraOffset = () => (existsSync(VEYRA_LOG) ? statSync(VEYRA_LOG).size : 0);

/**
 * The cents we actually asked the processor to charge.
 *
 * scripts/veyra-stub.mjs logs the request body it was handed, which is the only
 * place the outbound amount is observable without a real gateway. Without this,
 * "the customer is charged the server's total" is an assumption.
 */
function veyraAmountsSince(offset) {
  if (!existsSync(VEYRA_LOG)) return null;
  const buf = readFileSync(VEYRA_LOG);
  const text = buf.subarray(Math.min(offset, buf.length)).toString("utf8");
  // READ IT WITH A REGEX, NOT JSON.parse. The stub slices the body at 200
  // characters, so every logged payload is truncated mid-object and has no
  // closing brace — parsing it always throws and the amount silently reads as
  // "the processor was never called". Correlate on `description`, which carries
  // the order NUMBER and survives the truncation; metadata sits past the cut.
  const amounts = [];
  for (const line of text.split("\n")) {
    const cents = /"amount_cents":\s*(\d+)/.exec(line);
    if (!cents) continue;
    const number = /"description":\s*"([^"]+)"/.exec(line);
    amounts.push({ amount_cents: Number(cents[1]), order_number: number ? number[1] : null });
  }
  return amounts;
}

/** A signed processor event, exactly as scripts/harness-pay-order.mjs builds it. */
async function sendWebhook(orderId, { type = "payment.succeeded", eventId, failureCode, failureMessage } = {}) {
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
    paymentId: t(o.payment_id) ?? `hv_pay_${o.order_id}`,
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
    // Only present on a decline, and only when the processor said why — the
    // shape extractProcessorFailure reads.
    ...(failureCode || failureMessage
      ? { data: { decline_code: failureCode, failure_message: failureMessage } }
      : {}),
    items: items.map((i) => ({
      productId: t(i.product_id),
      productName: t(i.product_name),
      unitPrice: n(i.unit_price),
      quantity: n(i.quantity),
      lineTotal: n(i.line_total),
    })),
  });

  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
  const res = await fetch(`${BASE}/api/webhooks/payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-signature": signature,
      "x-event-id": eventId ?? `hv_evt_${randomUUID()}`,
      "x-real-ip": CLIENT_IP,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const orderRow = async (orderId) => (await q(
  `select order_id, order_number, payment_status, fulfillment_status, amount_paid, subtotal,
          shipping_amount, tax_amount, discount_amount, card_processing_fee, paid_at,
          provider_event_id, paid_side_effects_at, inventory_committed_at, inventory_restocked_at,
          payment_failure_kind, payment_failure_code, payment_failure_reason, payment_id
     from orders where order_id = $1`, [orderId],
)).rows[0];

/**
 * A sellable cart line and its unit price in cents.
 *
 * Keyed by SLUG (or `slug::doseId`) because quote-order.ts keys the catalogue
 * that way — a products.id is rejected. See qa-purchase-path.mjs.
 */
async function sellableLines() {
  const parents = (await q(
    `select p.slug, p.price_cents, coalesce(p.inventory_quantity,0) - coalesce(p.reserved_quantity,0) as avail
       from products p
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true)
        and not coalesce(p.is_archived,false) and coalesce(p.price_cents,0) > 0
        and coalesce(p.inventory_quantity,0) - coalesce(p.reserved_quantity,0) > 0
      order by p.price_cents desc`,
  )).rows.map((r) => ({ id: r.slug, price_cents: Number(r.price_cents), avail: Number(r.avail), describe: r.slug }));

  const dosed = (await q(
    `select p.slug, d.id as dose_id, d.label, d.price_cents,
            coalesce(d.inventory_quantity,0) - coalesce(d.reserved_quantity,0) as avail
       from products p join product_doses d on d.product_id = p.id
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true)
        and not coalesce(p.is_archived,false) and coalesce(d.price_cents,0) > 0
        and coalesce(d.inventory_quantity,0) - coalesce(d.reserved_quantity,0) > 0
      order by d.price_cents desc`,
  )).rows.map((r) => ({
    id: `${r.slug}::${r.dose_id}`, price_cents: Number(r.price_cents),
    avail: Number(r.avail), describe: `${r.slug} (${r.label})`,
  }));

  return [...parents, ...dosed];
}

/** A cart whose SUBTOTAL clears `targetCents`, using the fewest units available. */
function cartClearing(lines, targetCents) {
  for (const line of lines) {
    const need = Math.ceil(targetCents / line.price_cents);
    if (need > 0 && need <= line.avail) {
      return { items: [{ id: line.id, quantity: need }], describe: `${need} x ${line.describe}`,
        subtotal_cents: need * line.price_cents };
    }
  }
  return null;
}

async function createConfirmedCustomer(email, password, fullName) {
  await q(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data,
                             email_confirmed_at, created_at)
     values ($1, $2, $3, '{"role":"customer"}'::jsonb, now(), now())
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password, email_confirmed_at = now()`,
    [email, password, JSON.stringify({ full_name: fullName, role: "customer" })],
  );
}

async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const appeared = await page.waitForSelector("[role=dialog]", { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (!appeared) return false;
  const enabled = () => page.$$eval("[role=dialog] button", (btns) =>
    btns.some((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const box of await page.$$("[role=dialog] input[type=checkbox]")) {
      if (!(await box.isChecked())) await box.click({ timeout: 5000 }).catch(() => {});
    }
    if (await enabled()) break;
    await page.waitForTimeout(1000);
  }
  if (!(await enabled())) throw new Error("the age gate never enabled its submit button");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });
  await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 });
  return true;
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("form, .vl-portal-row", { timeout: 15000 });
  const hasField = async () => (await page.$("form input[type=email]")) !== null;
  for (let attempt = 0; attempt < 5 && !(await hasField()); attempt += 1) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
  }
  if (!(await hasField())) throw new Error("the portal never opened the email sign-in form");
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", password);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST",
      { timeout: 25000 }).catch(() => null),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(1500);
  if (!(await page.context().cookies()).some((c) => c.name === "vl_session_token")) {
    throw new Error("sign-in did not establish a session");
  }
}

/** Place an order through the real checkout route and return its row. */
async function placeOrder(page, cart) {
  const before = (await q("select order_id from orders order by created_at desc limit 1")).rows[0]?.order_id ?? null;
  const created = await page.evaluate(async ({ email, items }) => {
    const r = await fetch("/api/checkout/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        items,
        customer: {
          email, fullName: "High Value Buyer", address: "1 Test Way",
          city: "Tampa", state: "FL", postalCode: "33601", country: "US",
        },
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { email: SHOPPER, items: cart.items });

  const latest = (await q("select order_id from orders order by created_at desc limit 1")).rows[0];
  if (!latest || latest.order_id === before) {
    throw new Error(`checkout created no order (HTTP ${created.status}: `
      + `${JSON.stringify(created.body).slice(0, 200)})`);
  }
  return { row: await orderRow(latest.order_id), response: created };
}

/**
 * Make sure the catalogue can actually supply this run.
 *
 * Every PAID order here decrements real stock, so consecutive runs walk the
 * seeded catalogue down to zero — after which reserve_inventory correctly
 * refuses, createCheckoutSession correctly CANCELS the order, and four steps
 * fail reporting "should be payment_failed, not canceled". That is the harness
 * having made the shop unsellable, and it reads exactly like a payment defect.
 *
 * Topping up is a fixture operation on a throwaway database (this script refuses
 * to run against anything but loopback) and it only ever ADDS units. Holds are
 * left strictly alone — reserved_quantity belongs to whatever is in flight.
 */
async function ensureStockForRun(minimum = 60) {
  // NEVER STOCK THE PARENT OF A DOSE-STOCKED PRODUCT.
  //
  // Most of this catalogue — and 31 of 36 live products — carries zero on the
  // parent and the real stock on each dose. A blanket top-up gave those parents
  // units they never have, so sellableLines() offered the PARENT as a sellable
  // line; the cart used it, quote-order resolved the sale to the dose, the
  // decrement moved the dose, and the assertion that read the parent saw no
  // movement at all. The fixture has to preserve the production shape or it
  // invents failures of its own.
  const { rowCount } = await q(
    `update products p set inventory_quantity = $1
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true)
        and not coalesce(p.is_archived,false) and coalesce(p.price_cents,0) > 0
        and coalesce(p.inventory_quantity,0) < $1
        and not exists (select 1 from product_doses d where d.product_id = p.id)`,
    [minimum],
  );
  const doses = await q(
    `update product_doses set inventory_quantity = $1
      where coalesce(price_cents,0) > 0 and coalesce(inventory_quantity,0) < $1`,
    [minimum],
  );
  return rowCount + (doses.rowCount ?? 0);
}

/**
 * Clear the consent banner before reading a page's text.
 *
 * The banner is an overlay, so `document.body.innerText` on a freshly loaded
 * account page can be almost entirely cookie copy — which made an assertion
 * about the order's own wording fail on a page that was rendering it correctly.
 * Best-effort: if there is no banner there is nothing to do.
 */
async function dismissConsent(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((b) => /^(accept|accept all|allow all|got it|ok)$/i.test((b.textContent ?? "").trim()));
    if (button) button.click();
  }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Wait for stock to move by `expected`, rather than reading once after a sleep.
 *
 * The paid path commits inventory as part of settling the webhook, but the read
 * that follows a fixed `waitForTimeout` can still land before the decrement is
 * visible — which reported "stock moved by 0" on an order whose dose had in fact
 * gone from 60 to 57 and whose inventory_committed_at was set. A clock was
 * standing in for a condition, which is the failure the browser runbook spends a
 * page warning about.
 */
async function waitForStockDrop(cart, before, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = before;
  while (Date.now() < deadline) {
    latest = await stockOf(cart);
    if (before.qty - latest.qty >= expected) return before.qty - latest.qty;
    await new Promise((r) => setTimeout(r, 500));
  }
  return before.qty - latest.qty;
}

async function stockOf(cart) {
  const [slug, doseId] = String(cart.items[0].id).split("::");
  if (doseId) {
    const r = (await q(
      `select coalesce(d.inventory_quantity,0) as qty, coalesce(d.reserved_quantity,0) as reserved
         from product_doses d where d.id = $1`, [doseId],
    )).rows[0];
    return { qty: Number(r.qty), reserved: Number(r.reserved) };
  }
  const r = (await q(
    `select coalesce(inventory_quantity,0) as qty, coalesce(reserved_quantity,0) as reserved
       from products where slug = $1`, [slug],
  )).rows[0];
  return { qty: Number(r.qty), reserved: Number(r.reserved) };
}

async function main() {
  await client.connect();
  const CHROME = process.env.QA_CHROMIUM
    ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
      .find((p) => existsSync(p));
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP },
  });
  const page = await context.newPage();

  console.log(`\nPOST-3DS HIGH-VALUE PAYMENT PATH  (${process.env.QA_VIEWPORT === "mobile" ? "390x844" : "desktop"})`);
  console.log(`base ${BASE}   shopper ${SHOPPER}`);
  if (!HARNESS_LOG) console.log("WARNING: no harness log found — every email assertion will SKIP.");

  // Before the carts are chosen: a previous run's PAID orders have really
  // decremented this catalogue, and an exhausted line makes every later step
  // fail as though checkout were broken.
  const toppedUp = await ensureStockForRun();
  if (toppedUp) console.log(`topped up ${toppedUp} product line(s) so this run can be served`);

  const lines = await sellableLines();
  const highCart = cartClearing(lines, THRESHOLD * 100);
  const lowCart = cartClearing(lines.slice().reverse(), 2000);

  await createConfirmedCustomer(SHOPPER, PASSWORD, "High Value Buyer");
  await passAgeGate(page);
  await signIn(page, SHOPPER, PASSWORD);
  await dismissConsent(page);

  // ---- 1. A high-value order is created and handed to the processor -------
  section(`1. An order over $${THRESHOLD} reaches the processor at all`);

  let highOrder = null;

  await step(`a cart over $${THRESHOLD} is quoted and an order row is written`, async () => {
    if (!highCart) return SKIP("no in-stock product can reach the threshold in this catalogue");
    const vOffset = veyraOffset();
    const { row } = await placeOrder(page, highCart);
    highOrder = row;
    const total = Number(row.amount_paid);
    assert(total >= THRESHOLD, `the cart totalled $${total.toFixed(2)}, which is under the threshold`);
    assert(row.payment_status === "pending_payment",
      `a new order should be pending_payment, not ${row.payment_status}`);
    assert(row.payment_id, "no processor session id was stored on the order");
    // THE WALL WOULD SHOW UP HERE. If anything in our application gated on
    // amount, a high-value cart would never get a session minted.
    const sent = veyraAmountsSince(vOffset);
    assert(sent && sent.length > 0, "the processor was never asked to create a session for this order");
    return `${row.order_number} $${total.toFixed(2)} (${highCart.describe}), session ${String(row.payment_id).slice(0, 12)}…`;
  });

  await step("the cents sent to the processor are exactly the cents on the order", async () => {
    if (!highOrder) return SKIP("no high-value order");
    const sent = veyraAmountsSince(0);
    const mine = (sent ?? []).filter((s) => s.order_number === highOrder.order_number);
    if (!mine.length) return SKIP("the stub log carries no session request for this order number");
    const expected = Math.round(Number(highOrder.amount_paid) * 100);
    for (const s of mine) {
      assert(s.amount_cents === expected,
        `we asked the processor for ${s.amount_cents}c but the order says ${expected}c`);
    }
    return `${expected}c asked, ${expected}c on the row (${mine.length} session request)`;
  });

  await step("the order total reconciles with its own components", async () => {
    if (!highOrder) return SKIP("no high-value order");
    const n = (v) => Number(v ?? 0);
    const expected = n(highOrder.subtotal) + n(highOrder.shipping_amount) + n(highOrder.tax_amount)
      + n(highOrder.card_processing_fee) - n(highOrder.discount_amount);
    assert(Math.abs(expected - n(highOrder.amount_paid)) < 0.011,
      `amount_paid ${n(highOrder.amount_paid)} != components ${expected.toFixed(2)}`);
    return `$${n(highOrder.amount_paid).toFixed(2)} = ${n(highOrder.subtotal).toFixed(2)} + ship `
      + `${n(highOrder.shipping_amount).toFixed(2)} + tax ${n(highOrder.tax_amount).toFixed(2)} + fee `
      + `${n(highOrder.card_processing_fee).toFixed(2)} - disc ${n(highOrder.discount_amount).toFixed(2)}`;
  });

  await step(`an order UNDER $${THRESHOLD} takes the identical path`, async () => {
    if (!lowCart) return SKIP("no cheap in-stock product");
    const { row } = await placeOrder(page, lowCart);
    const total = Number(row.amount_paid);
    assert(total < THRESHOLD, `the control cart totalled $${total.toFixed(2)}, not under the threshold`);
    assert(row.payment_status === "pending_payment" && row.payment_id,
      "the under-threshold order did not reach the processor the same way");
    return `${row.order_number} $${total.toFixed(2)} — same states, same session mint`;
  });

  // ---- 2. A definitive decline, told truthfully ---------------------------
  section("2. A definitive decline on a high-value order");

  let declinedOrder = null;

  await step("a declined high-value payment is recorded as failed, with the processor's own code", async () => {
    if (!highCart) return SKIP("no high-value cart");
    const { row } = await placeOrder(page, highCart);
    declinedOrder = row;
    const before = logOffset();
    const res = await sendWebhook(row.order_id, {
      type: "payment.failed", failureCode: "insufficient_funds", failureMessage: "Card has insufficient funds.",
    });
    assert(res.status === 200, `the webhook answered ${res.status}: ${res.text.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await orderRow(row.order_id);
    declinedOrder = after;
    assert(after.payment_status === "payment_failed",
      `a declined order should be payment_failed, not ${after.payment_status}`);
    assert(after.paid_at == null, "a declined order carries a paid_at");
    assert(String(after.payment_failure_code ?? "") === "insufficient_funds",
      `the decline code was stored as ${after.payment_failure_code}`);
    const mail = mailSince(before);
    if (mail) {
      const wrong = mail.filter((m) => /order confirm|thank you for your order|receipt/i.test(m.subject));
      assert(wrong.length === 0, `a declined payment composed ${wrong.length} success email(s)`);
    }
    return `${after.order_number} payment_failed / ${after.payment_failure_code}, no success email`;
  });

  await step("a declined order releases the stock it was holding", async () => {
    if (!declinedOrder) return SKIP("no declined order");
    const held = (await q(
      `select count(*)::int as n from inventory_reservations
        where order_id = $1 and coalesce(status,'active') = 'active'`, [declinedOrder.order_id],
    )).rows[0];
    assert(Number(held.n) === 0,
      `${held.n} inventory reservation(s) are still active on a failed order — they block the shopper's retry`);
    return "no active hold remains";
  });

  await step("the payment page is told to stop waiting and let the shopper act", async () => {
    if (!declinedOrder) return SKIP("no declined order");
    const body = await page.evaluate(async (id) => {
      const r = await fetch(`/api/checkout/order-status/${encodeURIComponent(id)}`, { cache: "no-store" });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, declinedOrder.order_id);
    assert(body.json && body.json.paid === false && body.json.pending === false,
      `order-status said ${JSON.stringify(body.json)} — the page cannot tell this is terminal`);
    // WHY it failed, too. Without this the payment page had only "it failed",
    // so every decline surface asserted a BANK had refused and that the card was
    // NOT charged — neither of which payment_failed alone can support, and on
    // this store sixteen of eighteen failures had no processor event at all.
    assert(typeof body.json.failureKind === "string" && body.json.failureKind.length > 0,
      `order-status returned no failureKind: ${JSON.stringify(body.json)}`);
    return `paid:false pending:false (terminal), failureKind=${body.json.failureKind}`;
  });

  await step("the shopper is told a bank refused only when a bank actually did", async () => {
    if (!declinedOrder) return SKIP("no declined order");
    // This decline came from a webhook carrying insufficient_funds, so the
    // stronger wording is licensed here. The unknown case gets the softer text —
    // both are pinned in checkout-decline-journey.test.ts; what this proves is
    // that the SERVER hands the page the distinction at all.
    const body = await page.evaluate(async (id) => {
      const r = await fetch(`/api/checkout/order-status/${encodeURIComponent(id)}`, { cache: "no-store" });
      return await r.json().catch(() => null);
    }, declinedOrder.order_id);
    assert(body?.failureKind === "processor_declined",
      `a webhook-confirmed decline reported failureKind=${body?.failureKind}`);
    return "processor_declined, so the bank wording is earned";
  });

  // ---- 3. David's journey: decline -> bank approval -> retry -> paid ------
  section("3. The retry that pays (David's journey)");

  let retryOrder = null;

  await step("after a definitive decline the shopper can place a fresh high-value order", async () => {
    if (!highCart) return SKIP("no high-value cart");
    // The real shopper approved the charge in his banking app between these two
    // attempts. Nothing about that is visible to us, and this test deliberately
    // does not pretend otherwise — what it proves is that our side permits the
    // retry at all, which is what the inventory hold and the coupon/idempotency
    // guards could each quietly prevent.
    const { row } = await placeOrder(page, highCart);
    retryOrder = row;
    assert(Number(row.amount_paid) >= THRESHOLD, "the retry cart fell under the threshold");
    assert(row.payment_status === "pending_payment", `the retry order opened as ${row.payment_status}`);
    assert(row.order_id !== declinedOrder?.order_id, "the retry reused the dead order row");
    assert(row.payment_id && row.payment_id !== declinedOrder?.payment_id,
      "the retry reused the dead processor session");
    return `${row.order_number} $${Number(row.amount_paid).toFixed(2)}, fresh session`;
  });

  await step("the retry settles to PAID on a signed processor event", async () => {
    if (!retryOrder) return SKIP("no retry order");
    const stockBefore = await stockOf(highCart);
    const before = logOffset();
    const res = await sendWebhook(retryOrder.order_id, { type: "payment.succeeded" });
    assert(res.status === 200, `the webhook answered ${res.status}: ${res.text.slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await orderRow(retryOrder.order_id);
    retryOrder = after;
    assert(after.payment_status === "paid", `the retry ended ${after.payment_status}, not paid`);
    assert(after.paid_at, "a paid order carries no paid_at");
    assert(after.provider_event_id, "a paid order carries no provider_event_id");
    assert(after.paid_side_effects_at, "the paid side-effects latch was never claimed");
    const moved = await waitForStockDrop(highCart, stockBefore, highCart.items[0].quantity);
    const stockNow = await stockOf(highCart);
    assert(moved === highCart.items[0].quantity,
      `stock moved by ${moved}, expected ${highCart.items[0].quantity} `
      + `(line ${highCart.items[0].id}: before qty=${stockBefore.qty} reserved=${stockBefore.reserved}, `
      + `now qty=${stockNow.qty} reserved=${stockNow.reserved})`);
    const mail = mailSince(before);
    if (mail) {
      const receipts = mail.filter((m) => /order confirm|thank you for your order/i.test(m.subject));
      assert(receipts.length === 1, `${receipts.length} confirmation emails for one paid order`);
      assert(receipts[0].to === SHOPPER, `the receipt went to ${receipts[0].to}`);
      assert(new RegExp(after.order_number).test(receipts[0].subject),
        `the receipt quotes ${receipts[0].subject}, not ${after.order_number}`);
    }
    return `${after.order_number} PAID $${Number(after.amount_paid).toFixed(2)}, stock -${moved}, one receipt`;
  });

  await step("a redelivered success event changes nothing and sends nothing", async () => {
    if (!retryOrder || retryOrder.payment_status !== "paid") return SKIP("no paid retry order");
    const eventId = `hv_dupe_${randomUUID()}`;
    const before = logOffset();
    const stockBefore = await stockOf(highCart);
    await sendWebhook(retryOrder.order_id, { type: "payment.succeeded", eventId });
    await sendWebhook(retryOrder.order_id, { type: "payment.succeeded", eventId });
    await sendWebhook(retryOrder.order_id, { type: "payment.succeeded", eventId: `hv_dupe2_${randomUUID()}` });
    await new Promise((r) => setTimeout(r, 2000));
    const after = await orderRow(retryOrder.order_id);
    const stockAfter = await stockOf(highCart);
    assert(after.payment_status === "paid", `redelivery moved the order to ${after.payment_status}`);
    assert(stockAfter.qty === stockBefore.qty,
      `redelivery moved stock by ${stockBefore.qty - stockAfter.qty}`);
    const mail = mailSince(before);
    if (mail) {
      const receipts = mail.filter((m) => /order confirm|thank you for your order/i.test(m.subject));
      assert(receipts.length === 0, `${receipts.length} duplicate confirmation(s) after redelivery`);
    }
    return "three redeliveries: still paid, stock unmoved, no second receipt";
  });

  await step("a LATE decline cannot demote the paid order", async () => {
    if (!retryOrder || retryOrder.payment_status !== "paid") return SKIP("no paid retry order");
    // The 2026-08-03 production order VL-49CA32C1 received a failure and then a
    // success 60s apart on one row. The reverse order must be safe too: money
    // captured must never be un-captured by a late or unrelated event.
    const stockBefore = await stockOf(highCart);
    await sendWebhook(retryOrder.order_id, {
      type: "payment.failed", failureCode: "insufficient_funds", failureMessage: "Card has insufficient funds.",
    });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await orderRow(retryOrder.order_id);
    const stockAfter = await stockOf(highCart);
    assert(after.payment_status === "paid",
      `a late decline demoted a PAID order to ${after.payment_status} — money taken, order says otherwise`);
    assert(stockAfter.qty === stockBefore.qty, "a late decline restocked sold inventory");
    assert(after.inventory_restocked_at == null, "a late decline stamped inventory_restocked_at on a paid order");
    return "still paid, stock intact";
  });

  await step("the customer is sent to a receipt, and the order reads paid to them", async () => {
    if (!retryOrder || retryOrder.payment_status !== "paid") return SKIP("no paid retry order");
    const body = await page.evaluate(async (id) => {
      const r = await fetch(`/api/checkout/order-status/${encodeURIComponent(id)}`, { cache: "no-store" });
      return await r.json().catch(() => null);
    }, retryOrder.order_id);
    assert(body && body.paid === true, `order-status still says ${JSON.stringify(body)}`);
    await page.goto(`${BASE}/order-confirmation/${encodeURIComponent(retryOrder.order_id)}`,
      { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    assert(/thank you|order (confirmed|received)/i.test(text),
      `the confirmation page did not confirm: ${text.slice(0, 160)}`);
    return "order-status paid:true, confirmation page confirms";
  });

  // ---- 4. Processing / unknown must not invite a second payment -----------
  section("4. A payment still in flight");

  await step("an unsettled order reports PENDING, not failure", async () => {
    // The CHEAP cart on purpose. This step only needs an order nobody has
    // settled, and spending three more high-value units here is what exhausted
    // the line on an earlier run — whereupon reserve_inventory correctly
    // refused, createCheckoutSession correctly cancelled the order, and this
    // step failed reporting "canceled" as though the poll were wrong.
    if (!lowCart) return SKIP("no cheap in-stock product");
    const { row } = await placeOrder(page, lowCart);
    const body = await page.evaluate(async (id) => {
      const r = await fetch(`/api/checkout/order-status/${encodeURIComponent(id)}`, { cache: "no-store" });
      return await r.json().catch(() => null);
    }, row.order_id);
    assert(body && body.paid === false && body.pending === true,
      `an in-flight order reported ${JSON.stringify(body)} — the page would act on a verdict it does not have`);
    // Leave it pending on purpose: the reconciler's own coverage owns what
    // happens next, and a stranded pending row is the realistic state.
    return `${row.order_number} paid:false pending:true`;
  });

  // ---- 5. The pay link cannot charge a settled order twice ---------------
  section("5. Re-opening a pay link");

  await step("a PAID order's pay link sends the shopper to their receipt, not a card form", async () => {
    if (!retryOrder || retryOrder.payment_status !== "paid") return SKIP("no paid order");
    // Anyone can arrive here after paying: a reload, the back button, an old
    // email. The page used to read only the `cs` parameter, so it rendered a
    // working card iframe for a settled order and the only thing that moved the
    // shopper off it was a client poll 2.5s later — or never, if that request
    // failed. A second payment for one purchase was two clicks away.
    await page.goto(`${BASE}/checkout/pay/${encodeURIComponent(retryOrder.order_id)}?cs=vs_stale_session`,
      { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText);
    assert(/\/order-confirmation\//.test(url),
      `a paid order's pay link stayed on ${url} instead of redirecting to the receipt`);
    assert(!/SECURE PAYMENT/i.test(text), "a paid order was still shown the secure-payment form");
    return "redirected to /order-confirmation";
  });

  await step("an UNPAID order's pay link still serves the card form", async () => {
    // The guard must be narrow. A shopper who genuinely has a payment to make
    // must still get the form — that is the working path this whole audit exists
    // to protect.
    const { row } = await placeOrder(page, lowCart);
    await page.goto(`${BASE}/checkout/pay/${encodeURIComponent(row.order_id)}?cs=${encodeURIComponent(String(row.payment_id))}`,
      { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    assert(/SECURE PAYMENT/i.test(text),
      `an unpaid order was denied the card form: ${text.slice(0, 160)}`);
    return `${row.order_number} still reaches secure payment`;
  });

  // ---- 6. What the customer sees afterwards ------------------------------
  section("6. The declined order in the customer's own account");

  await step("a declined order is not presented as a live, paid order", async () => {
    if (!declinedOrder) return SKIP("no declined order");
    // Until this was fixed the account pages asked `isUnpaid()`, whose list does
    // not contain payment_failed — so a declined order rendered with the
    // Ordered->Delivered stepper, a row reading "Total paid", a Reorder button
    // and a downloadable invoice, for a card that was never charged.
    await page.goto(`${BASE}/account/orders/${encodeURIComponent(declinedOrder.order_id)}`,
      { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await dismissConsent(page);
    const text = await page.evaluate(() => document.body.innerText);

    assert(/payment not completed/i.test(text),
      `the declined order does not say payment failed: ${text.slice(0, 200)}`);
    assert(!/\bTotal paid\b/.test(text),
      'the declined order still claims "Total paid"');
    assert(!/Download invoice/i.test(text),
      "a declined order still offers an invoice download");
    // And it must tell the shopper the one thing that actually recovers the sale.
    assert(/approve/i.test(text) && /bank/i.test(text),
      "the declined order does not mention approving a bank prompt before retrying");
    return "says payment not completed, no Total paid, no invoice, bank-approval guidance present";
  });

  await step("the declined order's invoice endpoint refuses to issue a receipt", async () => {
    if (!declinedOrder) return SKIP("no declined order");
    const result = await page.evaluate(async (id) => {
      const r = await fetch(`/account/orders/${encodeURIComponent(id)}/invoice`);
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    }, declinedOrder.order_id);
    assert(result.status === 400,
      `the invoice endpoint answered ${result.status} for a declined order`);
    assert(!/Total paid/i.test(result.body), "the refusal body still mentions Total paid");
    return `refused with ${result.status}`;
  });

  await step("a PAID order still shows its tracker and its invoice", async () => {
    if (!retryOrder || retryOrder.payment_status !== "paid") return SKIP("no paid order");
    // The other half of the guard: none of the above may cost a real customer
    // the receipt for a payment they actually made.
    await page.goto(`${BASE}/account/orders/${encodeURIComponent(retryOrder.order_id)}`,
      { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await dismissConsent(page);
    const text = await page.evaluate(() => document.body.innerText);
    assert(/\bTotal paid\b/.test(text), "a paid order no longer shows Total paid");
    assert(/Download invoice/i.test(text), "a paid order no longer offers its invoice");
    assert(!/payment not completed/i.test(text), "a paid order is described as not completed");

    const invoice = await page.evaluate(async (id) => {
      const r = await fetch(`/account/orders/${encodeURIComponent(id)}/invoice`);
      const body = await r.text();
      // The whole document, not a slice: the "Total paid" row sits well past the
      // doctype, head and stylesheet, so a truncated read reports a healthy
      // invoice as a broken one.
      return { status: r.status, hasTotalPaid: /Total paid/i.test(body), length: body.length };
    }, retryOrder.order_id);
    assert(invoice.status === 200, `the invoice answered ${invoice.status} for a PAID order`);
    assert(invoice.hasTotalPaid,
      `the paid order's invoice (${invoice.length} bytes) does not state Total paid`);
    return "tracker, Total paid and a working invoice all intact";
  });

  // ---- Give the stock back ----------------------------------------------
  //
  // EVERY ORDER THIS FILE LEAVES PENDING IS STILL HOLDING UNITS, and the holds
  // outlive the run by their full TTL. Three of them exhausted cjc-1295-2mg on
  // an earlier run, after which the next checkout was correctly refused and
  // cancelled — the harness had made the catalogue unsellable and the failure
  // looked like a product defect.
  //
  // Reclaimed through the application's OWN path rather than by writing stock
  // back by hand: age this shopper's holds past their expiry and let
  // expireStaleReservations (in /api/cron/sweep) do the release. A harness that
  // repairs inventory with its own UPDATE is a harness that can hide a broken
  // release path.
  await step("the run gives its held stock back", async () => {
    const aged = await q(
      `update inventory_reservations r
          set expires_at = now() - interval '1 hour'
        where coalesce(r.status,'active') = 'active'
          and r.order_id in (select order_id from orders
                              where customer_email = $1 and payment_status = 'pending_payment')
        returning r.order_id`, [SHOPPER],
    );
    if (!aged.rowCount) return "nothing left holding";
    const res = await fetch(`${BASE}/api/cron/sweep`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? "harness-cron-secret"}` },
    });
    await new Promise((r) => setTimeout(r, 1500));
    const stillActive = (await q(
      `select count(*)::int as n from inventory_reservations r
        where coalesce(r.status,'active') = 'active'
          and r.order_id in (select order_id from orders where customer_email = $1)`, [SHOPPER],
    )).rows[0];
    assert(Number(stillActive.n) === 0,
      `${stillActive.n} hold(s) survived the sweep (HTTP ${res.status}) — expireStaleReservations did not reclaim them`);
    return `${aged.rowCount} hold(s) reclaimed by the real sweep`;
  });

  // ---- Summary -----------------------------------------------------------
  const total = passed + failed + skipped;
  console.log(`\n${total} steps: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
  if (skips.length) {
    console.log("\nthese are NOT verified:");
    for (const s of skips) console.log(`  - ${s}`);
  }

  await browser.close();
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(`\nharness aborted: ${error.message}`);
  try { await client.end(); } catch { /* already closed */ }
  process.exit(1);
});
