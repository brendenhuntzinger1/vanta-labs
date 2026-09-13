#!/usr/bin/env node
/**
 * THE CART AND THE TILL MUST NOT DISAGREE ABOUT A ONE-PER-CUSTOMER PROMOTION.
 *
 * /api/catalog/promotions/eligibility is the only way the browser can learn
 * that THIS shopper has already used up a promotion carrying a
 * `perCustomerLimit`. quote-order knows it authoritatively, drops the promotion
 * when it is spent, and refuses an order whose client total came in BELOW its
 * own — "Altered total detected". So one disagreement, and only one, kills a
 * sale:
 *
 *     the cart applies the promotion   +   the server does not
 *
 * The audit found the endpoint budgeted at ten requests per ten minutes per IP
 * while the cart asked once per PAGE VIEW. The tenth page of an ordinary browse
 * was refused — measured, the refusal landed on /checkout — and a refused
 * lookup left the cart previewing a promotion the till was about to drop.
 *
 * This file drives the real storefront and proves both halves of the fix:
 *
 *   * ordinary browsing, several tabs and a shared address never exhaust the
 *     budget, and never make the two disagree;
 *   * the oracle AUTH-4 closed is still closed, and a customer's own lookups
 *     keep working even after the probe budget beside them is spent.
 *
 * It is adversarial where it counts. Section 5 does not simulate a busy
 * minute — it BLOCKS the endpoint outright, which is the worst case a 429, a
 * timeout and an offline moment all collapse into, and then tries to make the
 * till refuse the sale.
 *
 * Local harness only. Writes synthetic promotions and orders to the harness
 * database and cleans them up.
 *
 *   node scripts/qa-promotion-eligibility.mjs
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const PASSWORD = "HarnessPass123!";
const stamp = randomUUID().slice(0, 6);

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

let failures = 0;
let checks = 0;
let currentSection = "";
function section(title) { currentSection = title; console.log(`\n${title}`); }
function check(ok, label, detail = "") {
  checks += 1;
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The promotion under test: buy 2 get 1, once per customer, on one product. */
const PROMO_ID = `qa-elig-${stamp}`;
const PROMO_SLUG = "ghk-cu";

async function seedPromotion() {
  const promotion = {
    id: PROMO_ID,
    name: `Harness one-per-customer ${stamp}`,
    enabled: true,
    hidden: false,
    buyQuantity: 2,
    getQuantity: 1,
    rewardPercent: 100,
    eligibility: { includeSlugs: [PROMO_SLUG], excludeSlugs: [] },
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    // THE WHOLE POINT: the one rule the browser cannot evaluate for itself.
    perCustomerLimit: 1,
    maxRewardUnitsPerOrder: 1,
    stackWithCoupon: false,
    stackWithBundlePricing: false,
    priority: 100,
  };
  await q(
    `insert into admin_audit_logs (actor_user_id, action, target_table, target_id, metadata)
     values (null, 'admin_control_upsert', 'promotions', 'bxgy_promotions', $1::jsonb)`,
    [JSON.stringify({ value: [promotion] })],
  );
}

async function clearPromotions() {
  await q(
    `insert into admin_audit_logs (actor_user_id, action, target_table, target_id, metadata)
     values (null, 'admin_control_upsert', 'promotions', 'bxgy_promotions', $1::jsonb)`,
    [JSON.stringify({ value: [] })],
  );
}

async function createConfirmedCustomer(email) {
  await q(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, created_at)
     values ($1,$2,now(),now())
     on conflict (email) do update set encrypted_password = excluded.encrypted_password,
       email_confirmed_at = excluded.email_confirmed_at`,
    [email, PASSWORD],
  );
}

/** Spend this address's single redemption, the way a real paid order does. */
async function exhaustPromotionFor(email) {
  // Unique per CALL, not per stamp: every fixture address in this run ends with
  // the same stamp, so deriving the id from the address collided on the second
  // customer and aborted the run inside the fixture rather than in a check.
  const orderId = `VL-ELIG-${randomUUID().slice(0, 8)}`.toUpperCase();
  await q(
    `insert into orders (order_id, customer_email, payment_status, order_type, amount_paid, promotion_id, created_at)
     values ($1,$2,'paid','product',100,$3, now() - interval '2 days')`,
    [orderId, email, PROMO_ID],
  );
  await q(
    `insert into promotion_redemption_claims (order_id, promotion_id, customer_email, claimed_at)
     values ($1,$2,$3, now() - interval '2 days')`,
    [orderId, PROMO_ID, email],
  );
  const { rows } = await q("select bxgy_count_redemptions($1,$2) as used", [PROMO_ID, email]);
  assert(Number(rows[0].used) >= 1, `fixture did not exhaust the promotion for ${email}`);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const CHROME = process.env.QA_CHROMIUM
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));

/** Counts every eligibility call a context makes, and how it was answered. */
function watchEligibility(context) {
  const calls = [];
  context.on("response", (response) => {
    if (response.url().includes("/api/catalog/promotions/eligibility")) {
      calls.push(response.status());
    }
  });
  return calls;
}

async function newContext(browser, ip) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "x-real-ip": ip },
  });
  return context;
}

async function signIn(page, email) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const accept = page.getByRole("button", { name: /^Accept$/ });
  if (await accept.count()) await accept.first().click().catch(() => {});
  for (let i = 0; i < 6; i += 1) {
    if (await page.$("form input[type=email]")) break;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(500);
  }
  assert(await page.$("form input[type=email]"), "the sign-in form never appeared");
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", PASSWORD);
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => {}),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(1500);
  assert(!/\/account\/login/.test(page.url()), `sign-in failed for ${email}: still on ${page.url()}`);
}

/**
 * Dismiss whatever the storefront is legitimately showing over the page.
 *
 * Two real modals sit in this path and both are correct product behaviour: the
 * promotional offer sheet, and the bacteriostatic-water reminder that opens
 * after the first add to cart. A shopper closes them; so does this.
 */
async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dismissed = await page.evaluate(() => {
      const targets = [
        ...document.querySelectorAll('[aria-label="Dismiss reminder"]'),
        ...document.querySelectorAll(".vl-offer-modal-backdrop"),
      ];
      const visible = targets.filter((el) => el.getBoundingClientRect().height > 0);
      visible.forEach((el) => el.click());
      return visible.length;
    });
    if (!dismissed) return;
    await page.waitForTimeout(350);
  }
}

/** Put `quantity` of the promoted product in the cart through the real UI. */
async function fillCart(page, quantity) {
  await page.goto(`${BASE}/products/${PROMO_SLUG}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  await dismissOverlays(page);
  const add = page.getByRole("button", { name: /add to cart/i }).first();
  assert(await add.count(), "no ADD TO CART on the promoted product page");
  for (let i = 0; i < quantity; i += 1) {
    await dismissOverlays(page);
    await add.click({ timeout: 20000 });
    await page.waitForTimeout(600);
  }
  await dismissOverlays(page);
}

/** What the checkout page is showing, and therefore what it would post. */
async function readCheckoutSummary(page) {
  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const money = (testid) => {
      const el = document.querySelector(`[data-testid="${testid}"]`);
      if (!el) return null;
      const m = el.textContent.replace(/[^0-9.]/g, "");
      return m ? Number(m) : null;
    };
    const discountEl = document.querySelector('[data-testid="summary-discount"]');
    return {
      total: money("summary-total") ?? money("summary-total-mobile"),
      subtotal: money("summary-subtotal"),
      discountShown: Boolean(discountEl),
      discountText: discountEl ? discountEl.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : "",
    };
  });
}

/**
 * Place the order the way checkout/page.tsx does — the SAME expectedTotal the
 * page renders, which is the anti-tamper assertion quote-order checks.
 */
async function placeOrder(page, email, quantity, expectedTotal) {
  return page.evaluate(async ({ email: e, slug, quantity: qty, expectedTotal: total }) => {
    const r = await fetch("/api/checkout/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        items: [{ id: slug, quantity: qty }],
        customer: {
          email: e,
          fullName: "Eligibility Harness",
          address: "1 Test Way",
          city: "Tampa",
          state: "FL",
          postalCode: "33601",
          country: "US",
        },
        ...(total === null ? {} : { expectedTotal: total }),
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { email, slug: PROMO_SLUG, quantity, expectedTotal });
}

const refusedAsAltered = (result) =>
  JSON.stringify(result.body ?? {}).toLowerCase().includes("altered total");

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Promotion eligibility harness — run ${stamp}`);
  await clearPromotions();
  await seedPromotion();

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  // -------------------------------------------------------------------------
  section("1. An ordinary browse never exhausts the budget");
  // -------------------------------------------------------------------------
  const browserEmail = `elig.browse.${stamp}@example.test`;
  await createConfirmedCustomer(browserEmail);
  const ctx1 = await newContext(browser, "198.51.100.10");
  const calls1 = watchEligibility(ctx1);
  const page1 = await ctx1.newPage();
  await signIn(page1, browserEmail);

  const routes = ["/", "/products", `/products/${PROMO_SLUG}`, "/cart", "/research", "/products/bpc-157-10mg"];
  for (let i = 0; i < 24; i += 1) {
    await page1.goto(`${BASE}${routes[i % routes.length]}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page1.waitForTimeout(250);
  }
  await page1.waitForTimeout(1500);

  check(
    !calls1.includes(429),
    "twenty-four page views produce no 429 — the tenth used to be refused",
    `statuses seen: ${calls1.join(",") || "(none)"}`,
  );
  check(
    calls1.filter((s) => s === 200).length <= 3,
    "the answer is reused rather than re-asked on every page view",
    `${calls1.length} call(s) for 24 page views: ${calls1.join(",")}`,
  );

  // -------------------------------------------------------------------------
  section("2. Several tabs share one answer");
  // -------------------------------------------------------------------------
  const before2 = calls1.length;
  const tabs = await Promise.all([ctx1.newPage(), ctx1.newPage(), ctx1.newPage()]);
  await Promise.all(tabs.map((t) => t.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded", timeout: 60000 })));
  await page1.waitForTimeout(2000);
  const added2 = calls1.length - before2;
  check(added2 <= 1, "three more tabs add at most one lookup between them", `added ${added2}`);
  check(!calls1.includes(429), "and still no refusal", `statuses: ${calls1.join(",")}`);
  await Promise.all(tabs.map((t) => t.close()));

  // -------------------------------------------------------------------------
  section("3. A shared address cannot refuse an innocent customer");
  // -------------------------------------------------------------------------
  // The CGNAT case: two customers, one public IP. Under a per-IP budget the
  // second is refused for traffic the first sent.
  const neighbourEmail = `elig.neighbour.${stamp}@example.test`;
  await createConfirmedCustomer(neighbourEmail);
  const ctxNoisy = await newContext(browser, "100.64.0.55");
  const pageNoisy = await ctxNoisy.newPage();
  await signIn(pageNoisy, browserEmail);
  for (let i = 0; i < 30; i += 1) {
    await pageNoisy.evaluate(async () => {
      await fetch("/api/catalog/promotions/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: document.body.dataset.none ?? "" }),
      }).catch(() => {});
    });
  }
  const ctxInnocent = await newContext(browser, "100.64.0.55");
  const callsInnocent = watchEligibility(ctxInnocent);
  const pageInnocent = await ctxInnocent.newPage();
  await signIn(pageInnocent, neighbourEmail);
  const innocentStatus = await pageInnocent.evaluate(async (email) => {
    const r = await fetch("/api/catalog/promotions/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email }),
    });
    return r.status;
  }, neighbourEmail);
  check(
    innocentStatus === 200,
    "a second customer behind the same public address is answered normally",
    `answered ${innocentStatus} after a neighbour spent 30 lookups from the same IP`,
  );
  check(!callsInnocent.includes(429), "and sees no refusal while browsing");
  await ctxNoisy.close();
  await ctxInnocent.close();

  // -------------------------------------------------------------------------
  section("4. An exhausted promotion is never previewed, and checkout survives");
  // -------------------------------------------------------------------------
  const spentEmail = `elig.spent.${stamp}@example.test`;
  await createConfirmedCustomer(spentEmail);
  await exhaustPromotionFor(spentEmail);

  const ctx4 = await newContext(browser, "198.51.100.20");
  const calls4 = watchEligibility(ctx4);
  const page4 = await ctx4.newPage();
  await signIn(page4, spentEmail);
  await fillCart(page4, 3);
  const summary4 = await readCheckoutSummary(page4);
  check(
    summary4.total !== null,
    "the checkout summary rendered a total",
    JSON.stringify(summary4),
  );
  check(
    !/free|gift|buy 2/i.test(summary4.discountText),
    "the spent promotion is NOT shown as applied",
    `discount line read: "${summary4.discountText}"`,
  );
  const placed4 = await placeOrder(page4, spentEmail, 3, summary4.total);
  check(
    !refusedAsAltered(placed4),
    "checkout is NOT refused with 'Altered total detected'",
    `status ${placed4.status}: ${JSON.stringify(placed4.body).slice(0, 200)}`,
  );
  check(
    placed4.status === 200,
    "the order is created for a customer whose promotion is spent",
    `status ${placed4.status}: ${JSON.stringify(placed4.body).slice(0, 200)}`,
  );
  check(!calls4.includes(429), "and the lookup was never throttled during it", `statuses: ${calls4.join(",")}`);
  await ctx4.close();

  // -------------------------------------------------------------------------
  section("5. ADVERSARIAL — the endpoint is blocked outright");
  // -------------------------------------------------------------------------
  // A 429, a timeout, a dropped connection and an offline moment all arrive at
  // the cart as the same thing: no answer. This blocks the endpoint completely,
  // which is the worst of them, and then tries to make the till refuse the sale.
  const blockedEmail = `elig.blocked.${stamp}@example.test`;
  await createConfirmedCustomer(blockedEmail);
  await exhaustPromotionFor(blockedEmail);

  const ctx5 = await newContext(browser, "198.51.100.30");
  // BLOCKED BEFORE THE FIRST LOOKUP, NOT AFTER IT. Installed after sign-in this
  // proved nothing: the cart had already fetched and cached a correct answer,
  // so the promotion was withheld because it was known spent rather than
  // because it was unknown — which is section 4's case, not this one. The
  // blockedCount check below exists to catch exactly that, and did.
  let blockedCount = 0;
  await ctx5.route("**/api/catalog/promotions/eligibility", (route) => {
    blockedCount += 1;
    route.abort();
  });
  const page5 = await ctx5.newPage();
  await signIn(page5, blockedEmail);
  await fillCart(page5, 3);
  const summary5 = await readCheckoutSummary(page5);
  check(
    !/free|gift|buy 2/i.test(summary5.discountText),
    "with NO answer available the cart withholds the promotion rather than assuming it",
    `discount line read: "${summary5.discountText}"`,
  );
  const placed5 = await placeOrder(page5, blockedEmail, 3, summary5.total);
  check(
    !refusedAsAltered(placed5),
    "a shopper whose eligibility lookup is entirely broken can still buy",
    `status ${placed5.status}: ${JSON.stringify(placed5.body).slice(0, 200)}`,
  );
  check(
    placed5.status === 200,
    "the order is created even with the endpoint dead",
    `status ${placed5.status}: ${JSON.stringify(placed5.body).slice(0, 200)}`,
  );
  check(blockedCount > 0, "the block actually took effect (guards a vacuous pass)", `blocked ${blockedCount}`);
  await ctx5.close();

  // -------------------------------------------------------------------------
  section("6. An ELIGIBLE shopper still gets the promotion");
  // -------------------------------------------------------------------------
  // The mirror of section 4: withholding must be the exception, or the fix has
  // simply turned the promotion off for everyone.
  const freshEmail = `elig.fresh.${stamp}@example.test`;
  await createConfirmedCustomer(freshEmail);
  const ctx6 = await newContext(browser, "198.51.100.40");
  const page6 = await ctx6.newPage();
  await signIn(page6, freshEmail);
  await fillCart(page6, 3);
  const summary6 = await readCheckoutSummary(page6);
  check(
    summary6.discountShown,
    "a customer who has not used it sees the promotion applied",
    `summary: ${JSON.stringify(summary6)}`,
  );
  check(
    summary6.total !== null && summary6.subtotal !== null && summary6.total < summary6.subtotal,
    "and it actually comes off the total",
    `subtotal ${summary6.subtotal} total ${summary6.total}`,
  );
  const placed6 = await placeOrder(page6, freshEmail, 3, summary6.total);
  check(
    placed6.status === 200 && !refusedAsAltered(placed6),
    "the discounted order is accepted at the price the cart showed",
    `status ${placed6.status}: ${JSON.stringify(placed6.body).slice(0, 200)}`,
  );
  await ctx6.close();

  // -------------------------------------------------------------------------
  section("7. The oracle AUTH-4 closed is still closed");
  // -------------------------------------------------------------------------
  const proberEmail = `elig.prober.${stamp}@example.test`;
  await createConfirmedCustomer(proberEmail);
  const ctx7 = await newContext(browser, "203.0.113.99");
  const page7 = await ctx7.newPage();
  await signIn(page7, proberEmail);

  const probeStatuses = await page7.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 25; i += 1) {
      const r = await fetch("/api/catalog/promotions/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: `victim-${i}@example.test` }),
      });
      out.push(r.status);
    }
    return out;
  });
  const firstRefusal = probeStatuses.indexOf(429);
  check(
    firstRefusal >= 0 && firstRefusal <= 16,
    "enumerating other people's addresses is refused quickly",
    `first refusal at probe ${firstRefusal + 1} of 25: ${probeStatuses.join(",")}`,
  );

  // THE PROPERTY THE WHOLE DESIGN RESTS ON: spending the probe budget must not
  // spend the customer's own. Under a single per-IP budget it did, which is how
  // a shopper could be refused for traffic they never sent.
  const ownStatus = await page7.evaluate(async (email) => {
    const r = await fetch("/api/catalog/promotions/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email }),
    });
    return r.status;
  }, proberEmail);
  check(
    ownStatus === 200,
    "and the SAME account can still ask about its own address afterwards",
    `own-address lookup answered ${ownStatus} after the probe budget was spent`,
  );
  await ctx7.close();

  await ctx1.close();
  await browser.close();

  // -------------------------------------------------------------------------
  section("8. No order in this run was refused for a total mismatch");
  // -------------------------------------------------------------------------
  const { rows: canceled } = await q(
    `select order_id, payment_status from orders
      where customer_email like $1 and payment_status in ('canceled','cancelled')`,
    [`elig.%${stamp}@example.test`],
  );
  check(
    canceled.length === 0,
    "no order from this run sits canceled",
    canceled.map((r) => `${r.order_id}=${r.payment_status}`).join(", "),
  );
}

main()
  .catch((error) => {
    failures += 1;
    console.error(`\nFATAL in "${currentSection}": ${error.message}\n${error.stack ?? ""}`);
  })
  .finally(async () => {
    await clearPromotions().catch(() => {});
    await q("delete from promotion_redemption_claims where promotion_id = $1", [PROMO_ID]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`\n${checks} checks: ${checks - failures} passed, ${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
