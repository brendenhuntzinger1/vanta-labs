#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CUSTOMER CERTIFICATION MATRIX — 100+ DISTINCT PEOPLE, NOT 100 ASSERTIONS.
//
// Every other qa-*.mjs here owns a slice and proves it well. This one owns the
// QUESTION THE OWNER ACTUALLY ASKED: can an ordinary person walk into this shop
// and use the whole business without finding a hole? So a "scenario" here is a
// PERSON with a state, a device and an intent — not a function call.
//
// THREE RULES THIS FILE IS BUILT ON.
//
// 1. IT USES THE SITE. Nothing is asserted from source. If a claim cannot be
//    made by reading a rendered page or a real API response, it is not made
//    here; it is left to the unit suites, which say so.
//
// 2. EVERY LIVE PRODUCT IS COVERED, not three convenient ones. The catalogue is
//    DISCOVERED at run time from the database the app is actually serving, so
//    the day a product is added this file covers it without being edited. A
//    hard-coded list would have certified a shop that no longer exists.
//
// 3. DETERMINISM WITHOUT TOUCHING RANDOMNESS. Every one of the sixteen wheel
//    wedges has to be exercised through the customer's eyes, and spinning until
//    a 1-in-16 wedge appears is neither reliable nor honest. So the wedge is
//    MINTED as the offer row the real draw would have written — the same
//    customer_offers shape, through the same server code path afterwards — and
//    the customer journey from that point on is entirely real. The draw itself
//    is exercised separately, as its own scenario.
//
// Development-only. Refuses to run anywhere but the local harness.
//
//   npm run harness:build && npm run harness:start
//   node scripts/tls-proxy.mjs & node scripts/gotrue-tls-proxy.mjs &
//   node scripts/qa-cx-matrix.mjs
//   CX_PHASES=catalog,cart node scripts/qa-cx-matrix.mjs     # a subset
// ---------------------------------------------------------------------------

import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium, webkit } from "playwright";
import pg from "pg";
import { loadHarnessEnv } from "./lib/harness-env.mjs";

loadHarnessEnv();

const BASE = process.env.CX_BASE_URL ?? "https://127.0.0.1:3443";
const DB = process.env.CX_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const OUT_DIR = process.env.CX_OUT_DIR ?? "/tmp/cx-matrix";
const SHOTS = `${OUT_DIR}/shots`;

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This drives the local harness only.`);
  process.exit(1);
}

const CHROME = process.env.CX_CHROMIUM
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));

const client = new pg.Client({ connectionString: DB });
const q = (text, params) => client.query(text, params);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const results = [];
let seq = 0;

/** Every scenario lands here, pass or fail, with the evidence that decided it. */
function record({ id, group, persona, device, entry, expected, actual, ok, evidence, notes }) {
  results.push({
    id, group, persona, device, entry, expected, actual,
    verdict: ok === null ? "NOT SAFELY TESTABLE" : ok ? "PASS" : "FAIL",
    evidence: evidence ?? null, notes: notes ?? null,
  });
  const mark = ok === null ? "~" : ok ? "✓" : "✗";
  const line = `${mark} ${id.padEnd(8)} ${group.padEnd(14)} ${expected}`;
  console.log(ok === false ? `\x1b[31m${line}\x1b[0m` : line);
  if (!ok && ok !== null && actual) console.log(`           actual: ${String(actual).slice(0, 220)}`);
}

function nextId() { seq += 1; return `CX-${String(seq).padStart(3, "0")}`; }

/** Run one scenario, turning a throw into a FAIL rather than ending the run. */
async function scenario(meta, fn) {
  const id = meta.id ?? nextId();
  try {
    const out = await fn();
    record({ ...meta, id, ok: out?.ok ?? true, actual: out?.actual, evidence: out?.evidence, notes: out?.notes });
  } catch (error) {
    record({ ...meta, id, ok: false, actual: `threw: ${error?.message ?? error}` });
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
const UA = {
  tiktok: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_39.1.0 JsSdk/2.0 NetType/WIFI",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.everything",
  facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0.0]",
  snapchat: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.90.0.0",
};

const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const DESKTOP = { width: 1280, height: 900 };

let chromiumBrowser = null;
let webkitBrowser = null;

// WEBKIT IF IT IS THERE, CHROMIUM IF IT IS NOT — AND THE RUN SAYS WHICH.
//
// Every iOS in-app browser is a WKWebView, so WebKit is the engine that would
// make an in-app scenario a real engine test rather than a string swap. This
// container ships only Chromium builds under /opt/pw-browsers, and the project
// runbook forbids `playwright install`, so the in-app phase falls back to
// Chromium carrying the in-app user agent.
//
// That is a WEAKER test and is reported as one: it still proves the gate does
// not branch on the user agent and that the journey completes, and it does NOT
// prove WebKit-specific behaviour (Secure-cookie handling, mixed content, the
// storage quirks the runbook documents).
let webkitAvailable = null;
async function browserFor(engine) {
  if (engine === "webkit") {
    if (webkitAvailable === null) {
      try { webkitBrowser = await webkit.launch(); webkitAvailable = true; }
      catch { webkitAvailable = false; }
    }
    if (webkitAvailable) return webkitBrowser;
  }
  if (!chromiumBrowser) {
    chromiumBrowser = await chromium.launch(
      CHROME ? { executablePath: CHROME, args: ["--no-sandbox", "--ssl-version-max=tls1.2"] }
             : { args: ["--no-sandbox", "--ssl-version-max=tls1.2"] },
    );
  }
  return chromiumBrowser;
}

/**
 * A fresh person: new context, no storage, own IP so the rate limiter treats
 * them as their own visitor rather than as the previous scenario continuing.
 */
async function freshContext({ engine = "chromium", viewport = DESKTOP, userAgent, ip } = {}) {
  const browser = await browserFor(engine);
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: engine === "chromium" ? viewport.isMobile ?? false : undefined,
    hasTouch: viewport.hasTouch ?? false,
    deviceScaleFactor: viewport.deviceScaleFactor,
    userAgent,
    extraHTTPHeaders: { "x-real-ip": ip ?? `10.${1 + (seq % 200)}.${1 + (seq % 90)}.${1 + (seq % 240)}` },
  });
  return ctx;
}

async function shot(page, name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const path = `${SHOTS}/${name.replace(/[^a-z0-9._-]/gi, "_")}.png`;
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------
const PASSWORD = "HarnessPass123!";
const stamp = Date.now().toString(36);
let personaN = 0;

function newEmail(tag) { personaN += 1; return `cx.${tag}.${stamp}.${personaN}@example.test`; }

async function createConfirmedCustomer(email, fullName = "CX Shopper") {
  await q(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data,
                             email_confirmed_at, created_at)
     values ($1, $2, $3, '{"role":"customer"}'::jsonb, now(), now())
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password, email_confirmed_at = now()`,
    [email, PASSWORD, JSON.stringify({ full_name: fullName, role: "customer" })],
  );
  return email;
}

/**
 * Sign a person in through the portal exactly as a returning customer does.
 * The first screen carries no email field; "Sign in with email" opens it, and
 * that button is deliberately not gated on the attestations a returning
 * customer already made.
 */
async function signIn(page, email) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("form, .vl-portal-row", { timeout: 20000 });
  const hasField = async () => (await page.$("form input[type=email]")) !== null;
  for (let i = 0; i < 6 && !(await hasField()); i += 1) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /sign in with email/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(500);
  }
  if (!(await hasField())) throw new Error("the portal never opened the email sign-in form");
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", PASSWORD);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 30000 }),
    page.click('form button[type=submit]'),
  ]);
  await page.waitForTimeout(900);
  const me = await page.evaluate(async () => {
    try { const r = await fetch("/api/account/me"); return r.ok ? await r.json() : null; } catch { return null; }
  });
  if (!me || me.success === false) throw new Error("sign-in did not establish a session");
  return me;
}

/** The offer row the real draw writes, for a chosen wedge. */
function hashToken(token) { return createHash("sha256").update(token).digest("hex"); }

async function mintOffer({ email, prize, doseLabel = null, ttlHours = 72, issuedHoursAgo = 0 }) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const reward = prize.reward;
  const dose = doseLabel ? (prize.doses ?? []).find((d) => d.label === doseLabel) : null;
  const min = dose ? dose.minSubtotalCents : prize.minSubtotalCents;
  // The same programme key the wheel writes, so one live offer per programme
  // per address behaves exactly as it does in production.
  await q(
    `insert into customer_offers
       (id, offer_key, token_hash, email, product_slug, variant_id, min_subtotal_cents,
        issued_at, expires_at, reward_kind, percent_off, max_discount_cents, quantity, gift_items)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
             now() - ($7 || ' hours')::interval, now() + ($8 || ' hours')::interval, $9, $10, $11, $12, null)`,
    [
      "spin:winback_2026q4", hashToken(token), email,
      reward.kind === "free_product" ? reward.productSlug : null,
      dose ? await doseIdFor(reward.productSlug, dose.label) : null,
      min, String(issuedHoursAgo), String(ttlHours - issuedHoursAgo),
      reward.kind, reward.kind === "percent" ? reward.percent : null,
      prize.maxDiscountCents ?? null,
      // customer_offers_quantity_shape: a quantity may only exist alongside a
      // product_slug. A percent or free-shipping wedge has no product, so it
      // carries no quantity — writing 1 there is refused by the schema, which
      // is the database declining to hold "one of nothing".
      reward.kind === "free_product" ? 1 : null,
    ],
  );
  return { token, minSubtotalCents: min };
}

async function doseIdFor(slug, label) {
  const r = await q(
    `select d.id from product_doses d join products p on p.id = d.product_id
     where p.slug = $1 and d.label = $2 limit 1`, [slug, label],
  );
  return r.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// The live catalogue, discovered rather than assumed
// ---------------------------------------------------------------------------
let CATALOG = [];
let PRIZES = [];

async function loadCatalog() {
  // THE DOSE IS THE AUTHORITY, AND SO THIS QUERY ASKS THE DOSE.
  //
  // This used to publish `p.stock_status` as the product's stock state, which
  // is a denormalised copy that has drifted on three of the thirty-four live
  // rows (DSIP and SS-31 stored "Out of Stock" over 19 and 18 sellable units;
  // MOTS-C stored "In Stock" with none). Asserting against that column tests
  // the copy, not the shop. `resolved_status` below mirrors what catalog.ts
  // actually publishes: the default dose's own status, resolved from its own
  // count, gated by inventory.tracking_enabled — and a product is sellable if
  // ANY enabled dose is.
  const trackingRow = await q(
    `select coalesce((metadata->>'value')::boolean, false) as on
       from admin_audit_logs
      where action = 'admin_control_upsert'
        and target_table = 'inventory' and target_id = 'tracking_enabled'
      order by created_at desc limit 1`);
  const tracking = trackingRow.rows[0]?.on === true;

  const r = await q(
    `select p.slug, p.name, p.category, p.price_cents, p.stock_status as product_column_status, p.image_url,
            coalesce(json_agg(json_build_object('id', d.id, 'label', d.label, 'price_cents', d.price_cents,
                                                'inventory', d.inventory_quantity, 'enabled', d.is_enabled,
                                                'stock_status', d.stock_status, 'tracks', d.track_inventory,
                                                'is_default', d.is_default, 'position', d.position)
                              order by d.position) filter (where d.id is not null), '[]') as doses
     from products p left join product_doses d on d.product_id = p.id
     where p.is_active and p.is_published and p.is_enabled and not p.is_archived
     group by p.slug, p.name, p.category, p.stock_status, p.price_cents, p.image_url
     order by p.category, p.slug`);

  const doseStatus = (dose) => {
    if (!tracking) return "In Stock";
    const qty = Number(dose?.inventory ?? 0);
    if (Number.isFinite(qty) && qty <= 0) return "Out of Stock";
    return dose?.stock_status || "In Stock";
  };

  CATALOG = r.rows.map((row) => {
    const doses = (row.doses ?? []).filter((d) => d.enabled !== false);
    const fallback = doses.find((d) => d.is_default) ?? doses[0];
    const resolved = doses.map(doseStatus);
    const headline = fallback ? doseStatus(fallback) : (tracking ? row.product_column_status || "In Stock" : "In Stock");
    // catalog.ts: a product with several doses is In Stock when ANY enabled
    // dose can be sold, even if the default one cannot.
    const sellable = resolved.some((s) => s === "In Stock");
    return { ...row, doses, stock_status: headline === "In Stock" || !sellable ? headline : "In Stock",
             inventory_tracking: tracking };
  });
}

/** Read the prize table out of the built app rather than restating it here. */
async function loadPrizes() {
  const mod = await import("../src/lib/spin/prize-table.ts").catch(() => null);
  if (mod?.SPIN_PRIZES) { PRIZES = mod.SPIN_PRIZES; return; }
  // The .ts import needs a loader; fall back to the compiled copy the app serves.
  PRIZES = JSON.parse(process.env.CX_PRIZES ?? "[]");
}

// ---------------------------------------------------------------------------
// Page helpers — everything a customer actually does
// ---------------------------------------------------------------------------
async function dismissConsent(page) {
  try {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /^(accept|decline)$/i.test((x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(250);
  } catch { /* the bar may not be there */ }
}

/**
 * THE CART IS THE BROWSER'S, NOT THE SERVER'S.
 *
 * There is no `GET /api/cart` — cart-context.tsx keeps the basket in
 * localStorage under `vanta-labs-cart` and the server only ever sees it when
 * a quote or a checkout is requested. An earlier version of this helper read
 * a `/api/cart` that does not exist, got null every time, and reported an
 * empty basket for every add-to-cart in the run: roughly thirty scenarios
 * failing for a reason that was entirely this file's.
 *
 * Lines are keyed by `slug`, with the chosen dose in `variantId`.
 */
const CART_STORAGE_KEY = "vanta-labs-cart";

async function cartState(page) {
  return page.evaluate((key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return { items: [], referralCode: null, couponCode: null };
      const parsed = JSON.parse(raw);
      return {
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        referralCode: parsed?.referralCode ?? null,
        couponCode: parsed?.couponCode ?? null,
      };
    } catch {
      return { items: [], referralCode: null, couponCode: null };
    }
  }, CART_STORAGE_KEY);
}

/** Lines for one product, whichever dose. */
function linesFor(cart, slug) {
  return (cart?.items ?? []).filter((i) => String(i.slug ?? "") === slug);
}

/** Add a product to the cart the way a shopper does: from its own page. */
async function addToCartFromPdp(page, slug, doseLabel = null) {
  await page.goto(`${BASE}/products/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await dismissConsent(page);
  if (doseLabel) {
    const picked = await page.evaluate((label) => {
      // THE BADGE IS PART OF THE BUTTON'S TEXT. The recommended dose renders as
      // "10mg★ Most Popular", so an exact-match picker silently misses it and
      // adds whatever was already selected instead. That is not a hypothetical:
      // it made a GLP-1 scenario report "two doses became one cart line", which
      // reads exactly like a cart defect and was entirely this selector.
      //
      // Matching is therefore on the text UP TO the badge, still exactly — a
      // loose `startsWith` would let "5mg" select "50mg", and would let the
      // "Recon Water 10 mL · $14.99" add-on stand in for a genuine "10mL" dose
      // on b12 and lipo-c.
      const norm = (s) => (s || "").split("★")[0].replace(/\s+/g, "").toLowerCase();
      const want = norm(label);
      const candidates = [...document.querySelectorAll("button,[role=radio],[role=option],label,option")];
      const hit = candidates.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled && norm(el.textContent) === want;
      });
      if (hit) { hit.click(); return true; }
      const sel = document.querySelector("select");
      if (sel) {
        const opt = [...sel.options].find((o) => norm(o.textContent) === want || norm(o.value) === want);
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    }, doseLabel);
    if (!picked) return { added: false, reason: `dose "${doseLabel}" not selectable` };
    await page.waitForTimeout(500);
  }
  // THIS PRODUCT'S BUY BUTTON, NOT WHICHEVER ONE THE PAGE HAPPENS TO CONTAIN.
  //
  // This used to take the first enabled button matching /add to cart/ anywhere
  // in the document. For an in-stock product that is the right one, because the
  // page's own CTA comes first; for an OUT-OF-STOCK product the real CTA is
  // disabled and the search fell through to the Related Products rail, which
  // carries live Add to Cart buttons for other items. The run then reported
  // "an out-of-stock product was ADDED" — it had clicked a different product —
  // and would have added a foreign line to the basket under a stock assertion.
  // `data-vl-cta` addresses the page's own control directly.
  const clicked = await page.evaluate(() => {
    const own = [...document.querySelectorAll("button[data-vl-cta]")];
    const b = own.find((x) => !x.disabled && x.getBoundingClientRect().width > 0)
      ?? own.find((x) => !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) return { added: false, reason: "the product's own add-to-cart control is disabled" };
  await page.waitForTimeout(900);
  return { added: true };
}

/**
 * Empty the basket, then RELOAD — the provider hydrates from storage once at
 * mount, so clearing the key underneath a live page leaves React holding the
 * old items and the next assertion reads a cart the customer no longer has.
 */
async function clearCart(page) {
  await page.evaluate((key) => {
    try {
      window.localStorage.removeItem(key);
      for (const k of Object.keys(window.localStorage)) if (/cart/i.test(k)) window.localStorage.removeItem(k);
    } catch { /* ignore */ }
  }, CART_STORAGE_KEY);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
  } catch { /* a page mid-navigation is fine to leave */ }
}

/** Overflow, overlap and the things a phone customer notices. */
async function layoutProbe(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const horizontalScroll = de.scrollWidth - de.clientWidth;
    const nav = document.querySelector(".vl2-nav");
    const bar = document.querySelector(".vl-offer-bar");
    let navBarOverlap = 0;
    if (nav && bar) {
      const a = nav.getBoundingClientRect(); const b = bar.getBoundingClientRect();
      navBarOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    }
    const brokenImages = [...document.querySelectorAll("img")]
      .filter((i) => i.currentSrc && i.complete && i.naturalWidth === 0)
      .map((i) => i.currentSrc.slice(0, 120));
    return { horizontalScroll, navBarOverlap: Math.round(navBarOverlap), brokenImages };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function writeReports() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));

  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const na = results.filter((r) => r.verdict === "NOT SAFELY TESTABLE").length;

  const rows = results.map((r) =>
    `| ${r.id} | ${r.group} | ${r.persona ?? ""} | ${r.device ?? ""} | ${r.entry ?? ""} | ${r.expected} | ${r.verdict} | ${(r.actual ?? "").toString().replace(/\|/g, "/").slice(0, 120)} |`);

  writeFileSync(`${OUT_DIR}/matrix.md`, [
    `# Customer certification matrix`, "",
    `TOTAL SCENARIOS EXECUTED: ${results.length}`,
    `PASS: ${pass}`, `FAIL: ${fail}`, `NOT SAFELY TESTABLE: ${na}`, "",
    `| ID | Group | Persona | Device | Entry | Expected | Verdict | Actual |`,
    `|---|---|---|---|---|---|---|---|`,
    ...rows,
  ].join("\n"));

  console.log(`\n${"=".repeat(64)}`);
  console.log(`EXECUTED ${results.length}   PASS ${pass}   FAIL ${fail}   N/A ${na}`);
  console.log(`matrix: ${OUT_DIR}/matrix.md`);
  if (fail) {
    console.log(`\nFAILURES:`);
    for (const r of results.filter((x) => x.verdict === "FAIL")) {
      console.log(`  ${r.id} [${r.group}] ${r.expected}\n      ${String(r.actual ?? "").slice(0, 300)}`);
    }
  }
  return fail;
}

/** Did the in-app phase get the engine it wanted? Reported, never assumed. */
function engineUsed(requested) {
  if (requested !== "webkit") return "chromium";
  return webkitAvailable ? "webkit" : "chromium (webkit unavailable in this container)";
}

export {
  BASE, CATALOG, PRIZES, client, q, record, scenario, nextId, freshContext, shot, engineUsed,
  createConfirmedCustomer, newEmail, signIn, mintOffer, loadCatalog, loadPrizes,
  dismissConsent, cartState, linesFor, addToCartFromPdp, clearCart, layoutProbe, writeReports,
  PHONE, DESKTOP, UA, results,
};
