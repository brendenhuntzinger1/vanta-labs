#!/usr/bin/env node
/**
 * THE PROMISED GIFT, FROM THE EMAIL TO THE TILL, IN THE STATES A CUSTOMER IS
 * REALLY IN.
 *
 *   a real sweep mints and sends  ->  the tracked link  ->  the account wall
 *   ->  the attestation step where one is required  ->  the offer still armed
 *   ->  catalogue and cart  ->  the gift priced  ->  checkout  ->  payment
 *   ->  consumed exactly once
 *
 * WHY A SECOND OFFER SUITE. qa-customer-offer proves the PRICING rules — the
 * minimum, the binding to one address, expiry, permanence across a refund — with
 * a token it mints itself and a shopper who is already signed in. qa-gift-wiring
 * proves the WIRING — an operator attaches a gift in the admin, a sweep mints
 * one token per recipient, the emailed link arms it. Neither walks a recipient
 * through the door they actually arrive at, and the doors are where the promise
 * gets lost:
 *
 *   * emailLinkLanding has THREE landings, not one. An attested recipient gets
 *     a marketing-link grant and goes straight through. An unattested one is
 *     sent to /attest carrying a signed handoff, and the grant is minted on the
 *     far side only after both representations are made explicitly. One with no
 *     account at all is routed into sign-up with the destination riding along.
 *   * The gift travels in an httpOnly cookie that the interstitial has to
 *     RE-ARM, because a browser that dropped it across the detour must not lose
 *     the thing the email promised.
 *
 * So this file never mints a token itself. It configures an automation, runs the
 * real lifecycle route, reads the link out of the delivered message, and clicks
 * it — then follows whichever of the three landings it is given.
 *
 * SELF-SEEDING AND SELF-RESTORING. It sets the automation, the gift and the
 * stock it needs, and puts all three back afterwards, so its verdict does not
 * depend on what ran before it and it cannot change the verdict of what runs
 * after. See scripts/qa-harness-up.sh and the isolation notes in the runbook.
 *
 * Local harness only.
 *
 *   node scripts/qa-offer-journey.mjs
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";
import { allowLoopbackSelfSignedTls } from "./qa-loopback-tls.mjs";
import { captureAutomations, pinAutomations, restoreAutomations } from "./qa-automation-fixtures.mjs";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";

// Links inside a captured email point at the harness TLS proxy, whose
// certificate is self-signed; without this a fetch that follows one fails
// with a bare "fetch failed". No-op unless BASE is loopback.
allowLoopbackSelfSignedTls(BASE);
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CRON = process.env.CRON_SECRET ?? "harness-cron-secret";
const PASSWORD = "HarnessPass123!";
const stamp = randomUUID().slice(0, 6);
const DAY = 24 * 60 * 60 * 1000;

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

// The links inside a captured email are built from NEXT_PUBLIC_SITE_URL, which
// is the harness TLS proxy — so the browser crosses to https://127.0.0.1:3443
// whichever base this suite is driven at, and its certificate is self-signed.
// Scoped to loopback, so a run pointed anywhere else keeps full verification.
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(BASE);
const LOOPBACK_TLS = LOOPBACK ? { ignoreHTTPSErrors: true } : {};

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

let checks = 0;
let failures = 0;
let currentSection = "";
const section = (t) => { currentSection = t; console.log(`\n${t}`); };
function check(ok, label, detail = "") {
  checks += 1;
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };

const CHROME = process.env.QA_CHROMIUM
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));

// ---------------------------------------------------------------------------
// Fixtures — every one of them restored in the finally block
// ---------------------------------------------------------------------------

/** The automation that carries the gift, and the gift it carries. */
const AUTOMATION = "winback_60";
const OFFER_KEY = "winback_60_free_ghkcu";
const GIFT_SLUG = "ghk-cu";
const BUY_SLUG = "bpc-157-10mg";      // $69, clears the gift's $60 minimum

let automationBefore = null;
let stockBefore = null;

async function seedFixtures() {
  automationBefore = await captureAutomations(q);
  // Only the GIFT is imposed. The schedule is left exactly as the store runs it
  // (win-back 1 at 45 days, win-back 2 at 75, thirty days apart), because the
  // ladder spacing is part of what the journey has to survive — a suite that
  // flattened the delays would prove a sequence this store never sends.
  //
  // AND THE OTHER FLOWS' GIFTS ARE STATED TOO, AS ABSENT. This file counts the
  // offers minted for one customer and expects exactly one. Win-back 1 climbs
  // the same ladder on the way up, so a gift left on IT by another suite mints a
  // second row and "no second gift is minted for them" fails with "2 offer
  // row(s)" — an accurate count of a store this file never configured.
  await pinAutomations(q, Object.fromEntries([
    [AUTOMATION, { enabled: true, offerKey: OFFER_KEY }],
    ...["winback_30", "replenishment", "post_purchase", "welcome_intro", "welcome_no_purchase", "browse_abandonment"]
      .map((key) => [key, { offerKey: null }]),
  ]));

  stockBefore = (await q(
    `select slug, inventory_quantity, reserved_quantity, stock_status from products where slug in ($1,$2)`,
    [GIFT_SLUG, BUY_SLUG],
  )).rows;
  // The gift is a real order line and consumes real stock, so an un-topped-up
  // catalogue runs dry mid-run and later steps fail with "just sold out"
  // rather than with anything about the offer.
  await q(
    `update products set inventory_quantity = 500, reserved_quantity = 0, stock_status = 'In Stock'
      where slug in ($1,$2)`, [GIFT_SLUG, BUY_SLUG],
  );
  await q(
    `update product_doses set inventory_quantity = 500, reserved_quantity = 0, stock_status = 'In Stock'
      where product_id in (select id from products where slug in ($1,$2))`, [GIFT_SLUG, BUY_SLUG],
  ).catch(() => {});
}

async function restoreFixtures() {
  await restoreAutomations(q, automationBefore);
  for (const row of stockBefore ?? []) {
    await q(
      `update products set inventory_quantity = $2, reserved_quantity = $3, stock_status = $4 where slug = $1`,
      [row.slug, row.inventory_quantity, row.reserved_quantity, row.stock_status],
    ).catch(() => {});
  }
}

/**
 * A lapsed customer the win-back is due for.
 *
 * `attested` is the whole point of this file: it decides which of
 * emailLinkLanding's three doors the recipient walks through.
 */
async function seedLapsedCustomer(label, { withAccount = true, attested = true } = {}) {
  const email = `offer.${label}.${stamp}@example.test`;
  if (withAccount) {
    await q(
      `insert into auth.users (email, encrypted_password, email_confirmed_at, created_at)
       values ($1,$2,now(),now())
       on conflict (email) do update set encrypted_password = excluded.encrypted_password,
         email_confirmed_at = now()`,
      [email, PASSWORD],
    );
    if (attested) {
      // The same record POST /api/attest writes. Set directly so the ATTESTED
      // door can be walked without also re-testing the interstitial, which
      // section 2 does on its own.
      await q(
        `update auth.users
            set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
              || jsonb_build_object('age_confirmed_21', true, 'research_use_only_agreed', true,
                                    'attested_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSZ'),
                                    'attested_via', 'email_link_interstitial')
          where lower(email) = lower($1)`,
        [email],
      );
    }
  }
  await q(
    `insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', now() - interval '400 days')
     on conflict (email) do nothing`, [email],
  );
  await q(
    `insert into orders (order_id, customer_email, customer_name, payment_status, order_type,
                         amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at)
     values ($1,$2,'Lapsed Customer','paid','product',69,69,0,0,'USD', now() - interval '80 days')`,
    [`order-offer-${label}-${stamp}`, email],
  );
  return email;
}

const runLifecycle = async () => {
  const res = await fetch(`${BASE}/api/cron/lifecycle`, { headers: { authorization: `Bearer ${CRON}` } });
  const body = await res.json().catch(() => null);
  assert(res.status === 200, `lifecycle answered ${res.status}`);
  assert(body && Object.prototype.hasOwnProperty.call(body, "emailAutomations"),
    `the lifecycle route ran no emailAutomations job: ${Object.keys(body ?? {}).join(", ")}`);
  return body;
};

const CAPTURE = `${process.env.EMAIL_CAPTURE_DIR ?? process.env.QA_LOG_DIR ?? "/tmp/vanta-qa"}/captured-emails.jsonl`;

/** Every message delivered to `email`, newest last. Never throws. */
function mailFor(email) {
  try {
    if (!existsSync(CAPTURE)) return [];
    return readFileSync(CAPTURE, "utf8").split("\n")
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((m) => m && String(m.to ?? "").toLowerCase().includes(email.toLowerCase()));
  } catch {
    return [];
  }
}

const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/=\r?\n/g, "").replace(/=3D/g, "=");
const linksIn = (mail) => [...new Set(decode(mail.html ?? "").match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];

/** The tracked automation-click link, which is where the whole journey starts. */
function trackedLinkFor(email, key = AUTOMATION) {
  const messages = mailFor(email);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const link = linksIn(messages[i]).find(
      (l) => /\/api\/email\/automation-click\?/.test(l) && l.includes(`k=${key}`),
    );
    if (link) return { link, message: messages[i] };
  }
  return { link: null, message: null };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

let browser = null;
const newContext = () => browser.newContext({ ...LOOPBACK_TLS, viewport: { width: 1280, height: 900 } });

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

async function signIn(page, email) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const accept = page.getByRole("button", { name: /^Accept$/ });
  if (await accept.count()) await accept.first().click().catch(() => {});
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await page.$("form input[type=email]")) break;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(500);
  }
  if (!(await page.$("form input[type=email]"))) return false;
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", PASSWORD);
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => {}),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(1500);
  return !/\/account\/login/.test(page.url());
}

const cookieNames = async (context) => (await context.cookies()).map((c) => c.name);

/** Place the order the checkout page places, and return what the server said. */
const placeOrder = (page, email, items) => page.evaluate(async ({ email: e, items: lines }) => {
  const res = await fetch("/api/checkout/create-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      items: lines,
      customer: {
        email: e, fullName: "Offer Journey", address: "1 Harness Way",
        city: "Testville", state: "CA", postalCode: "90000", country: "US", phone: "5555555555",
      },
      currency: "USD",
      complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { email, items });

function payOrder(orderId, eventType) {
  return execFileSync("node", ["scripts/harness-pay-order.mjs", orderId], {
    cwd: process.cwd(), encoding: "utf8",
    env: {
      ...process.env,
      PAYMENT_WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret",
      QA_BASE_URL: BASE,
      ...(eventType ? { HARNESS_EVENT_TYPE: eventType } : {}),
    },
  });
}

const offerRowFor = async (email) => (await q(
  `select id, token_hash, expires_at, reserved_order_id, redeemed_order_id, redeemed_at, revoked_at
     from customer_offers where email = $1 order by issued_at desc limit 1`, [email],
)).rows[0] ?? null;

const orderLines = async (orderId) => (await q(
  `select product_id, quantity, unit_price from order_items where order_id = $1 order by unit_price desc`, [orderId],
)).rows;

const clearRateLimit = () => q("delete from rate_limit_hits").catch(() => {});

/** Mint and deliver this customer's gift, then hand back the emailed link. */
async function mintAndDeliver(email) {
  await clearRateLimit();

  // WIN-BACK 2 IS THE SECOND RUNG, AND THE SWEEP WILL NOT SKIP THE FIRST.
  // selectAutomationTargets holds win-back 2 until win-back 1 has gone for THIS
  // lapse episode and the thirty days between their delays have passed, and the
  // frequency guard holds any second marketing message for a day after the
  // first. So the customer is walked up the ladder the way a real one is: the
  // sweep sends win-back 1, the clock is moved on past both gaps, and the sweep
  // is asked again. Nothing about the rules is relaxed to get the gift sent.
  await runLifecycle();
  await new Promise((r) => setTimeout(r, 600));
  assert(trackedLinkFor(email, "winback_30").link,
    `the first rung of the ladder never reached ${email}`);
  // One table carries both clocks: email_send_log is where the ladder reads
  // "win-back 1 went for this episode" and where the frequency guard reads
  // "this inbox was mailed recently".
  await q(`update email_send_log set sent_at = sent_at - interval '31 days'
            where lower(recipient_email) = lower($1)`, [email]);

  await runLifecycle();
  await new Promise((r) => setTimeout(r, 900));
  const { link, message } = trackedLinkFor(email);
  assert(link, `no tracked link was delivered to ${email}`);
  const offer = await offerRowFor(email);
  assert(offer, `no customer_offers row was minted for ${email}`);
  return { link, message, offer };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Offer journey — run ${stamp}`);
  await seedFixtures();
  browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  // -------------------------------------------------------------------------
  section("1. The attested recipient: email → link → grant → cart → paid");
  // -------------------------------------------------------------------------
  const attested = await seedLapsedCustomer("attested");
  const first = await mintAndDeliver(attested);
  check(
    /o=/.test(first.link),
    "the delivered link carries the offer token",
    first.link.slice(0, 140),
  );
  check(
    !first.link.includes(first.offer.token_hash),
    "the link carries the token, never the hash the database stores",
  );

  const ctx1 = await newContext();
  const page1 = await ctx1.newPage();
  await page1.goto(first.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page1.waitForTimeout(1500);
  const cookies1 = await cookieNames(ctx1);
  check(cookies1.includes("vl_offer"), "the click arms the gift", cookies1.join(","));
  check(
    cookies1.includes("vl_email_grant"),
    "an ATTESTED recipient is granted the store without signing in",
    cookies1.join(","),
  );
  check(
    !/\/attest/.test(page1.url()),
    "and is not detoured through the attestation step",
    page1.url(),
  );

  await page1.goto(`${BASE}/products/${BUY_SLUG}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page1.waitForTimeout(1200);
  await dismissOverlays(page1);
  check(
    (await page1.getByRole("button", { name: /add to cart/i }).count()) > 0,
    "the grant opens the catalogue to a shopper with no session",
  );

  const placed1 = await placeOrder(page1, attested, [{ id: BUY_SLUG, quantity: 1 }]);
  check(placed1.status === 200 && placed1.body?.orderId, "the order is created",
    `status ${placed1.status}: ${JSON.stringify(placed1.body).slice(0, 160)}`);
  const order1 = placed1.body?.orderId;
  if (order1) {
    const lines = await orderLines(order1);
    const gift = lines.find((l) => Number(l.unit_price) === 0);
    check(Boolean(gift), "the promised gift is on the order at $0",
      JSON.stringify(lines).slice(0, 200));
    const held = await offerRowFor(attested);
    check(held?.reserved_order_id === order1 && !held.redeemed_at,
      "the offer is HELD for this checkout, not yet consumed",
      JSON.stringify(held).slice(0, 160));

    payOrder(order1);
    const consumed = await offerRowFor(attested);
    check(consumed?.redeemed_order_id === order1 && Boolean(consumed.redeemed_at),
      "paying consumes it exactly once", JSON.stringify(consumed).slice(0, 160));

    // AND A RETRY CANNOT CONSUME IT TWICE.
    payOrder(order1);
    payOrder(order1);
    const afterReplay = await q(
      `select count(*)::int as n from customer_offers where email = $1 and redeemed_at is not null`, [attested],
    );
    check(afterReplay.rows[0].n === 1,
      "three deliveries of the same payment leave exactly one redemption",
      `${afterReplay.rows[0].n} redeemed row(s)`);
  }
  await ctx1.close();

  // -------------------------------------------------------------------------
  section("2. The UNATTESTED recipient: the interstitial is the door, not a wall");
  // -------------------------------------------------------------------------
  const unattested = await seedLapsedCustomer("unattested", { attested: false });
  const second = await mintAndDeliver(unattested);

  const ctx2 = await newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(second.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page2.waitForTimeout(1500);
  const cookies2 = await cookieNames(ctx2);
  check(/\/attest/.test(page2.url()),
    "an unattested recipient is sent to the attestation step", page2.url());
  check(cookies2.includes("vl_offer"),
    "the gift is armed on the way in, before any representation is made", cookies2.join(","));
  check(!cookies2.includes("vl_email_grant"),
    "and NO grant is issued before they have made both statements", cookies2.join(","));

  // The catalogue is still closed to them at this point.
  const peek = await page2.evaluate(async () => {
    const res = await fetch("/api/catalog/products", { credentials: "same-origin" });
    return res.status;
  });
  check(peek === 401 || peek === 403 || peek === 307,
    "the store stays shut until they attest", `catalogue answered ${peek}`);

  // Make both statements, exactly as the page does.
  const attestResult = await page2.evaluate(async () => {
    const handoff = new URL(location.href).searchParams.get("h");
    const res = await fetch("/api/attest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ h: handoff, ageConfirmed: true, researchUseOnly: true }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  check(attestResult.status === 200 && attestResult.body?.ok,
    "attesting is accepted", JSON.stringify(attestResult).slice(0, 200));

  const cookies2b = await cookieNames(ctx2);
  check(cookies2b.includes("vl_email_grant"),
    "the grant is minted on the far side of the representations", cookies2b.join(","));
  check(cookies2b.includes("vl_offer"),
    "and the promised gift is STILL armed — the detour did not cost it", cookies2b.join(","));

  await page2.goto(`${BASE}/products/${BUY_SLUG}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page2.waitForTimeout(1200);
  await dismissOverlays(page2);
  const placed2 = await placeOrder(page2, unattested, [{ id: BUY_SLUG, quantity: 1 }]);
  check(placed2.status === 200 && placed2.body?.orderId,
    "they can now buy, and the gift is still theirs",
    `status ${placed2.status}: ${JSON.stringify(placed2.body).slice(0, 160)}`);
  if (placed2.body?.orderId) {
    const lines = await orderLines(placed2.body.orderId);
    check(lines.some((l) => Number(l.unit_price) === 0),
      "the gift the email promised is on the order at $0", JSON.stringify(lines).slice(0, 200));
    payOrder(placed2.body.orderId);
    const consumed = await offerRowFor(unattested);
    check(Boolean(consumed?.redeemed_at), "and it is consumed by the paid order");
  }

  // A SECOND VISIT FINDS THEM ATTESTED, with no interstitial at all.
  const ctx2c = await newContext();
  const page2c = await ctx2c.newPage();
  await page2c.goto(second.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page2c.waitForTimeout(1200);
  check(!/\/attest/.test(page2c.url()),
    "a second visit finds them attested and goes straight through", page2c.url());
  await ctx2c.close();
  await ctx2.close();

  // -------------------------------------------------------------------------
  section("3. Links that must not work");
  // -------------------------------------------------------------------------
  const victim = await seedLapsedCustomer("victim");
  const third = await mintAndDeliver(victim);

  // A TAMPERED OFFER TOKEN. The link's own click token still verifies, so the
  // redirect happens; what must not happen is a gift being armed from it.
  const tampered = third.link.replace(/o=([^&]+)/, (_m, token) => `o=${token.slice(0, -4)}AAAA`);
  const ctxT = await newContext();
  const pageT = await ctxT.newPage();
  await pageT.goto(tampered, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageT.waitForTimeout(1200);
  const placedT = await placeOrder(pageT, victim, [{ id: BUY_SLUG, quantity: 1 }]);
  if (placedT.body?.orderId) {
    const lines = await orderLines(placedT.body.orderId);
    check(!lines.some((l) => Number(l.unit_price) === 0),
      "a tampered offer token prices no gift", JSON.stringify(lines).slice(0, 200));
  } else {
    check(true, "a tampered offer token prices no gift (the order was refused outright)");
  }
  await ctxT.close();

  // THE WRONG PERSON. Somebody forwards the email; the recipient is a real,
  // signed-in customer of the store, which is the strongest version of this.
  const stranger = await seedLapsedCustomer("stranger");
  const ctxS = await newContext();
  const pageS = await ctxS.newPage();
  await pageS.goto(third.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageS.waitForTimeout(1200);
  assert(await signIn(pageS, stranger), "the stranger could not sign in");
  const placedS = await placeOrder(pageS, stranger, [{ id: BUY_SLUG, quantity: 1 }]);
  if (placedS.body?.orderId) {
    const lines = await orderLines(placedS.body.orderId);
    check(!lines.some((l) => Number(l.unit_price) === 0),
      "a forwarded link buys the wrong person nothing", JSON.stringify(lines).slice(0, 200));
  } else {
    check(true, "a forwarded link buys the wrong person nothing (refused outright)");
  }
  const victimOffer = await offerRowFor(victim);
  check(!victimOffer?.redeemed_at,
    "and the gift it was forwarded FROM is untouched", JSON.stringify(victimOffer).slice(0, 140));
  await ctxS.close();

  // AN EXPIRED OFFER. Expiry is a stored timestamp, so move it into the past —
  // that is the same state the customer reaches by waiting.
  await q(`update customer_offers set expires_at = now() - interval '1 hour' where email = $1`, [victim]);
  const ctxE = await newContext();
  const pageE = await ctxE.newPage();
  await pageE.goto(third.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageE.waitForTimeout(1200);
  const placedE = await placeOrder(pageE, victim, [{ id: BUY_SLUG, quantity: 1 }]);
  if (placedE.body?.orderId) {
    const lines = await orderLines(placedE.body.orderId);
    check(!lines.some((l) => Number(l.unit_price) === 0),
      "an expired gift prices nothing, on the hour it expires",
      JSON.stringify(lines).slice(0, 200));
  } else {
    check(true, "an expired gift prices nothing (the order was refused outright)");
  }
  await ctxE.close();

  // -------------------------------------------------------------------------
  section("4. One gift, two checkouts, at the same moment");
  // -------------------------------------------------------------------------
  const racer = await seedLapsedCustomer("racer");
  const fourth = await mintAndDeliver(racer);
  const ctxR = await newContext();
  const pageA = await ctxR.newPage();
  await pageA.goto(fourth.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageA.waitForTimeout(1200);
  // Two tabs of ONE browser, which is how a real shopper does this.
  const pageB = await ctxR.newPage();
  await pageB.goto(`${BASE}/products/${BUY_SLUG}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await clearRateLimit();

  const [raceA, raceB] = await Promise.all([
    placeOrder(pageA, racer, [{ id: BUY_SLUG, quantity: 1 }]),
    placeOrder(pageB, racer, [{ id: BUY_SLUG, quantity: 1 }]),
  ]);
  const raceOrders = [raceA, raceB].map((r) => r.body?.orderId).filter(Boolean);
  let giftedOrders = 0;
  for (const id of raceOrders) {
    const lines = await orderLines(id);
    if (lines.some((l) => Number(l.unit_price) === 0)) giftedOrders += 1;
  }
  check(giftedOrders <= 1,
    "two simultaneous checkouts cannot both take the same gift",
    `${giftedOrders} of ${raceOrders.length} order(s) carried it`);
  check(raceOrders.length >= 1, "and at least one of them still becomes an order",
    `${raceOrders.length} order(s)`);
  await ctxR.close();

  // -------------------------------------------------------------------------
  section("5. A declined payment, a retry, and then a sale");
  // -------------------------------------------------------------------------
  const retrier = await seedLapsedCustomer("retry");
  const fifth = await mintAndDeliver(retrier);
  const ctxD = await newContext();
  const pageD = await ctxD.newPage();
  await pageD.goto(fifth.link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageD.waitForTimeout(1200);
  await clearRateLimit();
  const declined = await placeOrder(pageD, retrier, [{ id: BUY_SLUG, quantity: 1 }]);
  check(Boolean(declined.body?.orderId), "the first attempt creates an order",
    JSON.stringify(declined.body).slice(0, 160));
  if (declined.body?.orderId) {
    payOrder(declined.body.orderId, "payment.failed");
    const afterDecline = await offerRowFor(retrier);
    check(!afterDecline?.redeemed_at,
      "a declined payment does NOT consume the gift", JSON.stringify(afterDecline).slice(0, 160));

    await clearRateLimit();
    const retried = await placeOrder(pageD, retrier, [{ id: BUY_SLUG, quantity: 1 }]);
    check(Boolean(retried.body?.orderId), "they can try again",
      JSON.stringify(retried.body).slice(0, 160));
    if (retried.body?.orderId) {
      const lines = await orderLines(retried.body.orderId);
      check(lines.some((l) => Number(l.unit_price) === 0),
        "and the gift they were promised is still on the retry",
        JSON.stringify(lines).slice(0, 200));
      payOrder(retried.body.orderId);
      const n = await q(
        `select count(*)::int as n from customer_offers where email = $1 and redeemed_at is not null`, [retrier],
      );
      check(n.rows[0].n === 1,
        "and across a decline and a success it is consumed exactly once",
        `${n.rows[0].n} redemption(s)`);
    }
  }
  await ctxD.close();

  // -------------------------------------------------------------------------
  section("6. A purchase ends the sequence that was chasing it");
  // -------------------------------------------------------------------------
  {
    const before = await q(
      `select count(*)::int as n from email_send_log
        where recipient_email = $1 and campaign_type = $2`, [attested, `automation:${AUTOMATION}`],
    );
    await clearRateLimit();
    await runLifecycle();
    await new Promise((r) => setTimeout(r, 700));
    const after = await q(
      `select count(*)::int as n from email_send_log
        where recipient_email = $1 and campaign_type = $2`, [attested, `automation:${AUTOMATION}`],
    );
    check(after.rows[0].n === before.rows[0].n,
      "a customer who bought is not chased again by the same win-back",
      `${before.rows[0].n} → ${after.rows[0].n}`);

    const offers = await q(
      `select count(*)::int as n from customer_offers where email = $1`, [attested],
    );
    check(offers.rows[0].n === 1,
      "and no second gift is minted for them",
      `${offers.rows[0].n} offer row(s)`);
  }

  // -------------------------------------------------------------------------
  section("7. The gift is out of stock");
  // -------------------------------------------------------------------------
  {
    const unlucky = await seedLapsedCustomer("oos");
    const sixth = await mintAndDeliver(unlucky);
    await q(
      `update products set inventory_quantity = 0, reserved_quantity = 0, stock_status = 'Out of Stock'
        where slug = $1`, [GIFT_SLUG],
    );
    await q(
      `update product_doses set inventory_quantity = 0, reserved_quantity = 0, stock_status = 'Out of Stock'
        where product_id = (select id from products where slug = $1)`, [GIFT_SLUG],
    ).catch(() => {});

    const ctxO = await newContext();
    const pageO = await ctxO.newPage();
    await pageO.goto(sixth.link, { waitUntil: "domcontentloaded", timeout: 60000 });
    await pageO.waitForTimeout(1200);
    await clearRateLimit();
    const placedO = await placeOrder(pageO, unlucky, [{ id: BUY_SLUG, quantity: 1 }]);
    check(Boolean(placedO.body?.orderId),
      "a shopper whose gift is out of stock can still buy what they came for",
      `status ${placedO.status}: ${JSON.stringify(placedO.body).slice(0, 180)}`);
    if (placedO.body?.orderId) {
      const lines = await orderLines(placedO.body.orderId);
      check(!lines.some((l) => Number(l.unit_price) === 0),
        "the unavailable gift is simply absent, not a $0 line the warehouse cannot ship",
        JSON.stringify(lines).slice(0, 200));
      const stillHeld = await offerRowFor(unlucky);
      check(!stillHeld?.redeemed_at,
        "and the promise is not silently burned — it is still theirs to spend",
        JSON.stringify(stillHeld).slice(0, 160));
    }
    await ctxO.close();

    // Put the gift back for anything that runs after this file.
    await q(
      `update products set inventory_quantity = 500, reserved_quantity = 0, stock_status = 'In Stock'
        where slug = $1`, [GIFT_SLUG],
    );
    await q(
      `update product_doses set inventory_quantity = 500, reserved_quantity = 0, stock_status = 'In Stock'
        where product_id = (select id from products where slug = $1)`, [GIFT_SLUG],
    ).catch(() => {});
  }
}

main()
  .catch((error) => {
    failures += 1;
    console.error(`\nFATAL in "${currentSection}": ${error.message}\n${error.stack ?? ""}`);
  })
  .finally(async () => {
    await restoreFixtures();
    if (browser) await browser.close().catch(() => {});
    await pool.end().catch(() => {});
    console.log(`\n${checks} checks: ${checks - failures} passed, ${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
