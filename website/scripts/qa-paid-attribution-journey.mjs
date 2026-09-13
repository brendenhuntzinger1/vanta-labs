#!/usr/bin/env node
/**
 * THE PAID JOURNEY, END TO END, IN A REAL BROWSER.
 *
 *   ad click with a click id  ->  the login wall  ->  browse  ->  cart
 *   ->  checkout  ->  a PAID order  ->  order_attribution  ->  ad_revenue_daily
 *
 * Nearly all of this store's traffic is bought, so the join from a click id to
 * a paid order is the number every scale-or-kill decision rests on. Until this
 * file existed it had no browser-level coverage at all: order-attribution.ts and
 * the ROAS views were unit-tested, and nothing drove the actual path a customer
 * takes — through a wall that redirects, a consent banner that gates capture,
 * a sign-in that changes session, and a checkout that has to carry a touch
 * captured several navigations earlier.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS BEND THE SEMANTICS TO GO GREEN. Two of
 * the rules below look like failures until you read why they exist, and both are
 * asserted in the direction the product intends:
 *
 *   * GOOGLE IS NOT AUTOMATICALLY A PAID SOURCE. is_paid_ad_source() treats
 *     facebook/tiktok/reddit/snapchat as always-paid and every other source as
 *     paid only while the store has SPEND recorded for it. So a gclid order
 *     with no google spend is correctly absent from ad_revenue_daily and named
 *     by ad_revenue_non_paid_source. Section 3 proves both halves rather than
 *     seeding spend to make the first one pass.
 *
 *   * AN EMAIL-DRIVEN ORDER IS NOT AD REVENUE. ad_revenue_daily excludes
 *     marketing_source_kind in (campaign, automation, cart_recovery), because
 *     those orders are already counted as that channel's revenue elsewhere and
 *     counting them twice is what inflated paid ROAS. Section 6 proves the
 *     exclusion holds even when a real ad touch is present.
 *
 * Local harness only.
 *
 *   node scripts/qa-paid-attribution-journey.mjs
 */
import { execFileSync } from "node:child_process";
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

const CHROME = process.env.QA_CHROMIUM
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));

const PRODUCT_SLUG = "ghk-cu";

/**
 * The five platforms this store tags, with the click-id parameter each one
 * actually sends. Snapchat's is `ScCid` — it is documented that way, arrives in
 * both spellings, and attribution.ts reads it case-insensitively, so the URL
 * below deliberately uses the lowercase spelling a real Snap click arrives in.
 */
const PLATFORMS = [
  { name: "TikTok", utmSource: "TikTok", param: "ttclid", column: "last_ttclid", platformKey: "tiktok", alwaysPaid: true },
  { name: "Meta", utmSource: "Meta", param: "fbclid", column: "last_fbclid", platformKey: "facebook", alwaysPaid: true },
  { name: "Reddit", utmSource: "Reddit", param: "rdt_cid", column: "last_rdt_cid", platformKey: "reddit", alwaysPaid: true },
  { name: "Snapchat", utmSource: "Snapchat", param: "sccid", column: "last_sccid", platformKey: "snapchat", alwaysPaid: true },
  { name: "Google", utmSource: "Google", param: "gclid", column: "last_gclid", platformKey: "google", alwaysPaid: false },
];

// ---------------------------------------------------------------------------
// Fixtures and browser helpers
// ---------------------------------------------------------------------------

async function createConfirmedCustomer(email) {
  await q(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, created_at)
     values ($1,$2,now(),now())
     on conflict (email) do update set encrypted_password = excluded.encrypted_password,
       email_confirmed_at = excluded.email_confirmed_at`,
    [email, PASSWORD],
  );
}

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
    await page.waitForTimeout(300);
  }
}

/** Accept or decline the banner. Capture is gated on it, by product policy. */
async function answerConsent(page, accept) {
  const button = page.getByRole("button", { name: accept ? /^Accept$/ : /^Decline$/ });
  if (await button.count()) {
    await button.first().click().catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function signIn(page, email) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
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
  assert(!/\/account\/login/.test(page.url()), `sign-in failed for ${email}`);
}

const readStoredAttribution = (page) => page.evaluate(() => {
  try {
    const raw = window.localStorage.getItem("vl_attribution");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
});

async function addToCart(page, quantity = 1) {
  await page.goto(`${BASE}/products/${PRODUCT_SLUG}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  await dismissOverlays(page);
  const add = page.getByRole("button", { name: /add to cart/i }).first();
  assert(await add.count(), "no ADD TO CART on the product page");
  for (let i = 0; i < quantity; i += 1) {
    await dismissOverlays(page);
    await add.click({ timeout: 20000 });
    await page.waitForTimeout(500);
  }
  await dismissOverlays(page);
}

/**
 * Place the order the way checkout/page.tsx does, carrying the attribution the
 * browser captured — readAttributionForCheckout() prunes expired touches out of
 * the same localStorage record this reads, so a fresh touch is identical.
 */
async function placeOrder(page, email) {
  return page.evaluate(async ({ email: e, slug }) => {
    const stored = (() => {
      try { return JSON.parse(window.localStorage.getItem("vl_attribution") ?? "null"); } catch { return null; }
    })();
    const r = await fetch("/api/checkout/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        items: [{ id: slug, quantity: 1 }],
        customer: {
          email: e,
          fullName: "Attribution Harness",
          address: "1 Test Way",
          city: "Tampa",
          state: "FL",
          postalCode: "33601",
          country: "US",
        },
        attribution: stored,
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { email, slug: PRODUCT_SLUG });
}

const latestOrderFor = async (email) => (await q(
  "select order_id, payment_status, amount_paid, marketing_source_kind from orders where customer_email = $1 order by created_at desc limit 1",
  [email],
)).rows[0] ?? null;

/** Settle through the REAL signed webhook, using the script that owns it. */
function payOrder(orderId, eventType) {
  return execFileSync("node", ["scripts/harness-pay-order.mjs", orderId], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PAYMENT_WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret",
      QA_BASE_URL: BASE,
      ...(eventType ? { HARNESS_EVENT_TYPE: eventType } : {}),
    },
  });
}

const attributionRows = async (orderId) => (await q(
  "select * from order_attribution where order_id = $1", [orderId],
)).rows;

// ---------------------------------------------------------------------------

/**
 * One complete paid journey. Returns what it learned so the caller can assert
 * platform-specific reporting on top.
 */
async function runJourney(browser, platform, { consent = true, label = "" } = {}) {
  // UNIQUE PER JOURNEY, NOT PER PLATFORM. Section 5 re-runs a TikTok journey to
  // decline its payment, and with the campaign keyed on the platform alone it
  // landed in the SAME campaign as section 2's successful TikTok order — so
  // "the declined order contributes nothing" read the earlier paid order and
  // failed. A fixture collision, reported as a reporting defect.
  const run = label ? `${stamp}${label}` : stamp;
  const email = `attr.${platform.platformKey}.${run}@example.test`;
  await createConfirmedCustomer(email);

  const campaign = `Launch_${platform.name}_${run}`;
  const content = `Hook_A_${run}`;
  const clickId = `CID-${platform.platformKey}-${run}`.toUpperCase();
  const landing = `${BASE}/products/${PRODUCT_SLUG}`
    + `?utm_source=${platform.utmSource}&utm_medium=paid`
    + `&utm_campaign=${campaign}&utm_content=${content}`
    + `&${platform.param}=${clickId}`;

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "x-real-ip": `198.51.100.${1 + PLATFORMS.indexOf(platform)}` },
  });
  const page = await context.newPage();

  // 1. The ad click. The wall answers first, and has to carry the tags.
  await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 60000 });
  const walledUrl = page.url();
  await answerConsent(page, consent);
  await page.waitForTimeout(600);

  const afterWall = await readStoredAttribution(page);

  // 2. Sign in. The session changes underneath the captured touch.
  await signIn(page, email);
  await page.waitForTimeout(800);
  const afterSignIn = await readStoredAttribution(page);

  // 3. Browse and buy.
  await addToCart(page, 1);
  const placed = await placeOrder(page, email);
  const order = await latestOrderFor(email);

  await context.close();
  return { email, campaign, content, clickId, walledUrl, afterWall, afterSignIn, placed, order, platform };
}

async function main() {
  console.log(`Paid attribution journey — run ${stamp}`);
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const journeys = {};

  // -------------------------------------------------------------------------
  section("1. An ad click survives the wall, the consent banner and the sign-in");
  // -------------------------------------------------------------------------
  for (const platform of PLATFORMS) {
    const j = await runJourney(browser, platform);
    journeys[platform.platformKey] = j;

    check(
      /\/account\/login/.test(j.walledUrl) && j.walledUrl.includes(j.clickId),
      `${platform.name}: the wall carries the click id into the sign-in URL`,
      j.walledUrl.slice(0, 160),
    );
    const first = j.afterWall?.first ?? null;
    check(
      Boolean(first),
      `${platform.name}: a first touch is captured on the walled landing`,
      JSON.stringify(j.afterWall)?.slice(0, 160) ?? "(nothing stored)",
    );
    check(
      first?.utmSource === platform.platformKey.replace("facebook", "meta") || first?.utmSource === platform.utmSource.toLowerCase(),
      `${platform.name}: utm_source is stored lowercased, to match the spend side of the join`,
      `stored "${first?.utmSource}"`,
    );
    const storedClickId = first ? Object.values(first).find((v) => v === j.clickId) : null;
    check(
      storedClickId === j.clickId,
      `${platform.name}: the click id is stored verbatim, not lowercased`,
      `looked for ${j.clickId} in ${JSON.stringify(first)?.slice(0, 200)}`,
    );
    check(
      JSON.stringify(j.afterSignIn?.first) === JSON.stringify(j.afterWall?.first),
      `${platform.name}: signing in does not disturb the first touch`,
    );
  }

  // -------------------------------------------------------------------------
  section("2. A paid order writes exactly one order_attribution row");
  // -------------------------------------------------------------------------
  for (const platform of PLATFORMS) {
    const j = journeys[platform.platformKey];
    check(
      j.placed.status === 200 && j.order,
      `${platform.name}: the order was created`,
      `status ${j.placed.status}: ${JSON.stringify(j.placed.body).slice(0, 160)}`,
    );
    if (!j.order) continue;

    payOrder(j.order.order_id);
    const paid = await latestOrderFor(j.email);
    check(paid?.payment_status === "paid", `${platform.name}: the order settled as paid`, `status ${paid?.payment_status}`);

    const rows = await attributionRows(j.order.order_id);
    check(rows.length === 1, `${platform.name}: exactly one attribution row`, `${rows.length} row(s)`);
    if (rows.length !== 1) continue;
    const row = rows[0];
    check(
      String(row.last_utm_campaign).toLowerCase() === j.campaign.toLowerCase()
      && String(row.last_utm_content).toLowerCase() === j.content.toLowerCase(),
      `${platform.name}: campaign and creative land on the order`,
      `campaign=${row.last_utm_campaign} content=${row.last_utm_content}`,
    );
    check(
      row[platform.column] === j.clickId,
      `${platform.name}: ${platform.column} carries the click id the platform sent`,
      `stored ${row[platform.column]}`,
    );
    check(
      row.first_utm_source !== null && row.last_utm_source !== null,
      `${platform.name}: both first and last touch are recorded`,
      `first=${row.first_utm_source} last=${row.last_utm_source}`,
    );
  }

  // -------------------------------------------------------------------------
  section("3. Reporting: only sources the store actually buys ads on");
  // -------------------------------------------------------------------------
  for (const platform of PLATFORMS.filter((p) => p.alwaysPaid)) {
    const j = journeys[platform.platformKey];
    const { rows } = await q(
      `select platform, utm_campaign, orders, net_revenue from ad_revenue_daily
        where lower(utm_campaign) = lower($1)`,
      [j.campaign],
    );
    check(
      rows.length === 1 && rows[0].platform === platform.platformKey,
      `${platform.name}: the paid order reaches ad_revenue_daily under the right platform`,
      JSON.stringify(rows).slice(0, 200),
    );
    check(
      rows.length === 1 && Number(rows[0].orders) === 1 && Number(rows[0].net_revenue) > 0,
      `${platform.name}: counted exactly once, with revenue`,
      JSON.stringify(rows).slice(0, 200),
    );
  }

  // Google is the deliberate asymmetry — paid only while spend exists for it.
  const google = journeys.google;
  {
    const { rows: before } = await q(
      "select * from ad_revenue_daily where lower(utm_campaign) = lower($1)", [google.campaign],
    );
    check(
      before.length === 0,
      "Google with NO recorded spend is correctly absent from ad_revenue_daily",
      JSON.stringify(before).slice(0, 200),
    );
    // The blind-spot view groups by source, not by campaign — it answers "which
    // sources are producing revenue we are not calling paid?"
    const { rows: blindspot } = await q(
      "select * from ad_revenue_non_paid_source where utm_source = 'google'",
    );
    check(
      blindspot.length >= 1 && Number(blindspot[0].orders) >= 1,
      "...and is NAMED by ad_revenue_non_paid_source rather than silently dropped",
      JSON.stringify(blindspot).slice(0, 200),
    );

    // Now buy some Google ads. `spend > 0` is the test is_paid_ad_source
    // applies — a zero-spend reporting row deliberately does not admit a
    // source — so this writes real money out.
    await q(
      `insert into ad_spend_daily (stat_date, platform, ad_id, utm_campaign, utm_content, spend, impressions, clicks, source)
       values (current_date, 'google', $3, lower($1), lower($2), 25.00, 1000, 40, 'harness')
       on conflict do nothing`,
      [google.campaign, google.content, `harness-${stamp}`],
    );
    const { rows: after } = await q(
      "select platform, orders, net_revenue from ad_revenue_daily where lower(utm_campaign) = lower($1)",
      [google.campaign],
    );
    check(
      after.length === 1 && after[0].platform === "google",
      "...and appears the moment the store has Google spend on that campaign",
      JSON.stringify(after).slice(0, 200),
    );
  }

  // -------------------------------------------------------------------------
  section("4. Replay and refresh cannot double-count a sale");
  // -------------------------------------------------------------------------
  {
    const j = journeys.tiktok;
    const beforeRows = await attributionRows(j.order.order_id);
    const { rows: beforeRevenue } = await q(
      "select orders, net_revenue from ad_revenue_daily where lower(utm_campaign) = lower($1)", [j.campaign],
    );

    // A processor retries. The same signed event, twice more.
    payOrder(j.order.order_id);
    payOrder(j.order.order_id);

    const afterRows = await attributionRows(j.order.order_id);
    const { rows: afterRevenue } = await q(
      "select orders, net_revenue from ad_revenue_daily where lower(utm_campaign) = lower($1)", [j.campaign],
    );
    check(
      afterRows.length === 1 && beforeRows.length === 1,
      "a replayed payment webhook leaves exactly one attribution row",
      `${beforeRows.length} -> ${afterRows.length}`,
    );
    check(
      JSON.stringify(beforeRevenue) === JSON.stringify(afterRevenue),
      "and the reported orders and revenue do not move",
      `${JSON.stringify(beforeRevenue)} -> ${JSON.stringify(afterRevenue)}`,
    );
  }

  // -------------------------------------------------------------------------
  section("5. A sale that never happened is never reported as revenue");
  // -------------------------------------------------------------------------
  {
    const platform = PLATFORMS[0];
    const failed = await runJourney(browser, { ...platform, platformKey: "tiktok" }, { label: "decline" });
    assert(failed.order, "the failed-payment journey did not create an order");
    payOrder(failed.order.order_id, "payment.failed");
    const row = await latestOrderFor(failed.email);
    check(
      row?.payment_status === "payment_failed",
      "a declined payment leaves the order unpaid",
      `status ${row?.payment_status}`,
    );
    const { rows } = await q(
      "select * from ad_revenue_daily where lower(utm_campaign) = lower($1)", [failed.campaign],
    );
    check(
      rows.length === 0,
      "and it contributes nothing to ad_revenue_daily",
      JSON.stringify(rows).slice(0, 200),
    );
    // The attribution row itself is allowed to exist — the click was real. What
    // must not happen is revenue being claimed for it.
    const attr = await attributionRows(failed.order.order_id);
    check(
      attr.length <= 1,
      "the click is still recorded at most once, even though it did not convert",
      `${attr.length} row(s)`,
    );
  }

  // -------------------------------------------------------------------------
  section("6. An email-driven order is not counted as ad revenue");
  // -------------------------------------------------------------------------
  {
    // marketing-source.ts ranks one primary source per order. An ad touch that
    // did not convert, followed weeks later by a campaign click that did, is
    // campaign revenue — counting it on both pages is what inflated paid ROAS.
    const j = journeys.reddit;
    const { rows: before } = await q(
      "select orders from ad_revenue_daily where lower(utm_campaign) = lower($1)", [j.campaign],
    );
    await q("update orders set marketing_source_kind = 'campaign' where order_id = $1", [j.order.order_id]);
    const { rows: after } = await q(
      "select orders from ad_revenue_daily where lower(utm_campaign) = lower($1)", [j.campaign],
    );
    check(
      before.length === 1 && after.length === 0,
      "an order whose primary source is a campaign drops out of ad revenue",
      `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
    );
    await q("update orders set marketing_source_kind = null where order_id = $1", [j.order.order_id]);
  }

  // -------------------------------------------------------------------------
  section("7. Declining consent means no attribution, honestly");
  // -------------------------------------------------------------------------
  {
    const declined = await runJourney(browser, { ...PLATFORMS[0], platformKey: "tiktok" }, { consent: false, label: "noconsent" });
    check(
      !declined.afterWall || !declined.afterWall.first,
      "a visitor who declined the banner has no stored touch",
      JSON.stringify(declined.afterWall)?.slice(0, 160) ?? "(nothing stored)",
    );
    if (declined.order) {
      payOrder(declined.order.order_id);
      const rows = await attributionRows(declined.order.order_id);
      check(
        rows.length === 0,
        "and their order carries NO attribution row — 'we don't know' stays distinguishable from 'organic'",
        `${rows.length} row(s)`,
      );
    }
  }

  await browser.close();
}

main()
  .catch((error) => {
    failures += 1;
    console.error(`\nFATAL in "${currentSection}": ${error.message}\n${error.stack ?? ""}`);
  })
  .finally(async () => {
    await q("delete from ad_spend_daily where utm_campaign like $1", [`%${stamp}%`]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`\n${checks} checks: ${checks - failures} passed, ${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
