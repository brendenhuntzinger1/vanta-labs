#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE RETENTION SYSTEM, END TO END, ON THE PRODUCTION CONFIGURATION.
//
// Drives the customer journeys the retention engine exists for, against the
// local harness, through the same surfaces production uses: the scheduled
// sweep (/api/cron/sweep), the emails actually rendered and captured, the
// tracked click that arms the gift, the checkout API, the signed payment
// webhook, and the rows each of those writes.
//
//   A  subscribe → day 1 intro → day 3 15% gift → buy with it → welcome stops,
//      gift consumed, order credited to the automation
//   B  buy → day 14 follow-up → day 30 free shipping → buy WITHOUT the link →
//      day 40 / day 50 never send, the unused gift is closed, a new cycle
//      starts from the new order
//   C  buy → ignore day 30 → day 40 gift used → day 30 token dead, day 50
//      never sends, order credited by the redeemed gift
//   D  buy → ignore 30 and 40 → day 50 GHK-Cu used → every earlier token dead
//   E  a gift against a bigger coupon, a smaller coupon, an order that already
//      ships free, and a basket under the minimum after a coupon: the right
//      discount wins and no gift is falsely shown, reserved or burned
//   F  a cart abandoned while holding a gift: one recovery reminder, then the
//      purchase closes the cart, and the order is credited to the gift's
//      automation rather than to cart recovery
//   G  a campaign and an automation due in the same tick: one marketing email
//      inside the window, the other deferred and delivered the next day
//   H  the reorder link: a guest lands on the catalogue, a signed-in customer
//      on their orders, an expired session on the catalogue; the gift stays
//      armed; mobile lands the same way
//
// Time is advanced by backdating rows, because both sweeps read the clock and
// nothing else. Development-only; refuses to run against anything but the
// harness. Emails are read from EMAIL_CAPTURE_DIR (smtp-sink.mjs).
//
//   node scripts/qa-retention-system.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CAPTURE_DIR = process.env.EMAIL_CAPTURE_DIR ?? "/tmp/vanta-qa";
const CAPTURE = `${CAPTURE_DIR}/captured-emails.jsonl`;
const SHOTS = `${CAPTURE_DIR}/retention-shots`;
const CRON_SECRET = process.env.CRON_SECRET ?? "harness-cron-secret";
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    return detail;
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 320);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
    return null;
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
const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/=\r?\n/g, "").replace(/=3D/g, "=");
function linksIn(mail) {
  const found = decode(mail.html).match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(found)];
}
const ctaOf = (mail) => linksIn(mail).find((l) => /\/api\/email\/automation-click\?/.test(l));
const to = (mail) => String(mail.to ?? "").toLowerCase();

// --- the clock ----------------------------------------------------------------
async function sweep() {
  const r = await fetch(`${BASE}/api/cron/sweep`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  const body = await r.json();
  assert(r.status === 200 && body.success, `sweep answered ${r.status}`);
  return body;
}
async function sweepAndMail(filter) {
  const offset = mailOffset();
  const body = await sweep();
  await sleep(900);
  return { body, mail: mailSince(offset).filter(filter ?? (() => true)) };
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
/** Nothing marketing reached this address in the last two days, as far as the guard can see. */
const quietReset = (email) => q(`update email_send_log set sent_at = $2 where recipient_email = $1 and sent_at > $2`, [email, ago(2 * DAY)]);

/**
 * Move an order back in time WITHOUT re-triggering the win-backs that already
 * fired for it: their send-once keys carry the order's timestamp, so the keys
 * are rewritten to the new one everywhere they are stored.
 */
async function setOrderAge(orderId, email, days) {
  const { rows } = await q(`select created_at from orders where order_id = $1`, [orderId]);
  const oldKey = `${email}:${new Date(rows[0].created_at).getTime()}`;
  const next = new Date(Date.now() - days * DAY);
  const newKey = `${email}:${next.getTime()}`;
  await q(`update orders set created_at = $2, paid_at = $2 where order_id = $1`, [orderId, next.toISOString()]);
  await q(`update email_send_log set reference_id = $2 where reference_id = $1`, [oldKey, newKey]);
  await q(`update customer_offers set reference_id = $2 where reference_id = $1`, [oldKey, newKey]);
  await q(`update email_automation_clicks set reference_id = $2 where reference_id = $1`, [oldKey, newKey]);
}

// --- customers, orders, money -------------------------------------------------
let ipCounter = 10;
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

async function seedSubscriber(email, daysAgo) {
  await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'harness', $2) on conflict (email) do update set opted_in_at = excluded.opted_in_at, unsubscribed_at = null`, [email, ago(daysAgo * DAY)]);
}
async function seedPaidOrder(email, daysAgo, suffix = "1") {
  const orderId = `order-qa-${stamp}-${email.split("@")[0]}-${suffix}`;
  await q(
    `insert into orders (order_id, customer_email, customer_name, payment_status, fulfillment_status, subtotal, shipping_amount, discount_amount, amount_paid, currency, created_at, paid_at, order_type)
     values ($1, $2, 'QA Customer', 'paid', 'delivered', 69, 0, 0, 69, 'USD', $3, $3, 'product')`,
    [orderId, email, ago(daysAgo * DAY)],
  );
  return orderId;
}

/** A gift token minted exactly as the sweep mints one, when a journey needs one without a send. */
async function mintToken(email, offerKey, automationKey) {
  const shapes = {
    winback_60_percent_15: { kind: "percent", slug: null, percent: 15, min: 3500 },
    winback_60_free_shipping: { kind: "free_shipping", slug: null, percent: null, min: 3500 },
    winback_60_bac_water_10: { kind: "free_product_percent", slug: "bacteriostatic-water", percent: 10, min: 3500 },
    winback_60_free_ghkcu: { kind: "free_product", slug: "ghk-cu", percent: null, min: 6000 },
  };
  const shape = shapes[offerKey];
  const token = randomBytes(32).toString("base64url");
  await q(
    `insert into customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at, automation_key, reference_id)
     values ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days', $8, $3)`,
    [offerKey, createHash("sha256").update(token).digest("hex"), email, shape.kind, shape.slug, shape.percent, shape.min, automationKey],
  );
  return token;
}

/** Follow the emailed button the way a mail client does: one hop, cookies read off the response. */
async function clickCta(link, extraCookie = "") {
  const r = await fetch(link, { redirect: "manual", headers: extraCookie ? { Cookie: extraCookie } : {} });
  const setCookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") ?? ""];
  const offerToken = setCookies.map((c) => c.match(/^vl_offer=([^;]+)/)?.[1]).find(Boolean) ?? null;
  const automationCookie = setCookies.map((c) => c.match(/^vl_automation=([^;]+)/)?.[1]).find(Boolean) ?? null;
  return { status: r.status, location: r.headers.get("location") ?? "", offerToken, automationCookie };
}

async function quote({ email, items, couponCode, offerToken }) {
  const r = await fetch(`${BASE}/api/checkout/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(offerToken ? { Cookie: `vl_offer=${offerToken}` } : {}), "x-real-ip": nextIp() },
    body: JSON.stringify({ items, email, country: "United States", state: "CA", couponCode }),
  });
  return r.json();
}

async function checkoutApi({ email, items, couponCode, offerToken, automationCookie }) {
  await q("delete from rate_limit_hits").catch(() => {});
  const cookies = [offerToken ? `vl_offer=${offerToken}` : null, automationCookie ? `vl_automation=${automationCookie}` : null].filter(Boolean).join("; ");
  const r = await fetch(`${BASE}/api/checkout/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookies ? { Cookie: cookies } : {}), "x-real-ip": nextIp() },
    body: JSON.stringify({
      items,
      customer: { email, fullName: "QA Customer", address: "1 Harness Way", city: "Testville", state: "CA", postalCode: "90000", country: "US", phone: "5555555555" },
      currency: "USD",
      couponCode,
      complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
    }),
  });
  const body = await r.json().catch(() => null);
  assert(body?.orderId, `checkout failed (${r.status}): ${JSON.stringify(body).slice(0, 240)}`);
  return body.orderId;
}

/** Mark an order paid through the REAL webhook handler, signed the way the processor signs. */
async function payOrder(orderId, type = "payment.succeeded") {
  const { rows } = await q(
    `select order_id, payment_id, customer_email, customer_name, shipping_address, city, postal_code, currency, subtotal, shipping_amount, discount_amount, amount_paid, referral_code, ambassador_id, coupon_code, customer_user_id, points_redeemed from orders where order_id = $1`,
    [orderId],
  );
  const o = rows[0];
  const items = (await q(`select product_id, product_name, unit_price, quantity, line_total from order_items where order_id = $1`, [orderId])).rows;
  const n = (v) => (v == null ? 0 : Number(v));
  const s = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const body = JSON.stringify({
    orderId: o.order_id, type, paymentId: s(o.payment_id) ?? `harness_pay_${o.order_id}`, status: type,
    customer: { email: s(o.customer_email), fullName: s(o.customer_name), address: s(o.shipping_address), city: s(o.city), postalCode: s(o.postal_code) },
    amount: n(o.amount_paid), subtotal: n(o.subtotal), shippingAmount: n(o.shipping_amount), discountAmount: n(o.discount_amount),
    currency: s(o.currency) ?? "USD", referralCode: s(o.referral_code), ambassadorId: s(o.ambassador_id), couponCode: s(o.coupon_code),
    customerUserId: s(o.customer_user_id), pointsRedeemed: n(o.points_redeemed),
    items: items.map((i) => ({ productId: s(i.product_id), productName: s(i.product_name), unitPrice: n(i.unit_price), quantity: n(i.quantity), lineTotal: n(i.line_total) })),
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
  const r = await fetch(`${BASE}/api/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-signature": signature, "x-event-id": `harness_evt_${randomUUID()}` },
    body,
  });
  assert(r.status === 200, `webhook answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  await sleep(600);
}

const offersOf = async (email) => (await q(
  `select offer_key, automation_key, reserved_order_id, redeemed_order_id, redeemed_at, revoked_at, revoke_reason, closed_by_order_id from customer_offers where email = $1 order by issued_at`,
  [email],
)).rows;
const orderOf = async (orderId) => (await q(
  `select order_id, payment_status, subtotal, shipping_amount, discount_amount, amount_paid, coupon_code, attributed_automation_key, marketing_source_kind, marketing_source_ref, marketing_source_basis from orders where order_id = $1`,
  [orderId],
)).rows[0];
const linesOf = async (orderId) => (await q(`select product_id as slug, unit_price, quantity from order_items where order_id = $1 order by unit_price desc`, [orderId])).rows;
const sentTypes = async (email) => (await q(`select campaign_type, status from email_send_log where recipient_email = $1 and campaign_type not like 'auth:%' order by sent_at`, [email])).rows;

// --- admin ---------------------------------------------------------------------
// The middleware's CSRF layer wants a browser-shaped request: an Origin that
// matches `${x-forwarded-proto}://${host}` (it assumes https when the proxy
// header is absent, and the harness is plain http).
const SAME_ORIGIN = { Origin: BASE, "x-forwarded-proto": new URL(BASE).protocol.replace(":", "") };
let adminCookie = "";
async function adminLogin() {
  const r = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", ...SAME_ORIGIN, "x-real-ip": nextIp() }, body: JSON.stringify(ADMIN) });
  const body = await r.json().catch(() => null);
  assert(r.status === 200 && body?.success !== false, `admin login answered ${r.status}: ${JSON.stringify(body).slice(0, 160)}`);
  const setCookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") ?? ""];
  adminCookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  assert(adminCookie, "admin login set no cookie");
}
async function adminFetch(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", ...SAME_ORIGIN, Cookie: adminCookie, "x-real-ip": nextIp(), ...(init.headers ?? {}) } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
}

const BPC = { id: "bpc-157-10mg", quantity: 1 };   // $69
const GHK = { id: "ghk-cu", quantity: 1 };         // $47.99

// ============================================================================
async function main() {
  mkdirSync(SHOTS, { recursive: true });

  // The production configuration (Admin → Email as of 2026-09-04), on the
  // harness's copy of the automations table: same delays, same gifts, same
  // reorder destination. Nothing here touches production.
  await q(`update email_automations set enabled = true`);
  await q(`update email_automations set delay_days = case key when 'welcome_intro' then 1 when 'welcome_no_purchase' then 3 when 'post_purchase' then 14 when 'replenishment' then 30 when 'winback_30' then 40 when 'winback_60' then 50 end`);
  await q(`update email_automations set offer_key = case key when 'welcome_no_purchase' then 'winback_60_percent_15' when 'replenishment' then 'winback_60_free_shipping' when 'winback_30' then 'winback_60_bac_water_10' when 'winback_60' then 'winback_60_free_ghkcu' else null end`);
  await q(`update email_automations set cta_path = '/account/orders', cta_label = 'REORDER FROM MY ACCOUNT' where key = 'replenishment'`);
  await q(`update email_automations set cta_path = '/products' where key <> 'replenishment' and (cta_path is null or cta_path = '')`);
  await q(`update products set inventory_quantity = 900, stock_status = 'In Stock' where slug in ('bpc-157-10mg','ghk-cu','bacteriostatic-water')`);
  await q(`update product_doses set inventory_quantity = 900, stock_status = 'In Stock'`).catch(() => {});
  await q(`delete from inventory_reservations`).catch(() => {});
  await q(`delete from coupons where code like 'QA%-${stamp.toUpperCase()}'`).catch(() => {});
  await q(`insert into coupons (code, discount_type, discount_value, active) values ($1, 'percent', 50, true), ($2, 'percent', 5, true)`, [`QA50-${stamp.toUpperCase()}`, `QA5-${stamp.toUpperCase()}`]);
  const BIG = `QA50-${stamp.toUpperCase()}`;
  const SMALL = `QA5-${stamp.toUpperCase()}`;

  // A first sweep clears anything a previous run left due, so each journey's
  // sweep can only mail the customers this run seeds.
  await sweep();

  // ==========================================================================
  section("A. Subscribe → welcome → 15% gift → first purchase");
  const A = `a.${stamp}@example.test`;
  let aToken = null;
  let aOrder = null;

  await step("day 1: the welcome introduction goes out, with no gift on it", async () => {
    await seedSubscriber(A, 2);
    const { mail } = await sweepAndMail((m) => to(m) === A);
    assert(mail.length === 1, `expected one email, got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    assert(!/[?&]o=/.test(ctaOf(mail[0]) ?? ""), "the introduction carried a gift token");
    return `"${mail[0].subject}"`;
  });

  await step("day 3: the first-order offer goes out with a private 15% token, minted by that automation", async () => {
    await seedSubscriber(A, 4);
    await quietReset(A);
    const { mail } = await sweepAndMail((m) => to(m) === A);
    assert(mail.length === 1, `expected the offer, got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    const cta = ctaOf(mail[0]);
    assert(cta && /[?&]o=/.test(cta), "the offer carries no gift token");
    const offers = await offersOf(A);
    assert(offers.length === 1 && offers[0].offer_key === "winback_60_percent_15", `offers: ${JSON.stringify(offers)}`);
    assert(offers[0].automation_key === "welcome_no_purchase", `provenance missing: ${offers[0].automation_key}`);
    const click = await clickCta(cta);
    assert(click.status === 302 && click.location.startsWith(`${BASE}/products`), `click → ${click.status} ${click.location}`);
    assert(click.offerToken, "no vl_offer cookie set");
    aToken = click.offerToken;
    return `"${mail[0].subject}" → /products, gift armed`;
  });

  await step("the cart preview shows 15% off as a gift, not as a coupon", async () => {
    const qt = await quote({ email: A, items: [BPC], offerToken: aToken });
    assert(qt.ok, `quote refused: ${JSON.stringify(qt)}`);
    assert(qt.quote.discountAmount === 10.35, `discount ${qt.quote.discountAmount}`);
    assert(qt.quote.offer?.description === "15% off" && qt.quote.offer?.percentApplied === true, `offer ${JSON.stringify(qt.quote.offer)}`);
    assert(qt.quote.discountLabel === "15% gift", `label ${qt.quote.discountLabel}`);
    return `$69 → −$10.35, "${qt.quote.discountLabel}"`;
  });

  await step("checkout reserves the gift, payment consumes it, and the order is credited to the welcome automation", async () => {
    aOrder = await checkoutApi({ email: A, items: [BPC], offerToken: aToken });
    let offers = await offersOf(A);
    assert(offers[0].reserved_order_id === aOrder, "the gift was not reserved for the order");
    await payOrder(aOrder);
    offers = await offersOf(A);
    assert(offers[0].redeemed_order_id === aOrder && offers[0].redeemed_at, "the gift was not redeemed on payment");
    const order = await orderOf(aOrder);
    assert(order.payment_status === "paid" && Number(order.discount_amount) === 10.35, `order ${JSON.stringify(order)}`);
    assert(order.marketing_source_kind === "automation" && order.marketing_source_ref === "welcome_no_purchase" && order.marketing_source_basis === "offer_redeemed", `source ${order.marketing_source_kind}/${order.marketing_source_ref}/${order.marketing_source_basis}`);
    return `order ${aOrder.slice(-8)} paid; source automation/welcome_no_purchase/offer_redeemed`;
  });

  await step("a buyer never gets welcome mail again, and the day-30 ladder starts from the order", async () => {
    await quietReset(A);
    const { mail } = await sweepAndMail((m) => to(m) === A);
    assert(mail.length === 0, `got ${mail.map((m) => m.subject).join(", ")}`);
    const types = (await sentTypes(A)).map((r) => r.campaign_type);
    assert(types.filter((t) => t === "automation:welcome_no_purchase").length === 1, `send log: ${types.join(", ")}`);
    return "nothing further";
  });

  // ==========================================================================
  section("B. Buy → day 14 → day 30 free shipping → buy without the link → cycle closes and restarts");
  const B = `b.${stamp}@example.test`;
  let b1 = null; let b2 = null; let bCta = null;

  await step("day 14: the first-order follow-up, with no gift", async () => {
    await seedSubscriber(B, 100);
    b1 = await seedPaidOrder(B, 14, "b1");
    const { mail } = await sweepAndMail((m) => to(m) === B);
    assert(mail.length === 1 && !/[?&]o=/.test(ctaOf(mail[0]) ?? ""), `got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    return `"${mail[0].subject}"`;
  });

  await step("day 30: the reorder reminder carries a free-shipping gift minted by the reorder automation", async () => {
    await setOrderAge(b1, B, 31);
    await quietReset(B);
    const { mail } = await sweepAndMail((m) => to(m) === B);
    assert(mail.length === 1, `got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    bCta = ctaOf(mail[0]);
    assert(bCta && /[?&]o=/.test(bCta), "no gift token on the reorder reminder");
    const offers = await offersOf(B);
    assert(offers.length === 1 && offers[0].offer_key === "winback_60_free_shipping" && offers[0].automation_key === "replenishment", JSON.stringify(offers));
    return `"${mail[0].subject}"`;
  });

  await step("a GUEST clicking the reorder button lands on the catalogue, not the login page, with the gift armed", async () => {
    const click = await clickCta(bCta);
    assert(click.status === 302, `click → ${click.status}`);
    assert(click.location === `${BASE}/products`, `landed on ${click.location}`);
    assert(click.offerToken, "the gift cookie was not set");
    const status = await fetch(`${BASE}/api/offer/status`, { headers: { Cookie: `vl_offer=${click.offerToken}` } }).then((r) => r.json());
    assert(status?.offer?.rewardKind === "free_shipping", `offer status ${JSON.stringify(status)}`);
    return `→ /products; offer status: ${status.offer.rewardKind}`;
  });

  await step("day 32: the customer buys WITHOUT the link — the unused gift is closed by that order", async () => {
    b2 = await checkoutApi({ email: B, items: [BPC] });
    await payOrder(b2);
    const offers = await offersOf(B);
    assert(offers[0].redeemed_at === null, "a gift that was never used shows as redeemed");
    assert(offers[0].revoked_at && offers[0].revoke_reason === "cycle_closed" && offers[0].closed_by_order_id === b2, `gift not closed: ${JSON.stringify(offers[0])}`);
    const order = await orderOf(b2);
    assert(Number(order.shipping_amount) === 15, `shipping ${order.shipping_amount} (the gift must not have applied)`);
    assert(order.marketing_source_kind === "organic", `source ${order.marketing_source_kind}`);
    return `order ${b2.slice(-8)} paid at full shipping; day-30 gift revoked (cycle_closed)`;
  });

  await step("the dead gift cannot be spent by the old link's cookie", async () => {
    const click = await clickCta(bCta);
    const qt = await quote({ email: B, items: [BPC], offerToken: click.offerToken });
    assert(qt.ok === false || qt.quote?.offer === null, `a closed gift still priced: ${JSON.stringify(qt.quote?.offer)}`);
    return "no gift priced";
  });

  await step("day 40 and day 50 never send for the old cycle", async () => {
    await setOrderAge(b1, B, 41);
    await quietReset(B);
    const at40 = await sweepAndMail((m) => to(m) === B);
    assert(at40.mail.length === 0, `day 40 sent: ${at40.mail.map((m) => m.subject).join(", ")}`);
    await setOrderAge(b1, B, 51);
    await quietReset(B);
    const at50 = await sweepAndMail((m) => to(m) === B);
    assert(at50.mail.length === 0, `day 50 sent: ${at50.mail.map((m) => m.subject).join(", ")}`);
    return "nothing";
  });

  await step("a fresh cycle starts from the new order: day 30 fires again with a NEW gift", async () => {
    await setOrderAge(b2, B, 31);
    await quietReset(B);
    const { mail } = await sweepAndMail((m) => to(m) === B);
    assert(mail.length === 1 && /[?&]o=/.test(ctaOf(mail[0]) ?? ""), `got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    const offers = await offersOf(B);
    assert(offers.length === 2 && offers[1].revoked_at === null && offers[1].redeemed_at === null, JSON.stringify(offers));
    return `"${mail[0].subject}" with a new token; the old one stays revoked`;
  });

  // ==========================================================================
  section("C. Buy → ignore day 30 → use the day-40 gift → day-30 token dead, day 50 never sends");
  const C = `c.${stamp}@example.test`;
  let c1 = null; let cTokenA = null; let cTokenB = null; let cAutomation = null; let c2 = null;

  await step("day 30 and day 40 each mint their own gift", async () => {
    await seedSubscriber(C, 100);
    c1 = await seedPaidOrder(C, 31, "c1");
    const d30 = await sweepAndMail((m) => to(m) === C);
    assert(d30.mail.length === 1, `day 30: ${d30.mail.map((m) => m.subject).join(", ") || "none"}`);
    cTokenA = (await clickCta(ctaOf(d30.mail[0]))).offerToken;
    await setOrderAge(c1, C, 41);
    await quietReset(C);
    const d40 = await sweepAndMail((m) => to(m) === C);
    assert(d40.mail.length === 1, `day 40: ${d40.mail.map((m) => m.subject).join(", ") || "none"}`);
    const click = await clickCta(ctaOf(d40.mail[0]));
    cTokenB = click.offerToken; cAutomation = click.automationCookie;
    const offers = await offersOf(C);
    assert(offers.map((o) => o.offer_key).join(",") === "winback_60_free_shipping,winback_60_bac_water_10", JSON.stringify(offers.map((o) => o.offer_key)));
    assert(offers.every((o) => !o.revoked_at && !o.redeemed_at), "a gift died early");
    return `two live gifts: ${offers.map((o) => o.offer_key).join(", ")}`;
  });

  await step("the day-40 gift prices 10% off AND adds the free BAC water", async () => {
    const qt = await quote({ email: C, items: [BPC], offerToken: cTokenB });
    assert(qt.ok && qt.quote.discountAmount === 6.9, `discount ${qt.quote?.discountAmount}`);
    assert(qt.quote.offer?.percentApplied === true && qt.quote.offer?.productApplied === true && /10% off/.test(qt.quote.offer?.description ?? ""), `offer ${JSON.stringify(qt.quote?.offer)}`);
    assert(qt.quote.giftLines?.length === 1 && /^Bacteriostatic Water/.test(qt.quote.giftLines[0].name), `gift lines ${JSON.stringify(qt.quote?.giftLines)}`);
    return `−$6.90 + free ${qt.quote.giftLines[0].name}`;
  });

  await step("buying with it redeems the day-40 gift, kills the day-30 gift, and credits win-back 1 by the redeemed gift", async () => {
    c2 = await checkoutApi({ email: C, items: [BPC], offerToken: cTokenB, automationCookie: cAutomation });
    const lines = await linesOf(c2);
    assert(lines.some((l) => l.slug.startsWith("bacteriostatic-water") && Number(l.unit_price) === 0), `lines ${JSON.stringify(lines)}`);
    await payOrder(c2);
    const offers = await offersOf(C);
    const shipping = offers.find((o) => o.offer_key === "winback_60_free_shipping");
    const bac = offers.find((o) => o.offer_key === "winback_60_bac_water_10");
    assert(bac.redeemed_order_id === c2, "the day-40 gift was not redeemed");
    assert(shipping.revoke_reason === "cycle_closed" && shipping.closed_by_order_id === c2, `day-30 gift: ${JSON.stringify(shipping)}`);
    const order = await orderOf(c2);
    assert(order.marketing_source_kind === "automation" && order.marketing_source_ref === "winback_30" && order.marketing_source_basis === "offer_redeemed", `source ${JSON.stringify(order)}`);
    assert(order.attributed_automation_key === "winback_30", "the click was not recorded as an assist");
    return `order ${c2.slice(-8)}: discount $${order.discount_amount}, source automation/winback_30/offer_redeemed`;
  });

  await step("the day-30 token is dead, and day 50 never sends for the old cycle", async () => {
    const qt = await quote({ email: C, items: [BPC], offerToken: cTokenA });
    assert(qt.ok === false || qt.quote?.offer === null, `the closed day-30 gift still priced: ${JSON.stringify(qt.quote?.offer)}`);
    await setOrderAge(c1, C, 51);
    await quietReset(C);
    const { mail } = await sweepAndMail((m) => to(m) === C);
    assert(mail.length === 0, `day 50 sent: ${mail.map((m) => m.subject).join(", ")}`);
    return "nothing";
  });

  // ==========================================================================
  section("D. Buy → ignore day 30 and 40 → use the day-50 GHK-Cu → the whole cycle closes");
  const D = `d.${stamp}@example.test`;
  let d1 = null; let dToken = null; let dAutomation = null; let d2 = null;

  await step("day 30, 40 and 50 each mint a gift; three are live at once", async () => {
    await seedSubscriber(D, 100);
    d1 = await seedPaidOrder(D, 31, "d1");
    const d30 = await sweepAndMail((m) => to(m) === D);
    assert(d30.mail.length === 1, `day 30: ${d30.mail.map((m) => m.subject).join(", ") || "none"}`);
    await setOrderAge(d1, D, 41); await quietReset(D);
    const d40 = await sweepAndMail((m) => to(m) === D);
    assert(d40.mail.length === 1, `day 40: ${d40.mail.map((m) => m.subject).join(", ") || "none"}`);
    await setOrderAge(d1, D, 51); await quietReset(D);
    const d50 = await sweepAndMail((m) => to(m) === D);
    assert(d50.mail.length === 1, `day 50: ${d50.mail.map((m) => m.subject).join(", ") || "none"}`);
    const click = await clickCta(ctaOf(d50.mail[0]));
    dToken = click.offerToken; dAutomation = click.automationCookie;
    const offers = await offersOf(D);
    assert(offers.length === 3 && offers.every((o) => !o.revoked_at && !o.redeemed_at), JSON.stringify(offers.map((o) => [o.offer_key, o.revoke_reason])));
    return `"${d50.mail[0].subject}"; 3 live gifts`;
  });

  await step("a $69 order gets the free GHK-Cu; paying it redeems that gift and closes the other two", async () => {
    const qt = await quote({ email: D, items: [BPC], offerToken: dToken });
    assert(qt.ok && /^GHK-Cu/.test(qt.quote.giftLines?.[0]?.name ?? "") && qt.quote.giftLines.length === 1, `quote ${JSON.stringify(qt.quote?.giftLines)}`);
    d2 = await checkoutApi({ email: D, items: [BPC], offerToken: dToken, automationCookie: dAutomation });
    await payOrder(d2);
    const offers = await offersOf(D);
    const ghk = offers.find((o) => o.offer_key === "winback_60_free_ghkcu");
    assert(ghk.redeemed_order_id === d2, "GHK gift not redeemed");
    const others = offers.filter((o) => o.offer_key !== "winback_60_free_ghkcu");
    assert(others.every((o) => o.revoke_reason === "cycle_closed" && o.closed_by_order_id === d2), JSON.stringify(others));
    const order = await orderOf(d2);
    assert(order.marketing_source_ref === "winback_60" && order.marketing_source_basis === "offer_redeemed", `source ${order.marketing_source_ref}/${order.marketing_source_basis}`);
    return `redeemed; ${others.length} earlier gifts closed by ${d2.slice(-8)}`;
  });

  await step("nothing further goes out for the old cycle", async () => {
    await setOrderAge(d1, D, 80); await quietReset(D);
    const { mail } = await sweepAndMail((m) => to(m) === D);
    assert(mail.length === 0, `sent: ${mail.map((m) => m.subject).join(", ")}`);
    return "nothing";
  });

  // ==========================================================================
  section("E. A gift against competing discounts: the right one wins, none is burned for nothing");
  const E = `e.${stamp}@example.test`;

  await step("15% gift vs a 50% coupon: the coupon wins, the gift is not shown, reserved or consumed", async () => {
    const token = await mintToken(E, "winback_60_percent_15", "welcome_no_purchase");
    const qt = await quote({ email: E, items: [BPC], couponCode: BIG, offerToken: token });
    assert(qt.ok && qt.quote.discountAmount === 34.5 && qt.quote.offer === null && qt.quote.discountLabel === "Coupon", JSON.stringify(qt.quote));
    const orderId = await checkoutApi({ email: E, items: [BPC], couponCode: BIG, offerToken: token });
    const offers = await offersOf(E);
    assert(offers[0].reserved_order_id === null, "the losing gift was reserved");
    await payOrder(orderId);
    const after = (await offersOf(E))[0];
    assert(after.redeemed_at === null, "the losing gift was consumed");
    // A paid order closes the cycle, so the unused gift is revoked — by design.
    assert(after.revoke_reason === "cycle_closed", `expected cycle_closed, got ${after.revoke_reason}`);
    const order = await orderOf(orderId);
    assert(order.coupon_code === BIG && Number(order.discount_amount) === 34.5, JSON.stringify(order));
    return `coupon −$34.50 on the order; gift untouched then closed by the purchase`;
  });

  await step("15% gift vs a 5% coupon: the gift wins and the losing code is not recorded", async () => {
    const E2 = `e2.${stamp}@example.test`;
    const token = await mintToken(E2, "winback_60_percent_15", "welcome_no_purchase");
    const qt = await quote({ email: E2, items: [BPC], couponCode: SMALL, offerToken: token });
    assert(qt.ok && qt.quote.discountAmount === 10.35 && qt.quote.offer?.percentApplied === true && qt.quote.discountLabel === "15% gift", JSON.stringify(qt.quote));
    const orderId = await checkoutApi({ email: E2, items: [BPC], couponCode: SMALL, offerToken: token });
    const order = await orderOf(orderId);
    assert(order.coupon_code === null && Number(order.discount_amount) === 10.35, JSON.stringify(order));
    assert((await offersOf(E2))[0].reserved_order_id === orderId, "the winning gift was not reserved");
    return `gift −$10.35; coupon ${SMALL} not recorded`;
  });

  await step("a free-shipping gift on an order that already ships free is not applied or reserved", async () => {
    const E3 = `e3.${stamp}@example.test`;
    const token = await mintToken(E3, "winback_60_free_shipping", "replenishment");
    const qt = await quote({ email: E3, items: [{ id: "bpc-157-10mg", quantity: 4 }], offerToken: token });
    assert(qt.ok && qt.quote.shipping === 0 && qt.quote.offer === null, JSON.stringify(qt.quote));
    const orderId = await checkoutApi({ email: E3, items: [{ id: "bpc-157-10mg", quantity: 4 }], offerToken: token });
    assert((await offersOf(E3))[0].reserved_order_id === null, "a gift that waived nothing was reserved");
    return `$276 basket: shipping already free, gift untouched`;
  });

  await step("a basket that only clears the minimum before a coupon does not get the gift", async () => {
    const E4 = `e4.${stamp}@example.test`;
    const token = await mintToken(E4, "winback_60_free_shipping", "replenishment");
    // $47.99 clears $35 on list price; after a 50% coupon the customer pays $24.
    const qt = await quote({ email: E4, items: [GHK], couponCode: BIG, offerToken: token });
    assert(qt.ok && qt.quote.offer === null && qt.quote.shipping === 15, JSON.stringify(qt.quote));
    return `$47.99 − 50% = $24 paid: under $35, shipping charged`;
  });

  // ==========================================================================
  section("F. A cart abandoned while holding a gift");
  const F = `f.${stamp}@example.test`;
  let fToken = null; let fCart = null;

  await step("the abandoned cart gets its first reminder; the gift is untouched", async () => {
    fToken = await mintToken(F, "winback_60_percent_15", "welcome_no_purchase");
    const sessionId = `qa-cart-${stamp}`;
    const r = await fetch(`${BASE}/api/cart/track`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": nextIp() },
      body: JSON.stringify({ sessionId, email: F, items: [{ id: "bpc-157-10mg", name: "BPC-157 10mg", quantity: 1, unitPriceCents: 6900 }], cartValueCents: 6900 }),
    });
    assert(r.status === 200, `track answered ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const cart = (await q(`select id from abandoned_carts where email = $1 order by first_seen_at desc limit 1`, [F])).rows[0];
    assert(cart, "no abandoned cart tracked");
    fCart = cart.id;
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where id = $1`, [fCart, ago(2 * HOUR)]);
    const { mail } = await sweepAndMail((m) => to(m) === F);
    assert(mail.length === 1, `expected one reminder, got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    assert(!/SAVE-/.test(decode(mail[0].html)), "the first reminder carried a discount code");
    return `"${mail[0].subject}", no code`;
  });

  await step("buying with the gift recovers the cart, and the order is credited to the gift's automation, not to cart recovery", async () => {
    const orderId = await checkoutApi({ email: F, items: [BPC], offerToken: fToken });
    await payOrder(orderId);
    const cart = (await q(`select status, recovered_order_id from abandoned_carts where id = $1`, [fCart])).rows[0];
    assert(cart.status === "recovered" && cart.recovered_order_id === orderId, JSON.stringify(cart));
    const order = await orderOf(orderId);
    assert(order.marketing_source_kind === "automation" && order.marketing_source_basis === "offer_redeemed", `source ${order.marketing_source_kind}/${order.marketing_source_basis}`);
    await quietReset(F);
    const { mail } = await sweepAndMail((m) => to(m) === F);
    assert(mail.length === 0, `recovery mail after purchase: ${mail.map((m) => m.subject).join(", ")}`);
    return `cart recovered; source automation/${order.marketing_source_ref}; no further reminders`;
  });

  // ==========================================================================
  section("G. A campaign and an automation due in the same tick");
  const G = `g.${stamp}@example.test`;
  let gCampaign = null;

  await step("one marketing email reaches the inbox in the window; the other is deferred, not lost", async () => {
    await seedSubscriber(G, 100);
    await seedPaidOrder(G, 31, "g1");
    await adminLogin();
    const created = await adminFetch("/api/admin/email/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: `QA tick ${stamp}`, subject: `Two favourites are back ${stamp}`, previewText: "", headline: "Back in stock", body: "Two of the most-requested compounds are back, with new batch certificates in the COA library.", promoCode: "", ctaLabel: "SEE WHAT IS BACK", ctaPath: "/products", segment: "all", segmentParam: "" }),
    });
    assert(created.status === 200 && created.body?.success, `create answered ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
    gCampaign = created.body.campaignId ?? created.body.id;
    const send = await adminFetch(`/api/admin/email/campaigns/${gCampaign}/send`, { method: "POST", body: JSON.stringify({ mode: "now" }) });
    assert(send.status === 200 && send.body?.success, `send answered ${send.status}: ${JSON.stringify(send.body).slice(0, 200)}`);
    const { body, mail } = await sweepAndMail((m) => to(m) === G);
    const sent = (await sentTypes(G)).filter((r) => r.status === "sent").map((r) => r.campaign_type);
    assert(sent.length === 1, `expected exactly one marketing send to ${G}, got ${sent.join(", ") || "none"} (mail: ${mail.map((m) => m.subject).join(", ")})`);
    const recipient = (await q(`select status, deferred_until from email_campaign_recipients where campaign_id = $1 and email = $2`, [gCampaign, G])).rows[0];
    const automationDeferred = Number(body.emailAutomations?.deferred ?? 0);
    const campaignDeferred = recipient && recipient.status === "pending" && recipient.deferred_until;
    assert(sent[0] === "campaign" ? automationDeferred >= 1 : Boolean(campaignDeferred), `the loser was not deferred: sent=${sent[0]}, automationDeferred=${automationDeferred}, recipient=${JSON.stringify(recipient)}`);
    return `${sent[0]} went out; the other deferred`;
  });

  await step("a day later the deferred message goes out", async () => {
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [G, ago(25 * HOUR)]);
    await q(`update email_campaign_recipients set deferred_until = now() - interval '1 minute' where campaign_id = $1 and email = $2 and deferred_until is not null`, [gCampaign, G]);
    await sweepAndMail((m) => to(m) === G);
    const sent = (await sentTypes(G)).filter((r) => r.status === "sent").map((r) => r.campaign_type).sort();
    assert(sent.join(",") === "automation:replenishment,campaign", `after the window: ${sent.join(", ")}`);
    return sent.join(" + ");
  });

  // ==========================================================================
  section("H. The reorder link for a signed-in customer, an expired session, and on a phone");
  const H = `h.${stamp}@example.test`;
  let hCta = null; let hSession = "";

  await step("a signed-in customer's reorder link lands on their orders", async () => {
    const signup = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json", ...SAME_ORIGIN, "x-real-ip": nextIp() },
      body: JSON.stringify({ email: H, password: "HarnessPass123!", fullName: "Holly Harness", businessType: "Other", referredByCode: "", captchaToken: "", nextPath: "/account", marketingOptIn: true }),
    });
    assert(signup.status === 200, `signup answered ${signup.status}`);
    const user = (await q(`select id from auth.users where email = $1`, [H])).rows[0];
    assert(user, "no auth user");
    await q(`update auth.users set created_at = $2 where id = $1`, [user.id, ago(100 * DAY)]);
    // The confirmation link is the real chain: /auth/confirm forwards to
    // GoTrue's /verify, which lands on /account/login?verified=1 with the
    // session in the URL FRAGMENT; the login form's script then posts those
    // tokens to /api/auth/session, which is what actually sets the cookie.
    // Node has no page script, so the last hop is made here by hand.
    const confirm = await fetch(`${BASE}/auth/confirm?token=harness-hashed-${user.id}&type=signup&next=%2Faccount`, { redirect: "manual" });
    assert(confirm.status === 303 && confirm.headers.get("location"), `confirm answered ${confirm.status}`);
    const verify = await fetch(confirm.headers.get("location"), { redirect: "manual" });
    const landing = verify.headers.get("location") ?? "";
    const fragment = new URLSearchParams(landing.split("#")[1] ?? "");
    const accessToken = fragment.get("access_token"); const refreshToken = fragment.get("refresh_token");
    assert(accessToken && landing.startsWith(`${BASE}/account/login?verified=1`), `verify chain ended at ${verify.status} ${landing.slice(0, 140)}`);
    const sess = await fetch(`${BASE}/api/auth/session`, {
      method: "POST", headers: { "Content-Type": "application/json", ...SAME_ORIGIN, "x-real-ip": nextIp() },
      body: JSON.stringify({ accessToken, refreshToken, rememberMe: true }),
    });
    const setCookies = typeof sess.headers.getSetCookie === "function" ? sess.headers.getSetCookie() : [sess.headers.get("set-cookie") ?? ""];
    // Keep the session cookie; drop the offer/attribution cookies so the click
    // below is judged on the session alone.
    hSession = setCookies.map((c) => c.split(";")[0]).filter((c) => c && !/^vl_(offer|automation|campaign)=/.test(c)).join("; ");
    assert(sess.status === 200 && hSession, `the session exchange set no cookie (status ${sess.status})`);
    await seedPaidOrder(H, 31, "h1");
    const { mail } = await sweepAndMail((m) => to(m) === H);
    assert(mail.length === 1, `expected the reorder reminder, got ${mail.map((m) => m.subject).join(", ") || "none"}`);
    hCta = ctaOf(mail[0]);
    const click = await clickCta(hCta, hSession);
    assert(click.status === 302 && click.location === `${BASE}/account/orders`, `signed in → ${click.status} ${click.location}`);
    return `→ /account/orders`;
  });

  await step("with an expired session the same link lands on the catalogue, gift still armed", async () => {
    const click = await clickCta(hCta, "sb-access-token=expired; sb-refresh-token=expired");
    assert(click.status === 302 && click.location === `${BASE}/products`, `expired → ${click.status} ${click.location}`);
    assert(click.offerToken, "gift cookie not set");
    return "→ /products";
  });

  await step("on a phone, a guest lands on the catalogue and the cart announces the gift", async () => {
    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--ssl-version-max=tls1.2"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "x-real-ip": nextIp() } });
      const page = await context.newPage();
      await page.goto(hCta, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      assert(new URL(page.url()).pathname === "/products", `landed on ${page.url()}`);
      const cookies = await context.cookies();
      assert(cookies.some((c) => c.name === "vl_offer"), "no vl_offer cookie in the phone browser");
      const status = await page.evaluate(() => fetch("/api/offer/status").then((r) => r.json()));
      assert(status?.offer?.rewardKind === "free_shipping", `offer status ${JSON.stringify(status)}`);
      await page.screenshot({ path: `${SHOTS}/mobile-reorder-landing.png`, fullPage: false });
      return `→ /products at 390×844; gift ${status.offer.rewardKind} armed`;
    } finally {
      await browser.close();
    }
  });

  // ==========================================================================
  section("I. The admin numbers agree with what happened");
  await step("the automations panel reports the gifts issued and redeemed above, by primary source", async () => {
    const page = await adminFetch("/admin/email?range=7d");
    assert(page.status === 200, `admin email page answered ${page.status}`);
    assert(!/automation-stats-error/.test(page.text), "the stats panel shows an error state");
    const tile = (key) => {
      const m = page.text.match(new RegExp(`data-testid="automation-${key}-stats"[\\s\\S]*?</dl>`));
      return m ? m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : "";
    };
    const w30 = tile("winback_30");
    assert(/Gifts issued\s+\d+/.test(w30), `no gift tiles for winback_30: ${w30.slice(0, 200)}`);
    const issued = Number(w30.match(/Gifts issued\s+(\d+)/)?.[1] ?? 0);
    const redeemed = Number(w30.match(/Gifts redeemed\s+(\d+)/)?.[1] ?? 0);
    const orders = Number(w30.match(/Orders\s+(\d+)/)?.[1] ?? 0);
    assert(issued >= 2 && redeemed >= 1 && orders >= 1, `winback_30 tiles: issued ${issued}, redeemed ${redeemed}, orders ${orders}`);
    return `winback_30: ${issued} issued, ${redeemed} redeemed, ${orders} orders (7-day window)`;
  });

  await pool.end();
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  writeFileSync(`${CAPTURE_DIR}/retention-results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${passed} passed, ${failed.length} failed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
