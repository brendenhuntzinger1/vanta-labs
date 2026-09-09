#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE REPLACED CART-RECOVERY STAGES, END TO END, AS EACH SHOPPER GETS THEM.
//
// The unit tests prove the sweep picks the right template and cannot send
// twice. They cannot prove the thing the owner is actually buying: that a real
// browser, clicking the real link out of the real rendered email, ends up
// looking at a cart priced the way the email said it would be.
//
// So nothing here is stubbed downstream of the sweep. The three production
// carts are reproduced exactly — same ids, same emails, same line items, same
// variants, same real prices and product costs — the real cron endpoint runs,
// the message is read out of the SMTP sink, and its CTA is clicked by Chromium.
//
// The carts are four DIFFERENT shapes of the same gift, which is the
// whole reason to run all of them rather than one:
//
//   Heath    10 x HGH GH-191, no Recon Water in the cart
//            -> two vials are ADDED. Buy 2 Get 1 must still free three of his
//               ten, and the bundle tier must still lose to it.
//   Heidi    GLP-3 10mg + 2 x Recon Water
//            -> her own two are ABSORBED, not duplicated. The promotion must
//               then see one paid unit, not three, and grant nothing.
//   Candace  1 x B12, a small cart
//            -> two vials are ADDED on an order well under the others. Proves
//               the $35 floor admits her rather than silently withholding a
//               gift her email promised.
//
// Local harness only. Never point this at production.
//   node scripts/qa-cart-recovery-override.mjs
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "https://127.0.0.1:3443";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/vanta-qa/override";
const CAPTURE = process.env.QA_EMAIL_CAPTURE ?? "/tmp/vanta-qa/captured-emails.jsonl";
const CRON = process.env.QA_CRON_SECRET ?? "harness-cron-secret";

if (/supabase\.co|vantalabs/i.test(DB)) {
  console.error("refusing to run against anything but the local harness");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });
// The harness front proxy serves a self-signed certificate. Chromium is told to
// ignore it per-context; node's own fetch needs telling separately, or the cron
// call fails with a bare "fetch failed" that reads like a dead server.
if (BASE.startsWith("https://127.0.0.1")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);
let browser;
let failures = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function step(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const detail = await fn();
    console.log(`ok${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL\n      ${error.message}`);
  }
}

// --- the real catalogue rows these three carts refer to ---------------------
// Prices and product costs are the live production values, because the whole
// point is to reproduce the totals the shopper will actually be quoted.
const PRODUCTS = [
  { slug: "hgh-gh-191", name: "HGH GH-191", doses: [
    { id: "b33a274e-199b-43e0-97cd-0e3e6fe33df8", label: "24iu", cents: 6499, cost: 1200, qty: 40, isDefault: true },
  ] },
  { slug: "glp-3", name: "GLP-3", doses: [
    { id: "55544dc9-b7b6-4bf1-a2f4-50b62d0e6e49", label: "10mg", cents: 6999, cost: 1047, qty: 36, isDefault: true },
    { id: "fcea0b5c-62f8-4e28-b9d0-a4898c28303c", label: "30mg", cents: 16999, cost: 1875, qty: 49 },
  ] },
  { slug: "bac-water", name: "Recon Water (0.9% Benzyl Alcohol)", doses: [
    { id: "06126d6b-bbc4-4ae3-bc99-d6a4119aa514", label: "10mL", cents: 1499, cost: 143, qty: 92, isDefault: true, tracked: false },
  ] },
  { slug: "b12", name: "B12", doses: [
    { id: "c8ea4006-2e7d-4852-a74c-786d5a52da87", label: "10mL", cents: 4999, cost: 595, qty: 19, isDefault: true },
  ] },
];

const CARTS = [
  {
    who: "Heath",
    subjectItem: "HGH GH-191",
    stage: "t24h",
    id: "8e14335e-341d-4917-a8cd-e70c5a3ffb4f",
    email: "heathgreve402@gmail.com",
    name: "Heath Greve",
    valueCents: 51990,
    items: [{ slug: "hgh-gh-191", name: "HGH GH-191", quantity: 10, unitPrice: 64.99, variantId: "b33a274e-199b-43e0-97cd-0e3e6fe33df8" }],
    // Buy 2 Get 1 frees the three cheapest of ten units: 7 x $64.99.
    expectMerchandise: 454.93,
    expectShipping: 0,
    expectFreeBac: 2,
    expectBacUnits: 2,
    expectPromotion: true,
  },
  {
    who: "Heidi",
    subjectItem: "GLP-3",
    stage: "t24h",
    id: "8d961db8-715a-4e9c-ad62-ddaf6d270811",
    email: "heidi.lrsn@gmail.com",
    name: "Heidi",
    valueCents: 9847,
    items: [
      { slug: "bac-water", name: "Recon Water (0.9% Benzyl Alcohol)", quantity: 2, unitPrice: 14.99, variantId: "06126d6b-bbc4-4ae3-bc99-d6a4119aa514" },
      { slug: "glp-3", name: "GLP-3", quantity: 1, unitPrice: 69.99, variantId: "55544dc9-b7b6-4bf1-a2f4-50b62d0e6e49" },
    ],
    // Both vials absorbed, so she pays for the GLP-3 alone — and the promotion
    // now sees ONE paid unit rather than three, so it grants nothing.
    expectMerchandise: 69.99,
    expectShipping: 0,
    expectFreeBac: 2,
    expectBacUnits: 2,
    expectPromotion: false,
  },
  {
    who: "Nikki",
    subjectItem: "GLP-3",
    id: "0f6c55a8-4b1c-4f8d-891a-f55344aec180",
    email: "nikkir1072@gmail.com",
    name: "Nikki",
    valueCents: 48416,
    stage: "t72h",
    items: [
      { slug: "glp-3", name: "GLP-3", quantity: 3, unitPrice: 169.99, variantId: "fcea0b5c-62f8-4e28-b9d0-a4898c28303c" },
      { slug: "bac-water", name: "Recon Water (0.9% Benzyl Alcohol)", quantity: 1, unitPrice: 14.99, variantId: "06126d6b-bbc4-4ae3-bc99-d6a4119aa514" },
    ],
    // THE PARTIAL-ABSORB SHAPE, and the only cart that has it: her one vial is
    // freed and a second is added. Her three GLP-3 then stand alone as the paid
    // units, which is exactly one Buy 2 Get 1 group — so the promotion frees one
    // of them at full list ($169.99), beating the three-unit bundle tier.
    expectMerchandise: 339.98,
    expectShipping: 0,
    expectFreeBac: 2,
    expectBacUnits: 2,
    expectPromotion: true,
  },
  {
    who: "Candace",
    subjectItem: "B12",
    stage: "t24h",
    id: "70c07050-1b3b-43d2-84bc-703dbb6e173f",
    email: "candace.roush@gmail.com",
    name: "Candace Roush",
    valueCents: 4999,
    items: [{ slug: "b12", name: "B12", quantity: 1, unitPrice: 49.99, variantId: "c8ea4006-2e7d-4852-a74c-786d5a52da87" }],
    expectMerchandise: 49.99,
    expectShipping: 0,
    expectFreeBac: 2,
    expectBacUnits: 2,
    expectPromotion: false,
  },
];

async function seedCatalogue() {
  for (const product of PRODUCTS) {
    const { rows } = await q(
      `insert into products (slug, name, category, description, price_cents, stock_status,
         is_active, is_enabled, is_published, is_archived, image_url)
       values ($1, $2, 'Research Peptides', 'harness fixture', $3, 'In Stock', true, true, true, false, '/placeholder.png')
       on conflict (slug) do update set name = excluded.name, price_cents = excluded.price_cents,
         stock_status = 'In Stock', is_active = true, is_enabled = true,
         is_published = true, is_archived = false
       returning id`,
      [product.slug, product.name, product.doses[0].cents],
    );
    const productId = rows[0].id;
    for (const dose of product.doses) {
      await q(
        `insert into product_doses (id, product_id, label, slug_suffix, sku, price_cents, product_cost_cents,
           inventory_quantity, reserved_quantity, track_inventory, stock_status, is_default, is_enabled, position)
         values ($1, $2, $3, $10, $4, $5, $6, $7, 0, $8, 'In Stock', $9, true, 0)
         on conflict (id) do update set price_cents = excluded.price_cents,
           product_cost_cents = excluded.product_cost_cents, inventory_quantity = excluded.inventory_quantity,
           reserved_quantity = 0, track_inventory = excluded.track_inventory, stock_status = 'In Stock',
           is_default = excluded.is_default, is_enabled = true`,
        [dose.id, productId, dose.label, `${product.slug}-${dose.label}`, dose.cents, dose.cost,
          dose.qty, dose.tracked !== false, dose.isDefault === true, dose.label.toLowerCase()],
      );
    }
  }
}

/** Buy 2 Get 1 Free, exactly as the live control centre has it configured. */
async function seedPromotion() {
  const promotions = [{
    id: "buy-2-get-1-free", name: "Buy 2 Get 1 Free", enabled: true, hidden: false, priority: 50,
    startsAt: null, endsAt: "2026-09-15T03:59:59.000Z", buyQuantity: 2, getQuantity: 1, rewardPercent: 100,
    eligibility: { includeSlugs: [], excludeSlugs: [] },
    maxRedemptions: null, perCustomerLimit: null, maxRewardUnitsPerOrder: null,
    stackWithCoupon: false, stackWithBundlePricing: false,
  }];
  await q(
    `insert into admin_audit_logs (action, target_table, target_id, metadata, created_at)
     values ('admin_control_upsert', 'promotions', 'bxgy_promotions', $1, now())`,
    [JSON.stringify({ value: promotions })],
  );
  // Production runs free shipping sitewide, so the harness must too — the whole
  // point of these totals is that they are the totals the shopper will see.
  await q(
    `insert into admin_audit_logs (action, target_table, target_id, metadata, created_at)
     values ('admin_control_upsert', 'shipping', 'free_shipping_sitewide', $1, now())`,
    [JSON.stringify({ value: true })],
  );
  for (const [key, value] of [["t30m_enabled", true], ["t12h_enabled", true], ["t24h_enabled", true], ["t72h_enabled", true]]) {
    await q(
      `insert into admin_audit_logs (action, target_table, target_id, metadata, created_at)
       values ('admin_control_upsert', 'cart_recovery', $1, $2, now())`,
      [key, JSON.stringify({ value })],
    );
  }
}

/**
 * Put each cart into its t12h window and give it the t30m it already had.
 *
 * Thirteen hours since the last change is inside t12h (12h-24h), and the t30m
 * row is what production already holds — without it the sweep would select
 * t30m instead and the override would never be reached.
 */
async function seedCarts() {
  await q("delete from abandoned_cart_emails");
  await q("delete from abandoned_carts");
  await q("delete from cart_recovery_stage_overrides");
  await q("delete from customer_offers");
  await q("delete from email_send_log");
  for (const cart of CARTS) {
    // Age the cart into ITS OWN stage's window, and claim every stage before
    // it — otherwise the sweep picks the earliest unclaimed stage instead.
    const ageHours = cart.stage === "t72h" ? 73 : 25;
    const priorStages = cart.stage === "t72h" ? ["t30m", "t12h", "t24h"] : ["t30m", "t12h"];
    await q(
      `insert into abandoned_carts (id, session_id, email, customer_name, items, cart_value_cents,
         first_seen_at, last_updated_at, status, created_at)
       values ($1, $2, $3, $4, $5, $6, now() - make_interval(hours => $7), now() - make_interval(hours => $7), 'active', now() - make_interval(hours => $7))`,
      [cart.id, `sess-${cart.id}`, cart.email, cart.name, JSON.stringify(cart.items), cart.valueCents, ageHours],
    );
    for (const [index, stage] of priorStages.entries()) {
      await q(
        `insert into abandoned_cart_emails (abandoned_cart_id, stage, sent_at)
         values ($1, $2, now() - make_interval(hours => $3))`,
        [cart.id, stage, ageHours - index - 1],
      );
    }
  }
}

async function seedOverrides() {
  for (const cart of CARTS) {
    await q(
      `insert into cart_recovery_stage_overrides (abandoned_cart_id, stage, offer_key, perks, note)
       values ($1, $2, 'labor_day_bac_water_2', $3, 'harness')`,
      [cart.id, cart.stage, JSON.stringify(["2-day shipping, on us"])],
    );
  }
}

async function runSweep() {
  const res = await fetch(`${BASE}/api/cron/sweep`, { headers: { authorization: `Bearer ${CRON}` } });
  const body = await res.json().catch(() => null);
  assert(res.status === 200, `sweep returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const captureMark = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);
function capturedSince(mark) {
  if (!existsSync(CAPTURE)) return [];
  // Byte offset, decoded after slicing: statSync gives BYTES and String.slice
  // counts UTF-16 units, so slicing the decoded string drifts on every em dash.
  return readFileSync(CAPTURE).subarray(Math.min(mark, statSync(CAPTURE).size)).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * The CTA out of the message body.
 *
 * Deliberately not a database lookup of the token: the shopper can only spend
 * what actually reached their inbox, so a test that reads the token from
 * customer_offers is proving something weaker than the thing being claimed.
 */
function ctaLinkFrom(html) {
  const hrefs = [...String(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const link = hrefs.find((h) => h.includes("/api/email/track/click"));
  assert(link, `no tracked CTA in the email; hrefs were ${JSON.stringify(hrefs.slice(0, 6))}`);
  return link;
}

let ipCounter = 0;
async function freshContext() {
  ipCounter += 1;
  return browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "x-real-ip": `203.0.113.${ipCounter}` },
  });
}

async function passAgeGate(page) {
  const guest = page.getByRole("button", { name: /continue as guest/i });
  if (!(await guest.count())) return false;
  for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
    if (!(await box.isChecked())) await box.check();
  }
  await guest.click();
  await page.waitForTimeout(1000);
  return true;
}

/** Quote the restored cart through the REAL pricing endpoint, as the page. */
async function onSite(page) {
  // page.evaluate's fetch resolves relative URLs against the page's origin, so
  // an un-navigated page (about:blank) throws "Failed to parse URL" — which
  // reads like a broken endpoint and is really a browser that is nowhere.
  if (!page.url().startsWith(BASE)) {
    await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
}

async function quote(page, { email, items }) {
  await q("delete from rate_limit_hits").catch(() => {});
  await onSite(page);
  return page.evaluate(async ([payload]) => {
    const res = await fetch("/api/checkout/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [{
    items,
    customer: {
      email, fullName: "Cart Owner", address: "1 Harness Way", city: "Testville",
      state: "CA", postalCode: "90000", country: "US", phone: "5555555555",
    },
    currency: "USD",
    complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
  }]);
}

/** Place the order for real, so order_items can be read as the pick list. */
async function placeOrder(page, { email, items }) {
  await q("delete from rate_limit_hits").catch(() => {});
  await onSite(page);
  return page.evaluate(async ([payload]) => {
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
      email, fullName: "Cart Owner", address: "1 Harness Way", city: "Testville",
      state: "CA", postalCode: "90000", country: "US", phone: "5555555555",
    },
    currency: "USD",
    complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
  }]);
}

async function main() {
  console.log("\nTHE REPLACED STAGES, END TO END\n");

  await step("seed the real catalogue rows", seedCatalogue);
  await step("configure Buy 2 Get 1 as production has it", seedPromotion);
  await step("reproduce each cart at its own stage", seedCarts);
  await step("add one override per cart, and nothing else", seedOverrides);

  await step("EXACTLY the named carts are eligible for a replaced stage", async () => {
    const { rows } = await q("select count(*)::int as n from cart_recovery_stage_overrides");
    assert(rows[0].n === CARTS.length, `expected ${CARTS.length} override rows, found ${rows[0].n}`);
  });

  const mark = captureMark();
  let sweep;
  await step("run the real cron sweep", async () => {
    sweep = await runSweep();
    const cart = sweep?.abandonedCarts ?? sweep?.cart ?? sweep;
    return `sent: ${JSON.stringify(cart)}`;
  });

  const emails = capturedSince(mark);
  const byRecipient = new Map();
  for (const message of emails) {
    const to = String(message.to ?? message.recipient ?? "").toLowerCase();
    if (!byRecipient.has(to)) byRecipient.set(to, message);
  }

  await step("one message per cart, and no others", async () => {
    const relevant = emails.filter((m) => CARTS.some((c) => String(m.to ?? "").toLowerCase().includes(c.email)));
    assert(relevant.length === CARTS.length, `expected ${CARTS.length} messages, captured ${relevant.length}: ${emails.map((m) => m.to).join(", ")}`);
  });

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  });

  for (const cart of CARTS) {
    console.log(`\n  --- ${cart.who} ---`);
    const message = byRecipient.get(cart.email);

    await step("received the gift message, not the generic reminder", async () => {
      assert(message, `no message captured for ${cart.email}`);
      // The subject has to name what THIS shopper left, not a generic line.
      assert(
        message.subject.includes(cart.subjectItem) && message.subject.includes("2 free Recon Water"),
        `subject was ${JSON.stringify(message.subject)}`,
      );
      assert(message.subject.length <= 60, `subject is ${message.subject.length} chars, too long to survive a phone`);
      // Matched on the generic template's own headline, not on a stray phrase:
      // "still saved" appears in the gift copy too, quite legitimately, and
      // matching that made this assertion fire on the right email.
      assert(!/Still here when you are/i.test(String(message.html)), "the generic reminder body was sent");
      assert(/on us/i.test(String(message.html)), "this is not the gift body");
      return message.subject;
    });

    await step("the message states the gift, the perks and the enforced terms", async () => {
      const body = `${message.html} ${message.text ?? ""}`;
      assert(/2 free Recon Water/i.test(body), "the gift is not stated");
      assert(/\$35 or more/.test(body), "the minimum the till enforces is not stated");
      assert(/Free shipping/i.test(body), "free shipping is not stated");
      assert(/2-day shipping, on us/i.test(body), "the expedited-shipping promise is not stated");
      assert(/Buy 2 Get 1 Free/i.test(body), "the live promotion is not mentioned");
      assert(/runs through September 14/i.test(body), "the sale's real end date is not stated");
      assert(/limited-time/i.test(body), "the sale is not described as limited-time");
      assert(/reserved for you through September/i.test(body), "the gift's own expiry is not stated");
    });

    await step("claims nothing the store has not actually committed to", async () => {
      // The rule is not "never mention shipping speed" — it is "never invent".
      // A perk RECORDED ON THE OVERROW ROW is an operator's deliberate promise
      // about this order, and it is stated verbatim; anything else in this list
      // would be the template speaking for the store, which is the thing that
      // gets a brand into trouble.
      const copy = `${message.subject} ${message.text ?? message.html}`.toLowerCase();
      const recorded = ["2-day shipping, on us"].map((perk) => perk.toLowerCase());
      // "limited-time" is allowed ONLY because the live promotion now carries an
      // endsAt the checkout enforces. Assert the date is really there rather
      // than trusting the adjective, which is the half that can lie.
      if (copy.includes("limited-time")) {
        assert(/runs through [a-z]+ \d{1,2}/.test(copy), "says limited-time without naming the date it ends");
      }
      const invented = [
        "last chance", "hurry", "act now",
        "while supplies last", "selling out", "only a few",
        "guaranteed", "purity", "99%", "sterile", "fda",
        "overnight", "next day", "same day",
      ];
      for (const banned of invented) {
        assert(!copy.includes(banned), `copy claims "${banned}"`);
      }
      // Any shipping-speed wording that IS present must be one of the recorded
      // promises, character for character.
      for (const speed of ["2-day", "two-day", "2 day"]) {
        if (!copy.includes(speed)) continue;
        assert(
          recorded.some((perk) => perk.includes(speed) && copy.includes(perk)),
          `copy says "${speed}" but no recorded perk says it verbatim`,
        );
      }
      return "no invented claims; the shipping promise is the recorded one";
    });

    const context = await freshContext();
    const page = await context.newPage();

    await step("the CTA lands on THIS cart's restore link, not the homepage", async () => {
      const link = ctaLinkFrom(message.html).replace("https://example.test", BASE).replace("http://localhost:3000", BASE);
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // A SIGNED-OUT SHOPPER MEETS THE ACCESS WALL FIRST, and that is correct
      // rather than a broken link: the storefront is account-only by design.
      // What matters is that the wall carries them on to THEIR cart and not to
      // the homepage, so the cart id has to survive in `next`.
      const landed = decodeURIComponent(page.url());
      assert(landed.includes(cart.id), `landed on ${landed} — this cart's id did not survive`);
      assert(
        landed.includes("/cart/restore") || landed.includes("/account/login"),
        `landed somewhere unexpected: ${landed}`,
      );
      const cookies = await context.cookies();
      assert(cookies.some((c) => c.name === "vl_offer" && c.value), "the offer cookie was not set by the click");
      return landed.replace(BASE, "");
    });

    await step("the entitlement is bound to this shopper and grants two units", async () => {
      const { rows } = await q(
        "select offer_key, product_slug, quantity, min_subtotal_cents from customer_offers where email = $1",
        [cart.email],
      );
      assert(rows.length === 1, `expected one entitlement, found ${rows.length}`);
      assert(rows[0].offer_key === "labor_day_bac_water_2", `offer_key ${rows[0].offer_key}`);
      assert(rows[0].product_slug === "bac-water", `product_slug ${rows[0].product_slug}`);
      assert(Number(rows[0].quantity) === 2, `quantity ${rows[0].quantity}`);
      return `${rows[0].quantity} x ${rows[0].product_slug}, min $${rows[0].min_subtotal_cents / 100}`;
    });

    await passAgeGate(page);
    await step("sign in, because the storefront is account-only by design", async () => {
      // These three all hold confirmed production accounts, so this is what
      // they will actually do: the CTA hits the access wall, they sign in, and
      // `next=` carries them on to their own restored cart.
      await onSite(page);
      const created = await page.evaluate(async ([email]) => {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email, password: "HarnessShopper123!", fullName: "Cart Owner",
            ageConfirmed: true, researchUseOnly: true, acceptedTerms: true,
          }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, [cart.email]);
      assert(created.status < 500, `signup returned ${created.status}`);
      // The harness holds signups at "confirm your email"; production accounts
      // are already confirmed, so confirm here rather than test a state the
      // three shoppers are not in.
      await q("update auth.users set email_confirmed_at = now(), confirmed_at = now() where lower(email) = $1", [cart.email]).catch(() => {});
      await q("update auth.users set email_confirmed_at = now() where lower(email) = $1", [cart.email]).catch(() => {});
      // Sign in through the FORM, because that is where it happens: the browser's
      // Supabase client talks to GoTrue and only then posts the token to
      // /api/auth/session, which is why that endpoint answers "Missing access
      // token" to a bare email and password.
      await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const hasField = async () => (await page.$("form input[type=email]")) !== null;
      for (let attempt = 0; attempt < 6 && !(await hasField()); attempt += 1) {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
          if (b) b.click();
        });
        await page.waitForTimeout(700);
      }
      assert(await hasField(), "the access portal never opened the email sign-in form");
      await page.fill("form input[type=email]", cart.email);
      await page.fill("form input[type=password]", "HarnessShopper123!");
      await page.evaluate(() => {
        const form = document.querySelector("form");
        const submit = form?.querySelector('button[type=submit]') ?? form?.querySelector("button");
        if (submit) submit.click();
      });
      await page.waitForTimeout(3500);
      assert(
        !/\/account\/login/.test(new URL(page.url()).pathname),
        `still on the login page after submitting: ${page.url()}`,
      );
      return "signed in";
    });

    const items = cart.items.map((item) => ({
      id: item.variantId ? `${item.slug}::${item.variantId}` : item.slug,
      quantity: item.quantity,
    }));
    let quoted;
    await step("the restored cart prices exactly as the email implies", async () => {
      const result = await quote(page, { email: cart.email, items });
      assert(result.status === 200, `quote returned ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`);
      assert(result.body?.ok, `quote declined: ${JSON.stringify(result.body).slice(0, 200)}`);
      quoted = result.body.quote;
      // MERCHANDISE AND SHIPPING ARE CHECKED SEPARATELY. The store ships free
      // over $200, so Heath's order carries no fee and the two smaller ones
      // carry $15 — which the email is silent about, and must stay silent
      // about, because it is not a claim the gift changes.
      const merchandise = Number(quoted.subtotal) - Number(quoted.discountAmount ?? 0);
      const shipping = Number(quoted.shipping ?? 0);
      const total = Number(quoted.expectedTotal);
      assert(
        Math.abs(merchandise - cart.expectMerchandise) < 0.01,
        `expected $${cart.expectMerchandise} of merchandise, got $${merchandise.toFixed(2)}`,
      );
      assert(
        Math.abs(shipping - cart.expectShipping) < 0.01,
        `expected $${cart.expectShipping} shipping, got $${shipping.toFixed(2)}`,
      );
      assert(
        Math.abs(total - (cart.expectMerchandise + cart.expectShipping)) < 0.01,
        `expected $${(cart.expectMerchandise + cart.expectShipping).toFixed(2)} total, quoted $${total}`,
      );
      return `$${merchandise.toFixed(2)} goods + $${shipping.toFixed(2)} shipping = $${total.toFixed(2)}`;
    });

    await step("the cart shows the free vials as a gift, before checkout", async () => {
      const units = (quoted.giftLines ?? []).reduce((sum, line) => sum + Number(line.quantity), 0);
      assert(units === cart.expectFreeBac, `expected ${cart.expectFreeBac} free units, found ${units}`);
      assert(
        (quoted.giftLines ?? []).every((line) => /bac water/i.test(line.name)),
        `a gift line is not Recon Water: ${JSON.stringify(quoted.giftLines)}`,
      );
      return `${units} free Recon Water shown`;
    });

    await step("the promotion behaves as it should for this cart's shape", async () => {
      const discount = Number(quoted.discountAmount ?? 0);
      const applied = discount > 0;
      assert(
        applied === cart.expectPromotion,
        `discount was $${discount} (${quoted.discountLabel ?? "no label"}), expected ${cart.expectPromotion ? "a promotion" : "none"}`,
      );
      return applied ? `$${discount.toFixed(2)} off (${quoted.discountLabel})` : "no promotion, correctly";
    });

    // THE PICK LIST IS THE REAL PROOF, and it is the only one that answers
    // "will the two vials actually be packed and shipped". A quote is a
    // promise; order_items is what the warehouse reads.
    await step("a real order records the free vials as $0 lines the warehouse will see", async () => {
      const result = await placeOrder(page, { email: cart.email, items });
      assert(result.body?.orderId, `checkout failed: ${JSON.stringify(result.body).slice(0, 220)}`);
      const { rows } = await q(
        "select product_id, product_name, quantity, unit_price, line_total, unit_cost_cents from order_items where order_id = $1 order by product_name",
        [result.body.orderId],
      );
      const bac = rows.filter((r) => String(r.product_id).split("::")[0] === "bac-water");
      const bacUnits = bac.reduce((sum, r) => sum + Number(r.quantity), 0);
      assert(bacUnits === cart.expectBacUnits, `pick list holds ${bacUnits} Recon Water, expected ${cart.expectBacUnits}`);
      // Every vial is free: Heidi's two are the ones that would otherwise be
      // charged for while two more were added alongside them.
      for (const line of bac) {
        assert(Number(line.unit_price) === 0, `a Recon Water line is charged $${line.unit_price}`);
        assert(Number(line.unit_cost_cents) > 0, "the gift's COGS was not booked");
      }
      const named = rows.map((r) => `${r.product_name} x${r.quantity} @ $${Number(r.unit_price).toFixed(2)}`);
      return named.join("; ");
    });

    await step("screenshot the cart the shopper sees", async () => {
      await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${SHOTS}/${cart.who.toLowerCase()}-cart.png`, fullPage: true });
      return `${SHOTS}/${cart.who.toLowerCase()}-cart.png`;
    });

    await context.close();
  }

  console.log("\n  --- idempotency, against the running system ---");

  await step("a second sweep sends nothing and mints nothing more", async () => {
    const before = captureMark();
    const beforeOffers = (await q("select count(*)::int as n from customer_offers")).rows[0].n;
    await runSweep();
    const after = capturedSince(before).filter((m) => CARTS.some((c) => String(m.to ?? "").includes(c.email)));
    const afterOffers = (await q("select count(*)::int as n from customer_offers")).rows[0].n;
    assert(after.length === 0, `a second sweep sent ${after.length} more message(s)`);
    assert(afterOffers === beforeOffers, `a second sweep minted ${afterOffers - beforeOffers} more entitlement(s)`);
    return `still ${afterOffers} entitlements, no new mail`;
  });

  await step("each cart holds exactly one t12h claim", async () => {
    const { rows } = await q(
      `select abandoned_cart_id, stage, count(*)::int as n from abandoned_cart_emails
       group by 1, 2 having count(*) > 1`,
    );
    assert(rows.length === 0, `duplicate stage rows: ${JSON.stringify(rows)}`);
    for (const cart of CARTS) {
      const { rows: own } = await q(
        "select count(*)::int as n from abandoned_cart_emails where abandoned_cart_id = $1 and stage = $2",
        [cart.id, cart.stage],
      );
      assert(own[0].n === 1, `${cart.who} holds ${own[0].n} ${cart.stage} claims`);
    }
    return `${CARTS.length} replaced-stage claims, no duplicates`;
  });

  await step("every override is stamped consumed, exactly once", async () => {
    const { rows } = await q(
      "select count(*) filter (where consumed_at is not null)::int as consumed, count(*)::int as total from cart_recovery_stage_overrides",
    );
    assert(rows[0].consumed === CARTS.length && rows[0].total === CARTS.length, `consumed ${rows[0].consumed} of ${rows[0].total}`);
    return `${CARTS.length} of ${CARTS.length}`;
  });

  await step("no other cart was touched", async () => {
    const { rows } = await q(
      `select count(*)::int as n from abandoned_cart_emails e
       where e.abandoned_cart_id not in (select id from abandoned_carts where id = any($1))`,
      [CARTS.map((c) => c.id)],
    );
    assert(rows[0].n === 0, `${rows[0].n} stage rows belong to carts outside the three`);
  });

  await pool.end();
  await browser?.close();
  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nFATAL", error);
  await pool.end().catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(1);
});
