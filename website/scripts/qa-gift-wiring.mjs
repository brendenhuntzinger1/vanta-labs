#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE GIFT CHAIN, FROM THE ADMIN DROPDOWN TO THE $0 LINE.
//
// qa-customer-offer.mjs proves the PRICING rules of a gift by minting tokens
// directly with SQL — the way the sweep does, but not the sweep. That leaves
// the owner's actual question unanswered: "if I pick the free GHK-Cu on the
// 60-day email, does a customer who spent $60 actually get one?"
//
// Nothing here mints a token. Every token in this file is minted by the real
// automation sweep, carried in a real rendered email, and spent by a real
// browser that clicked the link out of it. The chain under test:
//
//   admin dropdown → save → reload → the real cron sweep → issueCustomerOffer
//     → the rendered email → its CTA link → the offer cookie → checkout
//     → the reward, priced by quote-order
//
// It runs twice over that chain with two different gifts, because "can I also
// choose free shipping and a percentage off on a different win-back" is a
// separate question from "does the free product work":
//
//   winback_60 → Free GHK-Cu           → a $0 vial, only at/above $60
//   winback_30 → Free shipping + 15%   → no product, shipping waived, 15% off
//
// Local harness only.
//   node scripts/qa-gift-wiring.mjs
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/vanta-qa/gift";
const CAPTURE = process.env.QA_EMAIL_CAPTURE ?? "/tmp/vanta-qa/captured-emails.jsonl";
const CRON = process.env.QA_CRON_SECRET ?? "harness-cron-secret";
const USER = process.env.QA_ADMIN_USER ?? "vantaqa";
const PASS = process.env.QA_ADMIN_PASS ?? "HarnessAdmin123!";
const CODE = process.env.QA_ADMIN_CODE ?? "123456";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    return detail;
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
    return null;
  }
}

// Two lapsed customers per gift: one who spends enough, one who does not. The
// second is the whole point of the minimum, so it gets a real customer rather
// than a second order from the first.
const GHK_BUYER = "gift-ghk-buyer@example.test";
const GHK_SMALL = "gift-ghk-small@example.test";
const COMBO_BUYER = "gift-combo-buyer@example.test";
const EVERYONE = [GHK_BUYER, GHK_SMALL, COMBO_BUYER];

const BIG = { id: "bpc-157-10mg", quantity: 1 };     // $69 — clears the $60 minimum
const SMALL = { id: "ipamorelin-5mg", quantity: 1 }; // $59 — one dollar short of it

let browser;
let ipCounter = 0;

/** A fresh browser context on its own client IP, so the checkout rate limiter
 *  (which correctly refuses several orders a minute from one address) doesn't
 *  become the thing under test. */
async function freshContext() {
  ipCounter += 1;
  return browser.newContext({ extraHTTPHeaders: { "x-real-ip": "198.51.100." + ipCounter } });
}

/** Seed a customer who lapsed `days` ago: consented to marketing, with one
 *  paid order that old and nothing since. That is exactly what the win-back
 *  rules look for — see selectAutomationTargets. */
async function seedLapsedCustomer(email, days) {
  const orderId = `QA-GIFT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await q(
    `insert into marketing_subscribers (email, source, opted_in_at)
     values ($1, 'harness', now() - make_interval(days => $2))
     on conflict (email) do update set unsubscribed_at = null`,
    [email, days + 1],
  );
  await q(
    `insert into orders (order_id, customer_email, customer_name, payment_status, fulfillment_status,
       subtotal, shipping_amount, discount_amount, amount_paid, currency, created_at)
     values ($1, $2, 'Lapsed Customer', 'paid', 'delivered', 69, 0, 0, 69, 'USD',
       now() - make_interval(days => $3))`,
    [orderId, email, days],
  );
  return orderId;
}

/** Run the REAL scheduled sweep — the same entry point Vercel calls. */
async function runSweep() {
  const res = await fetch(`${BASE}/api/cron/sweep`, {
    headers: { authorization: `Bearer ${CRON}` },
  });
  const body = await res.json().catch(() => null);
  assert(res.status === 200, `sweep returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Read the emails written since `mark` by the capture provider. */
function capturedSince(mark) {
  if (!existsSync(CAPTURE)) return [];
  const raw = readFileSync(CAPTURE);
  return raw.subarray(Math.min(mark, raw.length)).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const captureMark = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);

/**
 * Pull the CTA link out of a rendered email.
 *
 * Deliberately NOT a lookup of the token in the database: the customer can only
 * use what actually reached their inbox, so the token this test spends has to
 * come out of the message body or it is proving something weaker.
 */
function ctaLinkFrom(html) {
  const hrefs = [...String(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const link = hrefs.find((h) => h.includes("/api/email/automation-click"));
  assert(link, `no tracked CTA link in the email; hrefs were ${JSON.stringify(hrefs.slice(0, 6))}`);
  // The renderer escapes ampersands for HTML; a browser un-escapes them.
  return link.replace(/&amp;/g, "&");
}

/** Place an order through the real checkout API, from inside the page. */
async function checkout(page, email, items) {
  await q("delete from rate_limit_hits").catch(() => {});
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
      email, fullName: "Gift Tester", address: "1 Harness Way", city: "Testville",
      state: "CA", postalCode: "90000", country: "US", phone: "5555555555",
    },
    currency: "USD",
    complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
  }]);
  assert(result.body?.orderId, `checkout failed: ${JSON.stringify(result.body).slice(0, 220)}`);
  return result.body.orderId;
}

/** The order as the ledger sees it, plus its lines. */
async function readOrder(orderId) {
  const { rows } = await q(
    "select subtotal, shipping_amount, discount_amount, amount_paid from orders where order_id = $1",
    [orderId],
  );
  // order_items keys the catalogue by product_id, which holds the SLUG — the
  // same string the offer's reward names. Aliased here so every assertion below
  // reads as the product it is about.
  const { rows: lines } = await q(
    "select product_id as slug, product_name, quantity, unit_price, line_total, unit_cost_cents"
    + " from order_items where order_id = $1 order by unit_price desc",
    [orderId],
  );
  return { ...rows[0], lines };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  // A re-runnable starting state. The gift consumes real stock, so top it up.
  await q("update products set inventory_quantity = 500, stock_status = 'In Stock' where slug in ('bpc-157-10mg','ipamorelin-5mg','ghk-cu')");
  await q("update product_doses set inventory_quantity = 500, stock_status = 'In Stock'").catch(() => {});
  await q("delete from inventory_reservations").catch(() => {});
  await q("delete from customer_offers where email = any($1)", [EVERYONE]);
  await q("delete from order_items where order_id in (select order_id from orders where customer_email = any($1))", [EVERYONE]);
  await q("delete from orders where customer_email = any($1)", [EVERYONE]);
  await q("delete from marketing_subscribers where email = any($1)", [EVERYONE]);
  await q("delete from email_send_log where recipient_email = any($1)", [EVERYONE]).catch(() => {});
  // Start with every automation off, so each round's sweep can only mail the
  // one automation that round is about.
  await q("update email_automations set enabled = false, offer_key = null");

  browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  });
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await adminContext.newPage();

  // Console noise is only meaningful once signed in. The sign-in page itself
  // probes for a session it does not have yet, and the 401 that comes back is
  // the guard working — collecting it would make every run "fail" on a correct
  // refusal. So the recorder starts after the sign-in step, and records the URL
  // as well as the text, because "401 Unauthorized" with no address is not
  // something anyone can act on.
  let watching = false;
  const consoleErrors = [];
  page.on("console", (m) => {
    if (watching && m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
  });
  page.on("response", (res) => {
    if (watching && res.status() >= 400) {
      consoleErrors.push(`${res.status()} ${res.request().method()} ${res.url().replace(BASE, "")}`);
    }
  });

  const offerBox = (key) => page.locator(`[data-testid="automation-${key}-offer"]`);
  const saveBtn = (key) => page.locator(`[data-testid="automation-${key}-save"]`);

  async function save(key) {
    await saveBtn(key).click();
    await page.getByText(/^Saved "/).waitFor({ timeout: 15_000 });
  }

  // --- the admin can attach a gift -----------------------------------------
  section("1. Choosing the gift in the admin");

  await step("signs in and reaches the automations panel", async () => {
    await page.goto(`${BASE}/vault`, { waitUntil: "domcontentloaded" });
    const inputs = page.locator("form input:visible");
    await inputs.nth(0).fill(USER);
    await inputs.nth(1).fill(PASS);
    await inputs.nth(2).fill(CODE);
    await page.getByRole("button", { name: /enter/i }).click();
    await page.waitForURL(/\/admin/, { timeout: 20_000 });
    await page.goto(`${BASE}/admin/email`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor({ timeout: 20_000 });
    watching = true;
    return page.url();
  });

  await step("the gift dropdown offers all three gifts, and 'No gift' by default", async () => {
    const options = await offerBox("winback_60").locator("option").allTextContents();
    assert(options[0] === "No gift", `first option is ${JSON.stringify(options[0])}`);
    assert(options.some((o) => /GHK-Cu/i.test(o)), `no GHK-Cu option in ${JSON.stringify(options)}`);
    assert(options.some((o) => /^Free shipping$/i.test(o)), `no plain free-shipping option in ${JSON.stringify(options)}`);
    assert(options.some((o) => /shipping.*15%/i.test(o)), `no combined option in ${JSON.stringify(options)}`);
    return options.join(" | ");
  });

  await step("attaches the free GHK-Cu to the 60-day win-back and saves", async () => {
    await offerBox("winback_60").selectOption({ label: "Free GHK-Cu" });
    await page.locator('[data-testid="automation-winback_60-cta-label"]').fill("CLAIM YOUR FREE GHK-CU");
    await page.locator('[data-testid="automation-winback_60-cta-path"]').fill("/products");
    await save("winback_60");
    await page.screenshot({ path: `${SHOTS}/admin-ghk-gift.png` });
    return "Free GHK-Cu on winback_60";
  });

  await step("it is still selected after a reload, and stored in the database", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor({ timeout: 20_000 });
    const value = await offerBox("winback_60").inputValue();
    assert(value === "winback_60_free_ghkcu", `dropdown reads ${JSON.stringify(value)} after reload`);
    const { rows } = await q("select offer_key from email_automations where key = 'winback_60'");
    assert(rows[0].offer_key === "winback_60_free_ghkcu", `database holds ${JSON.stringify(rows[0].offer_key)}`);
    return `${value} (persisted)`;
  });

  await step("no other automation picked up the gift", async () => {
    const { rows } = await q("select key, offer_key from email_automations where key <> 'winback_60' and offer_key is not null");
    assert(rows.length === 0, `${rows.map((r) => `${r.key}=${r.offer_key}`).join(", ")}`);
    return "winback_60 only";
  });

  // --- the sweep mints it ---------------------------------------------------
  section("2. The scheduled sweep mints one token per recipient");

  let ghkLink = null;
  let smallLink = null;

  await step("a real sweep mails both lapsed customers and mints their offers", async () => {
    await seedLapsedCustomer(GHK_BUYER, 70);
    await seedLapsedCustomer(GHK_SMALL, 70);
    await q("update email_automations set enabled = true where key = 'winback_60'");
    const mark = captureMark();
    const sweep = await runSweep();
    const outcome = sweep?.emailAutomations;
    assert(outcome, `sweep returned no emailAutomations result: ${JSON.stringify(sweep).slice(0, 200)}`);
    assert(!outcome.errors?.length, `sweep reported: ${JSON.stringify(outcome.errors).slice(0, 200)}`);
    assert(outcome.sent >= 2, `sweep sent ${outcome.sent}, expected at least 2 (byKey ${JSON.stringify(outcome.byKey)})`);

    const mails = capturedSince(mark).filter((m) => EVERYONE.includes(String(m.to ?? "").toLowerCase()));
    const forBuyer = mails.find((m) => String(m.to).toLowerCase() === GHK_BUYER);
    const forSmall = mails.find((m) => String(m.to).toLowerCase() === GHK_SMALL);
    assert(forBuyer, `no email captured for ${GHK_BUYER}; captured ${JSON.stringify(mails.map((m) => m.to))}`);
    assert(forSmall, `no email captured for ${GHK_SMALL}`);
    ghkLink = ctaLinkFrom(forBuyer.html);
    smallLink = ctaLinkFrom(forSmall.html);
    return `${mails.length} emails, subject "${forBuyer.subject}"`;
  });

  await step("each token is unique, single-use, and carries the $60 minimum", async () => {
    const { rows } = await q(
      `select email, offer_key, reward_kind, product_slug, min_subtotal_cents, token_hash, redeemed_at
         from customer_offers where email = any($1) order by email`,
      [[GHK_BUYER, GHK_SMALL]],
    );
    assert(rows.length === 2, `expected 2 offers, found ${rows.length}`);
    for (const row of rows) {
      assert(row.offer_key === "winback_60_free_ghkcu", `${row.email} got ${row.offer_key}`);
      assert(row.reward_kind === "free_product", `${row.email} reward kind ${row.reward_kind}`);
      assert(row.product_slug === "ghk-cu", `${row.email} product ${row.product_slug}`);
      assert(Number(row.min_subtotal_cents) === 6000, `${row.email} minimum ${row.min_subtotal_cents}`);
      assert(row.redeemed_at === null, `${row.email} arrived already redeemed`);
    }
    assert(rows[0].token_hash !== rows[1].token_hash, "two customers were sent the SAME token");
    return "2 distinct tokens, min 6000c, unredeemed";
  });

  await step("the emailed link carries the token, and the token is not the one stored", async () => {
    const url = new URL(ghkLink);
    const token = url.searchParams.get("o");
    assert(token, `no offer token on the emailed link: ${ghkLink.slice(0, 140)}`);
    const { rows } = await q("select 1 from customer_offers where token_hash = $1", [token]);
    assert(rows.length === 0, "the raw token is stored in the database — it must be hashed");
    return `${url.pathname}?…o=${token.slice(0, 8)}…`;
  });

  await step("a second sweep does not mint a second token for the same customer", async () => {
    await runSweep();
    const { rows } = await q("select count(*)::int as n from customer_offers where email = $1", [GHK_BUYER]);
    assert(rows[0].n === 1, `${GHK_BUYER} now holds ${rows[0].n} offers`);
    return "still 1";
  });

  // --- the customer spends it ----------------------------------------------
  section("3. A $60+ order gets the free vial");

  await step("clicking the emailed link lands on the store and arms the gift", async () => {
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(ghkLink, { waitUntil: "domcontentloaded" });
    assert(!shopper.url().includes("/api/email/"), `still on the tracker: ${shopper.url()}`);
    const cookies = await context.cookies();
    const offerCookie = cookies.find((c) => c.name === "vl_offer");
    assert(offerCookie, `no vl_offer cookie after the click; got ${cookies.map((c) => c.name).join(",")}`);
    assert(offerCookie.httpOnly, "the offer cookie is readable by scripts");
    const status = await shopper.evaluate(async () => {
      const res = await fetch("/api/offer/status", { cache: "no-store" });
      return res.json();
    });
    assert(status?.offer?.rewardKind === "free_product", `status says ${JSON.stringify(status).slice(0, 160)}`);
    await shopper.screenshot({ path: `${SHOTS}/ghk-landing.png` });
    await context.close();
    return `${shopper.url().replace(BASE, "")} — ${status.offer.rewardName}`;
  });

  let ghkOrderId = null;
  await step("a $69 order adds a GHK-Cu at $0, with its COGS recorded", async () => {
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(ghkLink, { waitUntil: "domcontentloaded" });
    ghkOrderId = await checkout(shopper, GHK_BUYER, [BIG]);
    const order = await readOrder(ghkOrderId);
    const gift = order.lines.find((l) => l.slug === "ghk-cu");
    assert(gift, `no GHK-Cu line; lines were ${JSON.stringify(order.lines.map((l) => l.slug))}`);
    assert(Number(gift.quantity) === 1, `gift quantity ${gift.quantity}`);
    assert(Number(gift.unit_price) === 0, `gift priced at ${gift.unit_price}`);
    assert(Number(gift.line_total) === 0, `gift line total ${gift.line_total}`);
    assert(Number(gift.unit_cost_cents) === 2288, `gift COGS recorded as ${gift.unit_cost_cents}`);
    assert(Number(order.subtotal) === 69, `subtotal ${order.subtotal} — the customer was charged for the gift`);
    await context.close();
    return `subtotal $${order.subtotal}, gift $0, COGS ${gift.unit_cost_cents}c`;
  });

  await step("the gift holds real stock, like any other line", async () => {
    // Checkout RESERVES; the products row drops when payment lands. Asserting
    // on inventory_quantity here would be asserting on the wrong step of the
    // lifecycle and would pass or fail for reasons unrelated to the gift.
    const { rows } = await q(
      "select quantity, status from inventory_reservations where order_id = $1 and slug = $2",
      [ghkOrderId, "ghk-cu"],
    );
    assert(rows.length === 1, `expected 1 GHK-Cu reservation, found ${rows.length}`);
    assert(Number(rows[0].quantity) === 1, `reserved ${rows[0].quantity}`);
    return `1 unit ${rows[0].status}`;
  });

  await step("the offer is now spent, so a second order gets nothing", async () => {
    await q("update customer_offers set redeemed_at = now(), redeemed_order_id = $2 where email = $1 and redeemed_at is null",
      [GHK_BUYER, ghkOrderId]);
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(ghkLink, { waitUntil: "domcontentloaded" });
    const second = await checkout(shopper, GHK_BUYER, [BIG]);
    const order = await readOrder(second);
    assert(!order.lines.some((l) => l.slug === "ghk-cu"), "a second free vial was granted");
    await context.close();
    return "no second vial";
  });

  section("4. The $60 minimum is real");

  await step("a $59 order gets no vial, and keeps its token", async () => {
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(smallLink, { waitUntil: "domcontentloaded" });
    const orderId = await checkout(shopper, GHK_SMALL, [SMALL]);
    const order = await readOrder(orderId);
    assert(Number(order.subtotal) === 59, `subtotal was ${order.subtotal}, expected the $59 line`);
    assert(!order.lines.some((l) => l.slug === "ghk-cu"),
      `a $${order.subtotal} order took the gift — the $60 minimum did not hold`);
    const { rows } = await q("select redeemed_at from customer_offers where email = $1", [GHK_SMALL]);
    assert(rows[0].redeemed_at === null, "the token was burned by an order that got nothing");
    await context.close();
    return `$${order.subtotal} → no gift, token intact`;
  });

  await step("the same customer at $69 does get it", async () => {
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(smallLink, { waitUntil: "domcontentloaded" });
    const orderId = await checkout(shopper, GHK_SMALL, [BIG]);
    const order = await readOrder(orderId);
    assert(order.lines.some((l) => l.slug === "ghk-cu" && Number(l.unit_price) === 0),
      `no free vial at $${order.subtotal}`);
    await context.close();
    return `$${order.subtotal} → free vial`;
  });

  // --- the other gift, on a different automation ---------------------------
  section("5. Free shipping + 15% off, on a different win-back");

  await step("attaches the combined gift to the 30-day win-back and saves", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor({ timeout: 20_000 });
    await offerBox("winback_30").selectOption({ label: "Free shipping + 15% off" });
    await page.locator('[data-testid="automation-winback_30-cta-label"]').fill("SEE WHAT'S NEW");
    await page.locator('[data-testid="automation-winback_30-cta-path"]').fill("/products");
    await save("winback_30");
    await page.screenshot({ path: `${SHOTS}/admin-combo-gift.png` });
    return "Free shipping + 15% off on winback_30";
  });

  await step("both automations keep their own gift after a reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor({ timeout: 20_000 });
    const thirty = await offerBox("winback_30").inputValue();
    const sixty = await offerBox("winback_60").inputValue();
    assert(thirty === "winback_60_free_shipping_15", `winback_30 reads ${JSON.stringify(thirty)}`);
    assert(sixty === "winback_60_free_ghkcu", `winback_60 lost its gift, reads ${JSON.stringify(sixty)}`);
    return `winback_30=${thirty}, winback_60=${sixty}`;
  });

  let comboLink = null;
  await step("the sweep mints a combined token for a 30-day lapsed customer", async () => {
    await seedLapsedCustomer(COMBO_BUYER, 35);
    await q("update email_automations set enabled = false where key = 'winback_60'");
    await q("update email_automations set enabled = true where key = 'winback_30'");
    const mark = captureMark();
    await runSweep();
    const mail = capturedSince(mark).find((m) => String(m.to ?? "").toLowerCase() === COMBO_BUYER);
    assert(mail, `no email for ${COMBO_BUYER}`);
    comboLink = ctaLinkFrom(mail.html);
    const { rows } = await q(
      "select offer_key, reward_kind, product_slug, percent_off, min_subtotal_cents from customer_offers where email = $1",
      [COMBO_BUYER],
    );
    assert(rows.length === 1, `expected 1 offer, found ${rows.length}`);
    assert(rows[0].reward_kind === "free_shipping_percent", `reward kind ${rows[0].reward_kind}`);
    assert(Number(rows[0].percent_off) === 15, `percent ${rows[0].percent_off}`);
    assert(rows[0].product_slug === null, `a shipping gift carries product ${rows[0].product_slug}`);
    return `${rows[0].offer_key}, ${rows[0].percent_off}% + shipping, min ${rows[0].min_subtotal_cents}c`;
  });

  await step("an ordinary order pays shipping, so the gift has something to waive", async () => {
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const orderId = await checkout(shopper, "gift-control@example.test", [SMALL]);
    const order = await readOrder(orderId);
    assert(Number(order.shipping_amount) > 0, `the control order shipped free at $${order.subtotal}`);
    await context.close();
    return `$${order.shipping_amount} shipping on a $${order.subtotal} order`;
  });

  await step("the combined gift waives shipping AND takes 15% off", async () => {
    const context = await freshContext();
    const shopper = await context.newPage();
    await shopper.goto(comboLink, { waitUntil: "domcontentloaded" });
    const status = await shopper.evaluate(async () => {
      const res = await fetch("/api/offer/status", { cache: "no-store" });
      return res.json();
    });
    assert(status?.offer?.rewardKind === "free_shipping_percent", `status ${JSON.stringify(status).slice(0, 160)}`);
    const orderId = await checkout(shopper, COMBO_BUYER, [SMALL]);
    const order = await readOrder(orderId);
    assert(Number(order.shipping_amount) === 0, `shipping was $${order.shipping_amount}`);
    const expected = Math.round(Number(order.subtotal) * 0.15 * 100) / 100;
    assert(Math.abs(Number(order.discount_amount) - expected) < 0.02,
      `discount was $${order.discount_amount}, expected about $${expected}`);
    assert(!order.lines.some((l) => Number(l.unit_price) === 0),
      "a shipping gift added a free product line");
    await context.close();
    return `subtotal $${order.subtotal}, shipping $0, discount $${order.discount_amount}`;
  });

  await step("the cart drawer names it, at 390x844, without doubling 'free'", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-real-ip": "198.51.100.99" },
    });
    const shopper = await context.newPage();
    await shopper.goto(comboLink, { waitUntil: "domcontentloaded" });
    await shopper.goto(`${BASE}/products/ipamorelin-5mg`, { waitUntil: "domcontentloaded" });
    const guest = shopper.getByRole("button", { name: /continue as guest/i });
    if (await guest.count()) {
      for (const box of await shopper.locator('input[type="checkbox"]:visible').all()) {
        if (!(await box.isChecked())) await box.check();
      }
      await guest.click();
      await shopper.waitForTimeout(1200);
    }
    await shopper.getByRole("button", { name: /add to cart/i }).first().click();
    await shopper.getByRole("button", { name: /open cart/i }).click();
    const banner = shopper.locator('[data-testid="offer-banner"]');
    await banner.waitFor({ timeout: 15_000 });
    const text = (await banner.innerText()).replace(/\s+/g, " ").trim();
    assert(/shipping/i.test(text), `banner does not mention shipping: ${text}`);
    assert(/15%/.test(text), `banner does not mention the percentage: ${text}`);
    assert(!/free free/i.test(text), `banner doubles the word free: ${text}`);
    await shopper.screenshot({ path: `${SHOTS}/combo-cart-390.png` });
    await context.close();
    return text.slice(0, 80);
  });

  section("6. The two gifts stay in their own lanes");

  await step("the GHK-Cu order took no percentage discount", async () => {
    const order = await readOrder(ghkOrderId);
    assert(Number(order.discount_amount) === 0,
      `a product gift also discounted $${order.discount_amount}`);
    return "$0 discount, as expected for a product gift";
  });

  await step("no console or network errors on the admin panel", async () => {
    // /api/account/me 401s here on purpose. The admin pages render the site
    // chrome, which asks whether a CUSTOMER is signed in; an admin session is
    // not one, and the refusal is the answer. Everything else counts.
    const noisy = [...new Set(consoleErrors)]
      .filter((e) => !/favicon|ResizeObserver/i.test(e))
      .filter((e) => !/401 GET \/api\/account\/me/.test(e))
      .filter((e) => !/status of 401/.test(e));
    assert(noisy.length === 0, `${noisy.length} distinct: ${noisy.join(" | ").slice(0, 260)}`);
    return "clean";
  });

  await adminContext.close();
  await browser.close();

  // Leave the harness as it was found: gifts cost stock and mail real people.
  await q("update email_automations set enabled = false, offer_key = null");

  const failed = results.filter((r) => r.status === "fail");
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ${f.section} → ${f.name}\n    ${f.detail}`);
  }
  console.log(`screenshots: ${SHOTS}`);
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
