#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE LIFECYCLE EMAIL ENGINE, EXERCISED END TO END.
//
// Not "does Resend accept a message" — that is answered elsewhere. This drives
// the customer journeys the retention system exists for, against the local
// harness, reading the emails the customer would actually receive:
//
//   subscriber  → welcome intro → welcome offer → (purchase) → welcome stops
//   guest cart  → 1h reminder → 24h details → 72h last note (with code)
//               → purchase → sequence ends; a second cart waits its cooldown;
//               an emptied cart is never mailed
//   unsubscribe → nothing marketing goes out again, and the reason is recorded
//   bounce      → the provider webhook suppresses the address
//   campaign    → preview, test, send, and a second send is refused
//
// Time is advanced by backdating rows, because the sweep reads the clock and
// nothing else. Development-only; refuses to run against anything but the
// harness. Emails are read from EMAIL_CAPTURE_DIR (smtp-sink.mjs / noop.ts).
//
//   EMAIL_CAPTURE_DIR=/tmp/vanta-qa node scripts/qa-lifecycle-email.mjs
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CAPTURE_DIR = process.env.EMAIL_CAPTURE_DIR ?? "/tmp/vanta-qa";
const CAPTURE = `${CAPTURE_DIR}/captured-emails.jsonl`;
const SHOTS = `${CAPTURE_DIR}/lifecycle-shots`;
const CRON_SECRET = process.env.CRON_SECRET ?? "harness-cron-secret";
const WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET ?? "harness-email-webhook-secret";
const ADMIN = { username: process.env.QA_ADMIN_USER ?? "qaadmin", password: process.env.QA_ADMIN_PASS ?? "HarnessAdminPass123", passcode: process.env.QA_ADMIN_PASSCODE ?? "123456" };

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const stamp = randomBytes(3).toString("hex");

const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

// --- the mailbox -------------------------------------------------------------
const mailOffset = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);
function mailSince(offset) {
  if (!existsSync(CAPTURE)) return [];
  const buf = readFileSync(CAPTURE);
  return buf.subarray(Math.min(offset, buf.length)).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}
const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/=\r?\n/g, "");
/** The SMTP sink lower-cases header names; the noop provider keeps them as sent. */
const header = (mail, name) => {
  const h = mail.headers ?? {};
  return h[name] ?? h[name.toLowerCase()] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
};
/** The plain-text part, or the HTML with its tags stripped when the capture holds no text part. */
const textOf = (mail) => mail.text ?? decode(mail.html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
function linksIn(mail) {
  const found = decode(mail.html).match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(found)];
}

// --- the clock ----------------------------------------------------------------
async function sweep() {
  const r = await fetch(`${BASE}/api/cron/sweep`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  const body = await r.json();
  assert(r.status === 200 && body.success, `sweep answered ${r.status}`);
  return body;
}
async function sweepAndMail(fn) {
  const offset = mailOffset();
  const body = await sweep();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { body, mail: mailSince(offset).filter(fn ?? (() => true)) };
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// --- the browser --------------------------------------------------------------
async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const appeared = await page.waitForSelector("[role=dialog]", { timeout: 8000 }).then(() => true).catch(() => false);
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
  assert(await enabled(), "the age gate's submit button never enabled");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });
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
    const b = [...document.querySelectorAll("button")].find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  });
  await page.waitForTimeout(2000);
  return clicked ? href : null;
}

async function adminLogin(page) {
  await page.goto(`${BASE}/vault`, { waitUntil: "domcontentloaded" });
  const r = await page.evaluate(async (creds) => {
    const res = await fetch("/api/admin/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify(creds),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, ADMIN);
  assert(r.status === 200 && r.body?.success !== false, `admin login answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
}
async function postAsPage(page, url, data, method = "POST") {
  return page.evaluate(async ([u, d, m]) => {
    const res = await fetch(u, { method: m, headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: d === undefined ? undefined : JSON.stringify(d) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [url, data, method]);
}

/** Render a captured email at phone and desktop widths; fail on sideways scroll. */
async function renderMail(context, mail, label) {
  mkdirSync(SHOTS, { recursive: true });
  const out = [];
  for (const [device, width, height] of [["mobile", 390, 844], ["desktop", 1280, 900]]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await page.setContent(decode(mail.html), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const file = `${SHOTS}/${label}-${device}.png`;
    await page.screenshot({ path: file, fullPage: true });
    await page.close();
    assert(overflow <= 0, `${label} scrolls sideways by ${overflow}px at ${width}px`);
    out.push(file);
  }
  return out;
}

// ============================================================================
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--ssl-version-max=tls1.2"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Every automation on, with short delays, so the clock can be walked.
  await q(`update email_automations set enabled = true`);
  await q(`update email_automations set delay_days = case key when 'welcome_intro' then 1 when 'welcome_no_purchase' then 3 when 'post_purchase' then 5 when 'replenishment' then 30 when 'winback_30' then 45 when 'winback_60' then 75 end`);
  await q(`update email_automations set offer_key = 'winback_60_percent_15' where key = 'welcome_no_purchase'`);

  // ---------------------------------------------------------------------------
  section("1. Subscriber → welcome sequence");
  const subscriber = `sub.${stamp}@example.test`;
  let subscriberUserId = null;

  await step("the signup form offers a marketing opt-in, ticked by default", async () => {
    await passAgeGate(page);
    await page.goto(`${BASE}/account/login?mode=signup`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const toggled = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button, a")].find((x) => /create (an )?account|sign up|join/i.test(x.textContent || ""));
      if (b && !document.querySelector('[data-testid="signup-marketing-opt-in"]')) { b.click(); return "clicked"; }
      return "already";
    });
    await page.waitForSelector('[data-testid="signup-marketing-opt-in"]', { timeout: 8000 });
    const checked = await page.$eval('[data-testid="signup-marketing-opt-in"]', (el) => el.checked);
    assert(checked, "the opt-in box is not ticked by default");
    await page.screenshot({ path: `${SHOTS}/signup-opt-in.png`, fullPage: true });
    return `box present and ticked (${toggled})`;
  });

  await step("signing up with the box ticked records consent in both stores and sends the confirmation", async () => {
    const offset = mailOffset();
    const r = await page.evaluate(async ([email]) => {
      const res = await fetch("/api/auth/signup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "HarnessPass123!", fullName: "Sam Subscriber", businessType: "Other", referredByCode: "", captchaToken: "", nextPath: "/account", marketingOptIn: true }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, [subscriber]);
    assert(r.status === 200 && r.body?.success, `signup answered ${r.status}`);
    const user = await q(`select id from auth.users where email = $1`, [subscriber]);
    assert(user.rows.length === 1, "no auth user created");
    subscriberUserId = user.rows[0].id;
    const pref = await q(`select marketing_emails from customer_preferences where user_id = $1`, [subscriberUserId]);
    assert(pref.rows[0]?.marketing_emails === true, "customer_preferences.marketing_emails is not true");
    const sub = await q(`select source, opted_in_at from marketing_subscribers where email = $1`, [subscriber]);
    assert(sub.rows[0]?.source === "signup", "marketing_subscribers row missing or wrong source");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const confirmation = mailSince(offset).find((m) => m.to === subscriber && /confirm/i.test(m.subject));
    assert(confirmation, "no confirmation email captured");
    assert(!header(confirmation, "List-Unsubscribe"), "a transactional confirmation carried List-Unsubscribe");
    return "preference + subscriber rows written; confirmation sent without marketing headers";
  });

  await step("nothing marketing is sent before the welcome delay has passed", async () => {
    const { mail } = await sweepAndMail((m) => m.to === subscriber);
    assert(mail.length === 0, `expected nothing, got ${mail.map((m) => m.subject).join(", ")}`);
  });

  let welcomeIntro = null;
  await step("a day later the welcome introduction goes out, once", async () => {
    await q(`update marketing_subscribers set opted_in_at = $2 where email = $1`, [subscriber, ago(2 * DAY)]);
    await q(`update auth.users set created_at = $2 where id = $1`, [subscriberUserId, ago(2 * DAY)]);
    const first = await sweepAndMail((m) => m.to === subscriber);
    assert(first.mail.length === 1, `expected one email, got ${first.mail.length}: ${first.mail.map((m) => m.subject).join(", ")}`);
    welcomeIntro = first.mail[0];
    assert(/Vanta Labs/i.test(welcomeIntro.subject), `unexpected subject ${welcomeIntro.subject}`);
    assert(header(welcomeIntro, "List-Unsubscribe") && header(welcomeIntro, "List-Unsubscribe-Post"), "marketing mail without one-click unsubscribe headers");
    assert(/Harness Way/.test(decode(welcomeIntro.html)), "postal address missing from the marketing footer");
    const second = await sweepAndMail((m) => m.to === subscriber);
    assert(second.mail.length === 0, "the intro was sent twice");
    return `"${welcomeIntro.subject}" — send-once held on the second sweep`;
  });

  await step("the welcome offer waits out the quiet period, then goes out with a working gift link", async () => {
    await q(`update marketing_subscribers set opted_in_at = $2 where email = $1`, [subscriber, ago(4 * DAY)]);
    await q(`update auth.users set created_at = $2 where id = $1`, [subscriberUserId, ago(4 * DAY)]);
    const quiet = await sweepAndMail((m) => m.to === subscriber);
    assert(quiet.mail.length === 0, `the offer went out inside the 24h quiet period: ${quiet.mail.map((m) => m.subject).join(", ")}`);
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [subscriber, ago(2 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === subscriber);
    assert(mail.length === 1, `expected the offer, got ${mail.length}`);
    const offer = mail[0];
    const cta = linksIn(offer).find((l) => /\/api\/email\/automation-click/.test(l));
    assert(cta, "the offer carries no tracked CTA");
    const r = await fetch(cta, { redirect: "manual" });
    assert(r.status >= 300 && r.status < 400, `automation click answered ${r.status}`);
    const location = r.headers.get("location") ?? "";
    assert(location.startsWith(BASE), `click redirected off-site: ${location}`);
    const setCookie = r.headers.get("set-cookie") ?? "";
    assert(/vl_offer=/.test(setCookie), "the gift cookie was not set by the click");
    assert(/vl_automation=/.test(setCookie), "the attribution cookie was not set by the click");
    const offerRow = await q(`select offer_key, expires_at from customer_offers where email = $1`, [subscriber]);
    assert(offerRow.rows.length === 1, "no customer_offers row minted for the welcome gift");
    const clicks = await q(`select count(*)::int as n from email_automation_clicks where email = $1`, [subscriber]);
    assert(clicks.rows[0].n === 1, "the click was not recorded");
    await renderMail(context, offer, "welcome-offer");
    return `"${offer.subject}" → ${location.replace(BASE, "")}, offer ${offerRow.rows[0].offer_key} minted, click recorded`;
  });

  await step("a subscriber who buys never receives the welcome sequence", async () => {
    const buyer = `buyer.${stamp}@example.test`;
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [buyer, ago(2 * DAY)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'Buyer', 'paid', 69, 69, 0, 0, 'USD', $3, 'product')`, [`order-qa-${stamp}-buyer`, buyer, ago(1 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === buyer);
    assert(mail.length === 0, `a buyer got welcome mail: ${mail.map((m) => m.subject).join(", ")}`);
  });

  // ---------------------------------------------------------------------------
  section("2. Guest checkout abandonment → recovery sequence");
  const guest = `guest.${stamp}@example.test`;
  let cartId = null;

  await step("a guest who types an email at checkout has the cart tracked", async () => {
    await context.clearCookies();
    await passAgeGate(page);
    const product = await addFirstProductToCart(page);
    assert(product, "could not add a product");
    await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.fill("input[type=email]", guest);
    await page.waitForTimeout(3500);
    const row = await q(`select id, status, cart_value_cents, customer_user_id from abandoned_carts where email = $1 order by first_seen_at desc limit 1`, [guest]);
    assert(row.rows.length === 1, "no abandoned_carts row for the guest");
    cartId = row.rows[0].id;
    assert(row.rows[0].customer_user_id === null, "a guest cart was linked to a user");
    return `cart ${cartId} tracked, ${row.rows[0].cart_value_cents}c`;
  });

  await step("nothing is sent while the shopper is still active", async () => {
    const { mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 0, "recovery mail went out inside the hour");
  });

  let stage1 = null;
  await step("one hour after the last change the first reminder goes out, and only that one", async () => {
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where id = $1`, [cartId, ago(2 * HOUR)]);
    const { body, mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 1, `expected one, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    stage1 = mail[0];
    assert(body.cartRecovery.t30mSent === 1, `sweep reported ${JSON.stringify(body.cartRecovery)}`);
    assert(!/SAVE-/.test(textOf(stage1)), "the first reminder carried a discount");
    assert(header(stage1, "List-Unsubscribe-Post") === "List-Unsubscribe=One-Click", "missing one-click unsubscribe");
    await renderMail(context, stage1, "cart-1h");
    return `"${stage1.subject}"`;
  });

  await step("the restore link in the email opens the cart", async () => {
    const tracked = linksIn(stage1).find((l) => /\/api\/email\/track\/click/.test(l));
    assert(tracked, "no tracked restore link");
    const r = await fetch(tracked, { redirect: "manual" });
    const location = r.headers.get("location") ?? "";
    assert(/\/cart\/restore\?id=/.test(location), `tracked link redirected to ${location}`);
    const restore = await fetch(`${BASE}/api/cart/restore?id=${cartId}`);
    const body = await restore.json();
    assert(body.success && body.items.length > 0, "the restore endpoint returned no items");
    const clicked = await q(`select clicked_at from abandoned_cart_emails where abandoned_cart_id = $1 and stage = 't30m'`, [cartId]);
    assert(clicked.rows[0]?.clicked_at, "the click was not stamped on the stage row");
    return `→ ${location.replace(BASE, "")}, ${body.items.length} item(s) restorable, click stamped`;
  });

  await step("a cart first seen 25 hours ago gets the details message, not a catch-up of stage one", async () => {
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where id = $1`, [cartId, ago(25 * HOUR)]);
    const { mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 1, `expected one, got ${mail.length}`);
    assert(/testing|shipping|support/i.test(mail[0].subject), `unexpected subject ${mail[0].subject}`);
    assert(!/SAVE-/.test(textOf(mail[0])), "the 24h message carried a discount");
    const again = await sweepAndMail((m) => m.to === guest);
    assert(again.mail.length === 0, "the 24h message repeated");
    await renderMail(context, mail[0], "cart-24h");
    return `"${mail[0].subject}"`;
  });

  let lastNote = null;
  await step("at 72 hours the last note carries a real, live code — and the sequence ends", async () => {
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where id = $1`, [cartId, ago(73 * HOUR)]);
    const { mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 1, `expected one, got ${mail.length}`);
    lastNote = mail[0];
    const code = textOf(lastNote).match(/SAVE-[A-Z0-9]+/)?.[0];
    assert(code, "no code in the last note");
    const coupon = await q(`select assigned_email, active, ends_at, discount_value from coupons where code = $1`, [code]);
    assert(coupon.rows.length === 1 && coupon.rows[0].assigned_email === guest, "the code is not a live coupon bound to the shopper");
    assert(new Date(coupon.rows[0].ends_at) > new Date(), "the code is already expired");
    const validate = await fetch(`${BASE}/api/coupons/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, email: guest, subtotal: 100 }) });
    const vbody = await validate.json().catch(() => null);
    const later = await sweepAndMail((m) => m.to === guest);
    assert(later.mail.length === 0, "mail continued after the last note");
    await renderMail(context, lastNote, "cart-72h");
    return `${code} (${coupon.rows[0].discount_value}% off), validate → ${validate.status} ${vbody?.success ?? vbody?.valid ?? ""}`;
  });

  await step("a purchase ends a live sequence even when the payment webhook's own mark is missed", async () => {
    const buyer = `cartbuyer.${stamp}@example.test`;
    const cart = await q(`insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
      values ($1, $2, 'Cart Buyer', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":1,"unitPrice":47.99}]'::jsonb, 4799, $3, $3, 'active') returning id`, [`sess-${stamp}-buyer`, buyer, ago(2 * HOUR)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'Cart Buyer', 'paid', 47.99, 47.99, 0, 0, 'USD', $3, 'product')`, [`order-qa-${stamp}-cartbuyer`, buyer, ago(1 * HOUR)]);
    const { body, mail } = await sweepAndMail((m) => m.to === buyer);
    assert(mail.length === 0, "a shopper who had paid was mailed to finish their cart");
    const row = await q(`select status, recovered_order_id from abandoned_carts where id = $1`, [cart.rows[0].id]);
    assert(row.rows[0].status === "recovered", `cart is ${row.rows[0].status}, not recovered`);
    return `marked recovered by order ${row.rows[0].recovered_order_id} (sweep recoveredLate=${body.cartRecovery.recoveredLate})`;
  });

  await step("a second cart from the same address inside seven days does not start a new sequence", async () => {
    const cart = await q(`insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
      values ($1, $2, 'Sam', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":2,"unitPrice":47.99}]'::jsonb, 9598, $3, $3, 'active') returning id`, [`sess-${stamp}-second`, guest, ago(2 * HOUR)]);
    const { body, mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 0, "a second sequence started inside the cooldown");
    assert(body.cartRecovery.heldForCooldown >= 1, `sweep did not report the hold: ${JSON.stringify(body.cartRecovery)}`);
    await q(`update abandoned_carts set status = 'expired' where id = $1`, [cart.rows[0].id]);
    return "held for cooldown";
  });

  await step("a shopper who empties the cart is never mailed about it", async () => {
    const empty = `empty.${stamp}@example.test`;
    const sessionId = `sess-${stamp}-empty`;
    const track = await fetch(`${BASE}/api/cart/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, email: empty, items: [{ slug: "ghk-cu", name: "GHK-Cu 50mg", quantity: 1, unitPrice: 47.99 }], cartValueCents: 4799 }) });
    assert((await track.json()).tracked === true, "guest tracking refused");
    const clear = await fetch(`${BASE}/api/cart/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, items: [] }) });
    assert((await clear.json()).cleared === true, "clearing the cart was refused");
    const row = await q(`select status from abandoned_carts where session_id = $1`, [sessionId]);
    assert(row.rows[0]?.status === "cleared", `cart is ${row.rows[0]?.status}`);
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where session_id = $1`, [sessionId, ago(2 * HOUR)]);
    const { mail } = await sweepAndMail((m) => m.to === empty);
    assert(mail.length === 0, "a cleared cart was mailed");
  });

  await step("the track endpoint refuses a provider sink address and rate-limits guests", async () => {
    const sink = await fetch(`${BASE}/api/cart/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: `sess-${stamp}-sink`, email: "bounced@resend.dev", items: [{ slug: "ghk-cu", name: "x", quantity: 1, unitPrice: 1 }], cartValueCents: 100 }) });
    assert((await sink.json()).tracked === false, "a sink address was tracked");
    let refused = 0;
    for (let i = 0; i < 14; i += 1) {
      const r = await fetch(`${BASE}/api/cart/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: `sess-${stamp}-rl-${i}`, email: `flood.${stamp}@example.test`, items: [{ slug: "ghk-cu", name: "x", quantity: 1, unitPrice: 1 }], cartValueCents: 100 }) });
      if ((await r.json()).tracked === false) refused += 1;
    }
    assert(refused >= 1, "fourteen guest snapshots for one address were all accepted");
    return `${refused} of 14 refused past the per-address limit`;
  });

  // ---------------------------------------------------------------------------
  section("3. Post-purchase, replenishment and win-back");
  const customer = `cust.${stamp}@example.test`;
  await step("first-order follow-up goes out after the delay, and not for a second order", async () => {
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [customer, ago(40 * DAY)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'Cust', 'paid', 69, 69, 0, 0, 'USD', $3, 'product')`, [`order-qa-${stamp}-c1`, customer, ago(6 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === customer);
    assert(mail.length === 1, `expected the follow-up, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    assert(/order/i.test(mail[0].subject), `unexpected subject ${mail[0].subject}`);
    await renderMail(context, mail[0], "post-purchase");
    return `"${mail[0].subject}"`;
  });

  await step("the reorder reminder fires for the latest order and stops once they reorder", async () => {
    await q(`update orders set created_at = $2 where order_id = $1`, [`order-qa-${stamp}-c1`, ago(32 * DAY)]);
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [customer, ago(3 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === customer);
    assert(mail.length === 1, `expected the reminder, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    assert(/restock/i.test(mail[0].subject), `unexpected subject ${mail[0].subject}`);
    // A fresh order for a DIFFERENT customer whose earlier order is due: the
    // reminder must not go, because they reordered.
    const reorderer = `reorder.${stamp}@example.test`;
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [reorderer, ago(60 * DAY)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'R', 'paid', 69, 69, 0, 0, 'USD', $3, 'product'), ($4, $2, 'R', 'paid', 69, 69, 0, 0, 'USD', $5, 'product')`,
      [`order-qa-${stamp}-r1`, reorderer, ago(33 * DAY), `order-qa-${stamp}-r2`, ago(2 * DAY)]);
    const second = await sweepAndMail((m) => m.to === reorderer);
    assert(second.mail.length === 0, `a customer who reordered got: ${second.mail.map((m) => m.subject).join(", ")}`);
    await renderMail(context, mail[0], "replenishment");
    return `"${mail[0].subject}"; reorderer correctly skipped`;
  });

  await step("win-back 1 fires at the operator's delay with a tracked link, once per lapse", async () => {
    await q(`update orders set created_at = $2 where order_id = $1`, [`order-qa-${stamp}-c1`, ago(50 * DAY)]);
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [customer, ago(3 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === customer);
    assert(mail.length === 1, `expected win-back 1, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    const again = await sweepAndMail((m) => m.to === customer);
    assert(again.mail.length === 0, "win-back 1 repeated");
    await renderMail(context, mail[0], "winback-1");
    return `"${mail[0].subject}"`;
  });

  // ---------------------------------------------------------------------------
  section("4. Unsubscribe and bounce suppression");
  await step("the footer unsubscribe link stops marketing and records which message prompted it", async () => {
    const unsub = linksIn(lastNote).find((l) => /\/api\/unsubscribe\?/.test(l));
    assert(unsub, "no unsubscribe link in the last note");
    const r = await fetch(unsub);
    assert(r.status === 200, `unsubscribe answered ${r.status}`);
    const row = await q(`select reason, source from email_suppressions where email = $1`, [guest]);
    assert(row.rows[0]?.reason === "unsubscribed", "no suppression row");
    assert(row.rows[0]?.source === "cart_recovery_t72h", `source recorded as ${row.rows[0]?.source}`);
    // A brand-new cart, well outside every cooldown, for the unsubscribed address.
    await q(`update abandoned_cart_emails set sent_at = $2 where abandoned_cart_id in (select id from abandoned_carts where email = $1)`, [guest, ago(20 * DAY)]);
    await q(`insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
      values ($1, $2, 'Sam', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":1,"unitPrice":47.99}]'::jsonb, 4799, $3, $3, 'active')`, [`sess-${stamp}-afterunsub`, guest, ago(2 * HOUR)]);
    const { mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 0, `an unsubscribed shopper was mailed: ${mail.map((m) => m.subject).join(", ")}`);
    return `suppressed (source=${row.rows[0].source}); a new cart produced no mail`;
  });

  await step("Gmail's one-click POST unsubscribe works too", async () => {
    const unsub = linksIn(welcomeIntro).find((l) => /\/api\/unsubscribe\?/.test(l));
    const r = await fetch(unsub, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert(r.status === 200, `one-click POST answered ${r.status}`);
    const row = await q(`select source from email_suppressions where email = $1`, [subscriber]);
    assert(row.rows[0]?.source === "automation:welcome_intro", `source recorded as ${row.rows[0]?.source}`);
    const pref = await q(`select marketing_emails from customer_preferences where user_id = $1`, [subscriberUserId]);
    assert(pref.rows[0]?.marketing_emails === false, "the account preference was not mirrored off");
    return "suppressed and mirrored onto the account preference";
  });

  await step("a permanent bounce from the provider suppresses the address before the next send", async () => {
    const bouncer = `bounce.${stamp}@example.test`;
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [bouncer, ago(2 * DAY)]);
    const r = await fetch(`${BASE}/api/webhooks/email?secret=${encodeURIComponent(WEBHOOK_SECRET)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email.bounced", data: { email_id: `msg-${stamp}`, to: [bouncer], bounce: { type: "Permanent" } } }),
    });
    assert(r.status === 200, `webhook answered ${r.status}`);
    const row = await q(`select reason from email_suppressions where email = $1`, [bouncer]);
    assert(row.rows[0]?.reason === "bounced", "bounce did not suppress");
    const { mail } = await sweepAndMail((m) => m.to === bouncer);
    assert(mail.length === 0, "a bounced address was mailed");
    const events = await q(`select kind from email_delivery_events where recipient_email = $1`, [bouncer]);
    assert(events.rows[0]?.kind === "hard_bounce", "the event was not logged");
    return "suppressed as bounced; welcome intro withheld";
  });

  await step("the webhook rejects a wrong secret", async () => {
    const r = await fetch(`${BASE}/api/webhooks/email?secret=wrong`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert(r.status === 401, `answered ${r.status}`);
  });

  // ---------------------------------------------------------------------------
  section("5. Campaigns from the admin");
  let campaignId = null;
  await step("an operator can create, preview and test a campaign", async () => {
    await adminLogin(page);
    const created = await postAsPage(page, "/api/admin/email/campaigns", {
      name: `QA restock ${stamp}`, subject: "Two research favourites are back in stock", previewText: "BPC-157 and GHK-Cu, with fresh batch COAs.",
      headline: "Back in stock", body: "Two of the most-requested compounds are back, with new batch certificates in the COA library.\n\nBoth ship tracked, in plain packaging.",
      promoCode: "", ctaLabel: "SEE WHAT IS BACK", ctaPath: "/products", segment: "all", segmentParam: "",
    });
    assert(created.status === 200 && created.body?.success, `create answered ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
    campaignId = created.body.campaignId ?? created.body.id;
    assert(campaignId, "no campaign id returned");
    const preview = await postAsPage(page, "/api/admin/email/campaigns/preview", { subject: "Two research favourites are back in stock", headline: "Back in stock", body: "Hello", ctaLabel: "SEE WHAT IS BACK", ctaPath: "/products" });
    assert(preview.status === 200 && /Back in stock/.test(preview.body?.html ?? ""), "preview did not render");
    const offset = mailOffset();
    const test = await postAsPage(page, `/api/admin/email/campaigns/${campaignId}/send`, { mode: "test", testEmail: `owner.${stamp}@example.test` });
    assert(test.status === 200 && test.body?.success, `test send answered ${test.status}: ${JSON.stringify(test.body).slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const testMail = mailSince(offset).find((m) => /\[TEST\]/.test(m.subject));
    assert(testMail, "no [TEST] email captured");
    const logged = await q(`select count(*)::int as n from email_send_log where campaign_type = 'campaign' and reference_id = $1`, [campaignId]);
    assert(logged.rows[0].n === 0, "a test send was logged as a campaign send");
    return `campaign ${campaignId}; preview ok; test delivered and not counted`;
  });

  await step("the audience estimate counts consented, unsuppressed addresses only", async () => {
    const r = await page.evaluate(async () => {
      const res = await fetch("/api/admin/email/campaigns?segment=all", { credentials: "same-origin" });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    assert(r.status === 200, `estimate answered ${r.status}`);
    const expected = await q(`select count(*)::int as n from marketing_subscribers s where s.unsubscribed_at is null and s.email not in (select email from email_suppressions) and s.email not like '%@resend.dev'`);
    assert(r.body.count >= 1, "estimate is zero");
    return `${r.body.count} (subscriber table alone: ${expected.rows[0].n})`;
  });

  await step("send now queues every recipient once, and a second send is refused", async () => {
    const offset = mailOffset();
    const send = await postAsPage(page, `/api/admin/email/campaigns/${campaignId}/send`, { mode: "now" });
    assert(send.status === 200 && send.body?.success, `send answered ${send.status}: ${JSON.stringify(send.body).slice(0, 200)}`);
    const again = await postAsPage(page, `/api/admin/email/campaigns/${campaignId}/send`, { mode: "now" });
    assert(again.status !== 200 || again.body?.success === false, `a second send was accepted: ${JSON.stringify(again.body).slice(0, 200)}`);
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const delivered = mailSince(offset).filter((m) => /back in stock/i.test(m.subject) && !/\[TEST\]/.test(m.subject));
    const recipients = await q(`select email, count(*)::int as n from email_campaign_recipients where campaign_id = $1 group by email having count(*) > 1`, [campaignId]);
    assert(recipients.rows.length === 0, "a recipient was queued twice");
    const toSuppressed = delivered.filter((m) => [guest, subscriber].includes(m.to));
    assert(toSuppressed.length === 0, "the campaign reached an unsubscribed address");
    const logged = await q(`select count(*)::int as n, count(provider_message_id)::int as with_id from email_send_log where campaign_type = 'campaign' and reference_id = $1 and status = 'sent'`, [campaignId]);
    const withCta = delivered.filter((m) => linksIn(m).some((l) => /\/api\/email\/click\?/.test(l)));
    assert(withCta.length === delivered.length, "a campaign email went out without a tracked CTA");
    if (delivered[0]) await renderMail(context, delivered[0], "campaign");
    return `${delivered.length} delivered, ${logged.rows[0].n} logged, second send refused (${again.status})`;
  });

  await step("a campaign click is attributed to an order placed inside the window", async () => {
    const rows = await q(`select email from email_campaign_recipients where campaign_id = $1 and status = 'sent' limit 1`, [campaignId]);
    assert(rows.rows.length === 1, "no sent recipient to click as");
    const mail = mailSince(0).filter((m) => m.to === rows.rows[0].email && /back in stock/i.test(m.subject)).pop();
    const cta = linksIn(mail).find((l) => /\/api\/email\/click\?/.test(l));
    const r = await fetch(cta, { redirect: "manual" });
    const cookie = (r.headers.get("set-cookie") ?? "").match(/vl_campaign=([^;]+)/)?.[1];
    assert(cookie, "no attribution cookie set by the click");
    const clicks = await q(`select count(*)::int as n from email_campaign_clicks where campaign_id = $1`, [campaignId]);
    assert(clicks.rows[0].n === 1, "the click was not recorded");
    const clickedRow = await q(`select clicked_at from email_campaign_recipients where campaign_id = $1 and email = $2`, [campaignId, rows.rows[0].email]);
    assert(clickedRow.rows[0]?.clicked_at, "clicked_at not stamped");
    const dashboard = await page.evaluate(async () => {
      const res = await fetch("/admin/email", { credentials: "same-origin" });
      return { status: res.status, text: await res.text() };
    });
    assert(dashboard.status === 200, `admin email page answered ${dashboard.status}`);
    return `click recorded, cookie vl_campaign set (${decodeURIComponent(cookie).slice(0, 24)}…)`;
  });

  await step("stopping a scheduled campaign cancels it", async () => {
    const created = await postAsPage(page, "/api/admin/email/campaigns", {
      name: `QA scheduled ${stamp}`, subject: "A note for later", previewText: "", headline: "Later", body: "This one is scheduled and then cancelled before it goes out, which is the whole test.",
      promoCode: "", ctaLabel: "SEE THE CATALOG", ctaPath: "/products", segment: "all", segmentParam: "",
    });
    const id = created.body?.campaignId ?? created.body?.id;
    const scheduled = await postAsPage(page, `/api/admin/email/campaigns/${id}/send`, { mode: "schedule", scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    assert(scheduled.status === 200 && scheduled.body?.success, `schedule answered ${scheduled.status}: ${JSON.stringify(scheduled.body).slice(0, 200)}`);
    const stopped = await postAsPage(page, `/api/admin/email/campaigns/${id}/stop`, undefined);
    assert(stopped.status === 200 && stopped.body?.success, `stop answered ${stopped.status}`);
    const offset = mailOffset();
    await sweep();
    const row = await q(`select status from email_campaigns where id = $1`, [id]);
    assert(row.rows[0].status !== "sending" && row.rows[0].status !== "sent", `campaign is ${row.rows[0].status}`);
    assert(mailSince(offset).filter((m) => /A note for later/.test(m.subject)).length === 0, "the cancelled campaign went out");
    return `status ${row.rows[0].status}, nothing sent`;
  });

  // ---------------------------------------------------------------------------
  section("6. Admin surfaces render");
  await step("Admin → Email lists every automation with its label and the campaign with delivery columns", async () => {
    await page.goto(`${BASE}/admin/email`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    for (const label of ["First-order follow-up", "Reorder reminder", "Welcome · introduction", "Welcome · first-order offer", "Win-back 1", "Win-back 2"]) {
      assert(text.includes(label), `missing automation "${label}"`);
    }
    assert(/delivered/i.test(text) && /bounce · spam · unsub/i.test(text), "delivery columns missing from the campaign history");
    await page.screenshot({ path: `${SHOTS}/admin-email.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/admin-email-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await step("Admin → Cart recovery shows the per-stage funnel", async () => {
    await page.goto(`${BASE}/admin/cart-recovery`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const funnel = await page.$('[data-testid="cart-recovery-stage-funnel"]');
    assert(funnel, "no stage funnel rendered");
    const text = await funnel.innerText();
    assert(/1 h reminder/.test(text) && /72 h last note/.test(text), `funnel text: ${text}`);
    await page.screenshot({ path: `${SHOTS}/admin-cart-recovery.png`, fullPage: true });
    return text.replace(/\n/g, " | ");
  });

  await browser.close();
  await pool.end();

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  writeFileSync(`${CAPTURE_DIR}/lifecycle-results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${passed} passed, ${failed.length} failed. Screenshots in ${SHOTS}.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
