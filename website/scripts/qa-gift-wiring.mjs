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
import { createHmac } from "node:crypto";
import { chromium } from "playwright";
import pg from "pg";
import { harnessSigningSecret, loadHarnessEnv } from "./lib/harness-env.mjs";
import { allowLoopbackSelfSignedTls } from "./qa-loopback-tls.mjs";
import { captureAutomations, restoreAutomations } from "./qa-automation-fixtures.mjs";
import { captureControl, pinControl, restoreControl } from "./qa-control-fixtures.mjs";

/** Every automation row as this file found it, put back before it exits. */
let automationsBefore = null;

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";

// Links inside a captured email point at the harness TLS proxy, whose
// certificate is self-signed; without this a fetch that follows one fails
// with a bare "fetch failed". No-op unless BASE is loopback.
allowLoopbackSelfSignedTls(BASE);

/**
 * LINKS INSIDE CAPTURED EMAILS POINT AT THE TLS PROXY, WHATEVER THIS IS DRIVEN AT.
 *
 * They are built from NEXT_PUBLIC_SITE_URL, which the runbook requires to be the
 * https harness (section 5c). Without this, every "follow the link from the
 * email" step dies at ERR_CERT_AUTHORITY_INVALID on a self-signed certificate
 * — reported as a broken click-tracker rather than a missing context option.
 * Scoped to loopback, so a run against anything else keeps full certificate
 * checking.
 */
const LOOPBACK_TLS = { ignoreHTTPSErrors: true };

const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/vanta-qa/gift";
const CAPTURE = process.env.QA_EMAIL_CAPTURE ?? "/tmp/vanta-qa/captured-emails.jsonl";
const CRON = process.env.QA_CRON_SECRET ?? "harness-cron-secret";
// qa-seed-roles.mjs seeds the username too, and it seeds "qaadmin". This said
// "vantaqa", so the form was filled with an account that does not exist, the
// login answered 401 and the redirect this step waits for never came.
const USER = process.env.QA_ADMIN_USER ?? "qaadmin";
// qa-seed-roles.mjs is the seeder and therefore the authority on this
// value; qa-role-boundaries already agrees with it, and its admin positive
// control (74 admin routes reached) is what proves the pair works. Three
// different defaults were in circulation across six suites, so every
// admin-authenticated step in this file answered 401 unless somebody
// happened to export QA_ADMIN_PASS.
const PASS = process.env.QA_ADMIN_PASS ?? "QaAdmin123!Pass";
const CODE = process.env.QA_ADMIN_CODE ?? "123456";

loadHarnessEnv();

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
/** The attestation-step fixtures (section 8), named here so the re-runnable
 *  cleanup below covers them. A fixture left behind is not inert: the earlier
 *  sweeps pick it up as a legitimate win-back target, and an address with no
 *  account is WITHHELD — which lands in the sweep's error list and fails a
 *  section that has nothing to do with it. That is how a harness starts
 *  reporting a fault in the wrong place. */
const REGISTERED_UNATTESTED = "gift-registered-unattested@example.test";
const NO_ACCOUNT = "gift-no-account@example.test";
const UNATTESTED_GUEST = "gift-unattested@example.test";

const EVERYONE = [GHK_BUYER, GHK_SMALL, COMBO_BUYER];
/** Everything this file seeds, for cleanup. EVERYONE is the happy-path subset
 *  the sweep assertions count, and must stay that. */
const ALL_FIXTURES = [...EVERYONE, REGISTERED_UNATTESTED, NO_ACCOUNT, UNATTESTED_GUEST];

const BIG = { id: "bpc-157-10mg", quantity: 1 };     // $69 — clears the $60 minimum
const SMALL = { id: "ipamorelin-5mg", quantity: 1 }; // $59 — one dollar short of it

let browser;
let ipCounter = 0;

/** A fresh browser context on its own client IP, so the checkout rate limiter
 *  (which correctly refuses several orders a minute from one address) doesn't
 *  become the thing under test. */
async function freshContext() {
  ipCounter += 1;
  return browser.newContext({ ...LOOPBACK_TLS, extraHTTPHeaders: { "x-real-ip": "198.51.100." + ipCounter } });
}

/** Seed a customer who lapsed `days` ago: consented to marketing, with one
 *  paid order that old and nothing since. That is exactly what the win-back
 *  rules look for — see selectAutomationTargets. */
/**
 * Give a CONTROL shopper ordinary access to the store.
 *
 * This store is account-only by default (access-policy.ts), so a fresh browser
 * with no session and no grant cannot reach /products, /cart or /checkout at
 * all. That is correct and is the whole reason the marketing-link grant exists.
 *
 * The control step below is not testing the grant — it is establishing what an
 * ORDINARY order costs in shipping, so the free-shipping gift has something to
 * waive. It therefore needs access by some legitimate means, and minting the
 * same grant the click tracker mints is the cheapest one that does not invent a
 * second door: same construction, same secret, same TTL as link-grant.ts.
 *
 * NOTE WHAT THIS DOES NOT DO. Attestation alone is not access — an attested
 * address still has to arrive through a genuine link or sign in. Seeding the
 * auth row would not have been enough here, and pretending otherwise would have
 * made this harness prove something the product does not do.
 */
async function grantOrdinaryAccess(context) {
  const secret = harnessSigningSecret();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const mac = createHmac("sha256", secret)
    .update(`email_link_grant:v1:${expiresAt}`)
    .digest("hex")
    .slice(0, 32);
  await context.addCookies([{
    name: "vl_email_grant",
    value: `v1.${expiresAt}.${mac}`,
    url: BASE,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function seedLapsedCustomer(email, days, { attested = true } = {}) {
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
  // ATTESTATION IS WHAT DECIDES WHETHER THE GIFT IS EVEN SENDABLE.
  //
  // The storefront is default-deny and a marketing-link grant is minted only
  // for an address whose auth account carries BOTH representations
  // (auth_user_attested_by_email). An address without them cannot reach the
  // cart from an email, so the sweep deliberately withholds gift-bearing
  // messages to it rather than promising a benefit that dead-ends.
  //
  // So a fixture that wants the happy path has to say so. `attested: false`
  // seeds the real-world case this whole change exists for: a lapsed GUEST with
  // no attested account, whom production has three of.
  if (attested) {
    await q(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data, created_at)
       values ($1, now(), '{"age_confirmed_21": true, "research_use_only_agreed": true}'::jsonb, now())
       on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data`,
      [email],
    );
  }

  // PAID_AT, NOT JUST CREATED_AT. selectAutomationTargets measures the lapse
  // from the moment the money landed, so a row that is payment_status='paid'
  // with a null paid_at has no last-order date at all and matches no win-back.
  // This fixture set created_at only, so every "lapsed customer" it seeded was
  // invisible to the rules it exists to exercise.
  await q(
    `update orders set paid_at = created_at where order_id = $1 and paid_at is null`,
    [orderId],
  );
  return orderId;
}

/**
 * Put an automation on a delay this test controls, rather than trusting
 * whatever the database happens to carry.
 *
 * The harness database had winback_60 at 75 days while this file seeded a
 * customer who lapsed 70 days ago, so the target was simply not due yet and
 * the sweep correctly did nothing. A fixture that depends on a default it does
 * not set is a fixture that breaks the day somebody edits the default — which
 * is exactly what happened.
 */
async function setAutomationDelay(key, days) {
  await q(`update email_automations set delay_days = $2 where key = $1`, [key, days]);
}

/**
 * Run the REAL scheduled sweep — the same entry point Vercel calls.
 *
 * THE LIFECYCLE ROUTE, NOT THE SWEEP ROUTE. The six jobs that put a message in
 * front of a customer — cart recovery, the retention automations, campaigns,
 * the marketing queue, the email retry and the order-email reaper — moved to
 * /api/cron/lifecycle on 2026-09-10 so a recovery window could not be lost to
 * a sweep that overran on twenty-seven unrelated jobs.
 *
 * This file was last touched 2026-09-07 and kept calling /api/cron/sweep, so
 * from the day of that split it asserted on a response that could not contain
 * `emailAutomations` — the whole gift chain, from the admin dropdown to the $0
 * line, has been silently proving nothing since. A harness that points at the
 * wrong door does not fail loudly; it just stops being evidence.
 */
async function runSweep() {
  const res = await fetch(`${BASE}/api/cron/lifecycle`, {
    headers: { authorization: `Bearer ${CRON}` },
  });
  const body = await res.json().catch(() => null);
  assert(res.status === 200, `lifecycle sweep returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  // The job key this file exists to exercise. If the route is ever split again,
  // fail HERE with the reason rather than fifteen assertions downstream.
  assert(
    body && Object.prototype.hasOwnProperty.call(body, "emailAutomations"),
    `the lifecycle route returned no emailAutomations key — has the job moved again? got: ${Object.keys(body ?? {}).join(", ")}`,
  );
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
 * SWEEP UNTIL THIS FILE'S OWN RECIPIENTS HAVE BEEN SERVED.
 *
 * AUTOMATION_BATCH_LIMIT is 50 per automation per sweep — a deliberate backstop
 * so switching an automation on against an existing customer base does not try
 * to mail everyone inside one 60-second function; "the remainder is picked up
 * next sweep, and the dedup keys mean nobody gets a second copy".
 *
 * One sweep is therefore only enough while the database is small. In a shuffled
 * release batch, after a dozen suites have each left lapsed customers behind,
 * this file's fixture can sit outside the first fifty — and a single sweep
 * reported "no email for gift-combo-buyer@example.test", taking the two
 * sections after it down with it. Nothing was wrong: the customer was 51st.
 *
 * So this does what the cron does — keeps ticking — and gives up loudly, naming
 * who was never reached and how many sweeps it took, rather than asserting on
 * one tick's worth of a queue it does not control.
 */
async function sweepUntilMailed(addresses, { maxSweeps = 8 } = {}) {
  const wanted = addresses.map((address) => String(address).toLowerCase());
  const mark = captureMark();
  // Summed across the sweeps, not read off the last one: a caller asking "did
  // at least two go out" means across this wait, and the tick that served the
  // second recipient may have served only that one.
  let body = null; let sent = 0; const errors = [];
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    body = await runSweep();
    sent += Number(body?.emailAutomations?.sent ?? 0);
    errors.push(...(body?.emailAutomations?.errors ?? []));
    const seen = new Set(capturedSince(mark).map((m) => String(m.to ?? "").toLowerCase()));
    if (wanted.every((address) => seen.has(address))) return { body, mark, sweeps: sweep + 1, sent, errors };
  }
  return { body, mark, sweeps: maxSweeps, sent, errors };
}

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

let controlBefore = null;

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  // A re-runnable starting state. The gift consumes real stock, so top it up.
  await q("update products set inventory_quantity = 500, stock_status = 'In Stock' where slug in ('bpc-157-10mg','ipamorelin-5mg','ghk-cu')");
  await q("update product_doses set inventory_quantity = 500, stock_status = 'In Stock'").catch(() => {});
  await q("delete from inventory_reservations").catch(() => {});
  await q("delete from customer_offers where email = any($1)", [ALL_FIXTURES]);
  await q("delete from order_items where order_id in (select order_id from orders where customer_email = any($1))", [ALL_FIXTURES]);
  await q("delete from orders where customer_email = any($1)", [ALL_FIXTURES]);
  await q("delete from marketing_subscribers where email = any($1)", [ALL_FIXTURES]);
  await q("delete from email_send_log where recipient_email = any($1)", [ALL_FIXTURES]).catch(() => {});
  await q("delete from auth.users where email = any($1)", [ALL_FIXTURES]).catch(() => {});
  // Start with every automation off, so each round's sweep can only mail the
  // one automation that round is about. That is a big change to a shared table
  // — every flow disabled and every gift stripped — so it is captured first and
  // handed back before this file exits; a suite that ran afterwards used to
  // inherit a store with its entire lifecycle switched off.
  automationsBefore = await captureAutomations(q);
  await q("update email_automations set enabled = false, offer_key = null");
  // AND SET THE SHIPPING POLICY THIS FILE ASSUMES, rather than inheriting it.
  //
  // Section 5 proves a free-shipping gift by showing an ordinary order paying
  // shipping first — which is only true if sitewide free shipping is OFF.
  // qa-cart-recovery-override turns it ON (production runs it that way, and its
  // totals depend on it), so whichever harness ran last decided whether this one
  // passed. A harness that inherits a precondition is a harness that reports a
  // product failure when a sibling ran before it.
  // ...and puts it back afterwards, for exactly the reason above, pointed the
  // other way: a suite that leaves the store changed hands the next one a
  // precondition it never set.
  controlBefore = await captureControl(q, [["shipping", "free_shipping_sitewide"]]);
  await pinControl(q, [["shipping", "free_shipping_sitewide", false]]);

  browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  });
  const adminContext = await browser.newContext({ ...LOOPBACK_TLS, viewport: { width: 1280, height: 900 } });
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
    // The consent banner sits over the page until answered, including over the
    // Enter button.
    const accept = page.getByRole("button", { name: /^Accept$/ });
    if (await accept.count()) await accept.first().click().catch(() => {});

    // THE PASSCODE FIELD IS NOT ALWAYS THERE, AND THIS ASSUMED IT WAS.
    //
    // /vault renders four inputs: two hidden decoys (_vl_u, _vl_p) and two
    // visible ones. A third VISIBLE field appears only when the admin has a
    // passcode configured — the harness admin does not, and
    // /api/admin/auth/login answers {"ok":true,"passcodeConfigured":false}. So
    // `inputs.nth(2).fill(CODE)` waited thirty seconds for a field that will
    // never exist and failed as "locator.fill: Timeout".
    //
    // That one timeout is why this file reported 22 failures. Section 1 is what
    // ATTACHES the gift to the automation, so with it dead the sweep minted no
    // offers and every section after it failed on an absent gift: "expected 2
    // offers, found 0", "no offer token on the emailed link", "no GHK-Cu line".
    // One selector, four sections of noise.
    const inputs = page.locator("form input:visible");
    await inputs.nth(0).fill(USER);
    await inputs.nth(1).fill(PASS);
    if ((await inputs.count()) > 2) await inputs.nth(2).fill(CODE);
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
    await setAutomationDelay("winback_60", 60);
    const { body: sweep, mark, sent: sweptSent, errors: sweptErrors } = await sweepUntilMailed([GHK_BUYER, GHK_SMALL]);
    const outcome = sweep?.emailAutomations;
    assert(outcome, `sweep returned no emailAutomations result: ${JSON.stringify(sweep).slice(0, 200)}`);
    // THE ERRORS THAT ARE THIS FILE'S, NOT EVERY ERROR IN THE STORE.
    //
    // This is the REAL sweep, so it serves whoever else the database holds. In
    // a shuffled batch it ran after qa-offer-journey and reported
    //
    //   winback_60: no winback_60_free_ghkcu token could be issued for
    //   offer.racer.847e6e@example.test; send deferred to the next sweep
    //
    // — that file's deliberate two-tab race, holding its own token live while a
    // checkout settles, which is the reissue backstop working exactly as
    // designed and is deferred to the next sweep rather than lost. It arrived
    // here as a gift-wiring failure, three sections deep, with the evidence
    // pointing at an address this file has never heard of. Each error names its
    // recipient, so the ones about this file's customers are separable — and
    // those are still absolutely required.
    const mine = sweptErrors.filter((e) => EVERYONE.some((address) => String(e).includes(address)));
    assert(!mine.length, `sweep reported for this file's customers: ${JSON.stringify(mine).slice(0, 220)}`);
    assert(sweptSent >= 2, `the sweeps sent ${sweptSent}, expected at least 2 (last tick byKey ${JSON.stringify(outcome.byKey)})`);

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
    await setAutomationDelay("winback_30", 30);
    const { mark, sweeps } = await sweepUntilMailed([COMBO_BUYER]);
    const mail = capturedSince(mark).find((m) => String(m.to ?? "").toLowerCase() === COMBO_BUYER);
    assert(mail, `no email for ${COMBO_BUYER} after ${sweeps} sweeps`);
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
    await grantOrdinaryAccess(context);
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
    const context = await browser.newContext({ ...LOOPBACK_TLS,
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

  // -------------------------------------------------------------------------
  section("7. A gift is never promised to somebody who could not spend it");

  const UNATTESTED = UNATTESTED_GUEST;

  await step("a lapsed customer with NO attested account is withheld, not mailed", async () => {
    // The real-world case: production has three paid customers with no auth
    // account at all, and forty accounts carrying no attestation. Each is a
    // legitimate win-back target (selectAutomationTargets keys on
    // customer_email), and each would receive a real minted token, click it,
    // and reach "Sign in to continue" for an account they do not have.
    await q("delete from customer_offers where email = $1", [UNATTESTED]);
    await q("delete from email_send_log where recipient_email = $1", [UNATTESTED]);
    await seedLapsedCustomer(UNATTESTED, 70, { attested: false });
    await q("update email_automations set enabled = false");
    await q("update email_automations set enabled = true where key = 'winback_60'");
    await setAutomationDelay("winback_60", 60);

    const mark = captureMark();
    const sweep = await runSweep();
    const mail = capturedSince(mark).filter((m) => (m.to ?? "").includes(UNATTESTED));
    const { rows } = await q("select count(*)::int n from customer_offers where email = $1", [UNATTESTED]);

    assert(mail.length === 0, `an unattested guest was mailed a gift: ${mail.map((m) => m.subject).join(", ")}`);
    assert(rows[0].n === 0, `a token was minted for an unattested guest: ${rows[0].n}`);
    // Counted and reported rather than silent — an operator must be able to see
    // this is a policy decision and not a failure.
    const withheld = sweep?.emailAutomations?.withheldUnattested ?? 0;
    assert(withheld >= 1, `the sweep did not report withholding: ${JSON.stringify(sweep?.emailAutomations)}`);
    return `withheld ${withheld}, minted 0, mailed 0`;
  });

  await step("nothing was consumed, so the same address is reconsidered next sweep", async () => {
    // Filtered BEFORE the claim: no send-once slot, no frequency claim, no
    // token. That is what makes failing closed safe — the moment the customer
    // attests, the next sweep can mail them.
    const { rows } = await q(
      "select count(*)::int n from email_send_log where recipient_email = $1", [UNATTESTED],
    );
    assert(rows[0].n === 0, `a send-once slot was consumed for a withheld recipient: ${rows[0].n}`);
    const second = await runSweep();
    assert((second?.emailAutomations?.withheldUnattested ?? 0) >= 1, "the second sweep did not reconsider the address");
    return "no slot consumed; reconsidered on the next sweep";
  });

  await step("a no-offer automation still reaches an unattested address", async () => {
    // The rule is about the PROMISE, not the gate. A reminder that costs
    // nothing and promises nothing has nothing to dead-end on, so withholding
    // it would be the exclusion overreaching.
    await q("update email_automations set enabled = false");
    await q("update email_automations set enabled = true, offer_key = null where key = 'winback_60'");
    await setAutomationDelay("winback_60", 60);
    const mark = captureMark();
    await runSweep();
    const mail = capturedSince(mark).filter((m) => (m.to ?? "").includes(UNATTESTED));
    assert(mail.length === 1, `expected one no-offer message, saw ${mail.length}`);
    return `"${mail[0].subject}" delivered with no offer attached`;
  });

  // -------------------------------------------------------------------------
  section("8. The attestation step: a promised gift now has somewhere to go");

  // The case B used to withhold from and A now serves: a lapsed customer with a
  // real account who has never made the 21+/research-use representations.
  // Production has forty of these. Before A they clicked a genuine win-back
  // holding a real token and met "Sign in to continue".
  const REGISTERED = REGISTERED_UNATTESTED;
  let attestLink = null;

  await step("an unattested customer WITH an account is now mailed the gift", async () => {
    await q("delete from customer_offers where email = $1", [REGISTERED]);
    await q("delete from email_send_log where recipient_email = $1", [REGISTERED]);
    await q("delete from auth.users where email = $1", [REGISTERED]);
    await seedLapsedCustomer(REGISTERED, 70, { attested: false });
    // An account, carrying NEITHER representation. This is the exact shape the
    // narrowed rule turns on: reachable because /attest can write to this row.
    await q(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data, created_at)
       values ($1, now(), '{"role": "customer"}'::jsonb, now())
       on conflict (email) do update set raw_user_meta_data = '{"role": "customer"}'::jsonb`,
      [REGISTERED],
    );
    await q("update email_automations set enabled = false");
    await q("update email_automations set enabled = true, offer_key = 'winback_60_free_ghkcu' where key = 'winback_60'");
    await setAutomationDelay("winback_60", 60);

    const mark = captureMark();
    await runSweep();
    const mail = capturedSince(mark).filter((m) => String(m.to).toLowerCase() === REGISTERED);
    assert(mail.length === 1, `expected one gift email, saw ${mail.length}`);
    const { rows } = await q("select count(*)::int n from customer_offers where email = $1", [REGISTERED]);
    assert(rows[0].n === 1, `expected one minted token, found ${rows[0].n}`);
    attestLink = ctaLinkFrom(mail[0].html);
    return `"${mail[0].subject}" with a real token`;
  });

  await step("clicking it lands on the attestation step, holding the gift and NO grant", async () => {
    // The whole point: the capability is not handed out on the way in. It is
    // minted on the far side, after the statements are actually made.
    const context = await freshContext();
    const page = await context.newPage();
    await page.goto(attestLink, { waitUntil: "domcontentloaded" });
    assert(page.url().includes("/attest"), `landed on ${page.url()} instead of the attestation step`);
    const cookies = await context.cookies();
    assert(!cookies.some((c) => c.name === "vl_email_grant"), "a grant was issued BEFORE the statements were made");
    const offer = cookies.find((c) => c.name === "vl_offer");
    assert(offer && offer.httpOnly, "the gift did not survive the redirect as an httpOnly cookie");
    const body = await page.textContent("body");
    assert(/21 years of age/i.test(body), "the age statement is not on the page");
    assert(/research use/i.test(body), "the research-use statement is not on the page");
    assert(/gift is saved/i.test(body), "the page does not tell the customer their gift survived");
    await page.screenshot({ path: `${SHOTS}/attest-desktop.png` });
    await context.close();
    return "on /attest, gift held, no grant yet";
  });

  await step("it renders at 390x844 without the button falling off the screen", async () => {
    const context = await browser.newContext({ ...LOOPBACK_TLS,
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-real-ip": "198.51.100.200" },
    });
    const page = await context.newPage();
    await page.goto(attestLink, { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: /confirm and continue/i });
    const box = await button.boundingBox();
    assert(box, "the confirm button has no box at 390x844");
    assert(box.x >= 0 && box.x + box.width <= 390, `the button runs off screen: x=${box.x} w=${box.width}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      "the page scrolls sideways on a phone");
    await page.screenshot({ path: `${SHOTS}/attest-mobile.png`, fullPage: true });
    await context.close();
    return `button at x=${Math.round(box.x)} w=${Math.round(box.width)}, no sideways scroll`;
  });

  await step("the button refuses until BOTH statements are ticked", async () => {
    const context = await freshContext();
    const page = await context.newPage();
    await page.goto(attestLink, { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: /confirm and continue/i });
    assert(await button.isDisabled(), "the button was live before either statement was made");
    await page.getByRole("checkbox").first().check();
    assert(await button.isDisabled(), "one tick was enough to arm the button");
    const { rows } = await q(
      "select raw_user_meta_data->>'age_confirmed_21' a from auth.users where email = $1", [REGISTERED],
    );
    assert(rows[0].a === null, "an attestation was recorded before the customer finished");
    await context.close();
    return "disabled at zero ticks and at one; nothing recorded";
  });

  let attestedContext = null;
  await step("ticking both carries them to the catalogue with the gift armed", async () => {
    attestedContext = await freshContext();
    const page = await attestedContext.newPage();
    await page.goto(attestLink, { waitUntil: "domcontentloaded" });
    for (const box of await page.getByRole("checkbox").all()) await box.check();
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/attest"), { timeout: 15000 }),
      page.getByRole("button", { name: /confirm and continue/i }).click(),
    ]);
    assert(page.url().includes("/products"), `landed on ${page.url()} instead of the intended destination`);
    const status = await page.evaluate(async () => (await fetch("/api/offer/status", { cache: "no-store" })).json());
    assert(status?.offer?.rewardKind === "free_product", `the gift did not survive: ${JSON.stringify(status).slice(0, 160)}`);
    await page.screenshot({ path: `${SHOTS}/attest-landed.png` });
    return `${new URL(page.url()).pathname} — ${status.offer.rewardName}`;
  });

  await step("the representations are on the AUTH record, stamped with where they were made", async () => {
    // One compliance register, not two: the same two fields signup writes, read
    // by the same function every gate in the email system reads.
    const { rows } = await q(
      // Aliased carefully: `at` is reserved in Postgres (AT TIME ZONE) and a
      // bare one here is a syntax error, which reads as a missing attestation.
      `select raw_user_meta_data->>'age_confirmed_21' as age_ok,
              raw_user_meta_data->>'research_use_only_agreed' as research_ok,
              raw_user_meta_data->>'attested_at' as attested_at,
              raw_user_meta_data->>'attested_via' as attested_via
         from auth.users where email = $1`,
      [REGISTERED],
    );
    assert(rows[0]?.age_ok === "true", `age_confirmed_21 is ${rows[0]?.age_ok}`);
    assert(rows[0]?.research_ok === "true", `research_use_only_agreed is ${rows[0]?.research_ok}`);
    assert(rows[0]?.attested_at, "no attested_at stamp");
    assert(rows[0]?.attested_via === "email_link_interstitial", `attested_via is ${rows[0]?.attested_via}`);
    return `both true, via ${rows[0].attested_via}`;
  });

  await step("the grant it mints opens the store and NOTHING personal", async () => {
    // Scoped narrowly, deliberately: attesting gets somebody to the catalogue
    // and the checkout, which is where the message was sending them. It is not
    // a way past the login wall in general.
    const page = await attestedContext.newPage();
    const codes = {};
    for (const path of ["/products", "/cart", "/account/orders"]) {
      const response = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      codes[path] = page.url().includes("/account/login") ? "login" : String(response.status());
    }
    assert(codes["/products"] === "200", `/products answered ${codes["/products"]}`);
    assert(codes["/cart"] === "200", `/cart answered ${codes["/cart"]}`);
    assert(codes["/account/orders"] === "login", `/account/orders was opened by the grant (${codes["/account/orders"]})`);
    return "products 200, cart 200, account/orders still gated";
  });

  await step("and the gift is actually spent at the till, at $0", async () => {
    // The assertion the whole change exists for. Everything above is a journey;
    // this is the sale it was blocking.
    const page = await attestedContext.newPage();
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const orderId = await checkout(page, REGISTERED, [BIG]);
    const order = await readOrder(orderId);
    const gift = order.lines.find((l) => l.slug === "ghk-cu");
    assert(gift, `no GHK-Cu line; lines were ${JSON.stringify(order.lines.map((l) => l.slug))}`);
    assert(Number(gift.unit_price) === 0, `gift priced at ${gift.unit_price}`);
    assert(Number(order.subtotal) === 69, `subtotal ${order.subtotal} — the customer was charged for the gift`);
    await attestedContext.close();
    attestedContext = null;
    return `subtotal $${order.subtotal}, free GHK-Cu at $0`;
  });

  await step("a second visit finds them attested, with no interstitial at all", async () => {
    // "Already-attested customers experience no new friction" — including the
    // one who just attested.
    const context = await freshContext();
    const page = await context.newPage();
    await page.goto(attestLink, { waitUntil: "domcontentloaded" });
    assert(!page.url().includes("/attest"), `an attested customer was sent back through the step: ${page.url()}`);
    const cookies = await context.cookies();
    assert(cookies.some((c) => c.name === "vl_email_grant"), "an attested customer was not granted on the click");
    await context.close();
    return `straight to ${new URL(page.url()).pathname}`;
  });

  await step("a tampered handoff fails safely and offers a way forward", async () => {
    const context = await freshContext();
    const page = await context.newPage();
    const parts = new URL(attestLink);
    // Build a handoff-shaped token with a valid structure and a dead signature.
    const forged = `v1.${Date.now() + 600000}.eyJlIjoidmljdGltQGV4YW1wbGUudGVzdCIsImQiOiIvcHJvZHVjdHMiLCJvIjpudWxsLCJuIjoieCJ9.${"0".repeat(32)}`;
    await page.goto(`${BASE}/attest?h=${encodeURIComponent(forged)}`, { waitUntil: "domcontentloaded" });
    const body = await page.textContent("body");
    assert(/expired/i.test(body), `a forged handoff did not fail safely: ${String(body).slice(0, 160)}`);
    const cookies = await context.cookies();
    assert(!cookies.some((c) => c.name === "vl_email_grant"), "a forged handoff minted a grant");
    // And the API refuses it too, not just the page.
    const refused = await page.evaluate(async ([token]) => {
      const res = await fetch("/api/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: token, ageConfirmed: true, researchUseOnly: true }),
      });
      return res.status;
    }, [forged]);
    assert(refused === 400, `the endpoint answered ${refused} to a forged handoff`);
    await context.close();
    void parts;
    return "page says expired, endpoint answers 400, no grant";
  });

  await step("a customer with no account at all is still withheld, not promised", async () => {
    // The one case the narrowed rule keeps withholding: sign-up is where their
    // representations would be recorded, and that longer journey is not yet
    // driven end to end here. Until it is, no promise is made.
    const NOBODY = NO_ACCOUNT;
    await q("delete from customer_offers where email = $1", [NOBODY]);
    await q("delete from email_send_log where recipient_email = $1", [NOBODY]);
    await q("delete from auth.users where email = $1", [NOBODY]);
    await seedLapsedCustomer(NOBODY, 70, { attested: false });
    const mark = captureMark();
    const sweep = await runSweep();
    const mail = capturedSince(mark).filter((m) => String(m.to).toLowerCase() === NOBODY);
    assert(mail.length === 0, `an account-less guest was promised a gift: ${mail.map((m) => m.subject).join(", ")}`);
    assert((sweep?.emailAutomations?.withheldUnattested ?? 0) >= 1, "the sweep did not report withholding");
    return "withheld, and reported";
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
  await restoreAutomations(q, automationsBefore);
  await restoreControl(q, controlBefore);
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await restoreAutomations(q, automationsBefore).catch(() => {});
  await restoreControl(q, controlBefore);
  await pool.end().catch(() => {});
  process.exit(1);
});
