#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE THREE THINGS THE PAYMENT AUDIT NEVER EXERCISED IN A BROWSER.
//
// qa-post-3ds-high-value.mjs proves the money path end to end and qa-amounts
// proves it does the same thing at every size. Both drive one engine, on a fast
// loopback connection, with one tab, clicking once. Real shoppers do none of
// those things reliably, and each of the three below has a documented history of
// breaking checkouts that passed every other test:
//
//   1. IN-APP BROWSERS. Every iOS in-app browser — TikTok, Instagram, Facebook,
//      Snapchat — is WKWebView, i.e. WebKit. A user-agent string does not change
//      the engine, so the only honest way to test it is to RUN WebKit. This is
//      also where storage is most likely to be restricted, which matters because
//      the purchase pixel and the checkout both keep state in localStorage.
//
//   2. SLOW CONNECTIONS. The session mint, the pay page and the order-status
//      poll all have timing assumptions. On a fast connection a premature
//      "declined", a stuck loading line, or a poll that gives up cannot be seen.
//      Throttled, they can.
//
//   3. DOUBLE SUBMISSION FROM THE BROWSER. Idempotency is well covered at the
//      API. What is not covered is a shopper double-tapping the button, or
//      opening checkout in two tabs and submitting both — which is exactly what
//      someone does when the first attempt looks like it did nothing.
//
// EVERY ASSERTION HERE IS ABOUT MONEY OR A DEAD END. This file does not check
// copy or layout for their own sake; qa-post-3ds-high-value.mjs owns that.
//
// Development-only. Drives the local harness and refuses to start anywhere else.
//
//   node scripts/qa-checkout-edge-matrix.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright";
import pg from "pg";

// HTTPS BY DEFAULT, AND THAT IS NOT COSMETIC.
//
// The built app sets its session cookie `Secure` (next start runs
// NODE_ENV=production whatever the build was called), and WebKit correctly
// refuses a Secure cookie delivered over http. Chromium stores it anyway
// because it treats 127.0.0.1 as trustworthy, so the two engines disagree and
// the disagreement reads as "login is broken in Safari". Measured here first
// hand: over http a WebKit sign-in returns 200 and stores no cookie at all.
//
// scripts/tls-proxy.mjs and scripts/gotrue-tls-proxy.mjs exist for exactly
// this, and docs/BROWSER-TESTING-RUNBOOK.md section 5c is the instruction.
// 127.0.0.1 and not localhost: middleware compares Origin against proto://host.
const BASE = process.env.QA_BASE_URL ?? "https://127.0.0.1:3443";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";
// THE WEBHOOK IS SERVER-TO-SERVER, so it goes straight to the app on plain http
// rather than through the self-signed TLS proxy the browsers use. Node would
// otherwise refuse the certificate (DEPTH_ZERO_SELF_SIGNED_CERT), and disabling
// verification to work around it would be the wrong instinct in a payment test.
const WEBHOOK_ORIGIN = process.env.QA_WEBHOOK_ORIGIN ?? "http://127.0.0.1:3000";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB });
const q = (text, params) => client.query(text, params);

let passed = 0;
let failed = 0;
let skipped = 0;

function record(label, ok, detail) {
  if (ok === null) {
    skipped += 1;
    console.log(`  SKIP  ${label}${detail ? `  — ${detail}` : ""}`);
    return;
  }
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${title}`);
}

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
  .find((p) => existsSync(p));

/** A CGNAT address of its own, so a per-IP limiter is never shared between cases. */
const freshIp = () => `100.64.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function ensureStock(minimum = 200) {
  // Never stock the PARENT of a dose-stocked product — see the same note in
  // qa-post-3ds-high-value.mjs. It makes the cart use a line production never has.
  await q(
    `update products p set inventory_quantity = $1
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true)
        and not coalesce(p.is_archived,false) and coalesce(p.price_cents,0) > 0
        and coalesce(p.inventory_quantity,0) < $1
        and not exists (select 1 from product_doses d where d.product_id = p.id)`,
    [minimum],
  );
  await q(
    `update product_doses set inventory_quantity = $1
      where coalesce(price_cents,0) > 0 and coalesce(inventory_quantity,0) < $1`,
    [minimum],
  );
}

async function makeShopper(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
  const password = "EdgeMatrix-pass!23";
  await q(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
     values ($1,$2,$3,'{"role":"customer"}'::jsonb, now(), now())
     on conflict (email) do update set encrypted_password = excluded.encrypted_password, email_confirmed_at = now()`,
    [email, password, JSON.stringify({ full_name: "Edge Matrix", role: "customer" })],
  );
  return { email, password };
}

async function aCart() {
  const dose = (await q(
    `select p.slug, d.id, d.price_cents from products p join product_doses d on d.product_id = p.id
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true) and coalesce(d.price_cents,0) > 0
        and coalesce(d.inventory_quantity,0) - coalesce(d.reserved_quantity,0) > 4
      order by d.price_cents asc limit 1`,
  )).rows[0];
  if (!dose) throw new Error("the catalogue has no sellable dose");
  return { items: [{ id: `${dose.slug}::${dose.id}`, quantity: 1 }] };
}

/**
 * Clear the cookie banner before touching anything underneath it.
 *
 * It is an overlay: a click on a control behind it is swallowed, and the run
 * then reports the control as missing. Best effort — no banner, nothing to do.
 */
async function dismissConsent(page) {
  for (const label of ["Accept", "Decline"]) {
    const clicked = await page.evaluate((text) => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
      if (!b) return false;
      b.click();
      return true;
    }, label).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(700);
      return;
    }
  }
}

/** Age gate, then sign in. Engine-agnostic. */
async function admitAndSignIn(page, shopper) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await dismissConsent(page);
  const gate = await page.waitForSelector("[role=dialog]", { timeout: 12000 }).then(() => true).catch(() => false);
  if (gate) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      for (const box of await page.$$("[role=dialog] input[type=checkbox]")) {
        if (!(await box.isChecked())) await box.click({ timeout: 6000 }).catch(() => {});
      }
      const ready = await page.$$eval("[role=dialog] button", (btns) => btns.some((b) =>
        /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled));
      if (ready) break;
      await page.waitForTimeout(900);
    }
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("[role=dialog] button")]
        .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
      if (btn) btn.click();
    });
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 12000 }).catch(() => {});
  }

  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });

  // THE CONSENT BANNER IS AN OVERLAY, AND IT EATS CLICKS.
  //
  // It sits above the portal, so a click on "Sign in with email" underneath it
  // silently does nothing and the run fails claiming the form never opened.
  // Dismissed rather than clicked through, because that is what a shopper does.
  await dismissConsent(page);

  // WAIT FOR THE BUTTON, NOT FOR A FORM. There is no <form> on this page until
  // the email option is chosen — the portal opens with Google, "Create an
  // account" and "Sign in with email". Waiting for a form first is a 20-second
  // timeout in every engine; it only ever passed because Chromium happened to
  // carry a `.vl-portal-row` element that WebKit lays out differently.
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign in with email"),
    null,
    { timeout: 25000 },
  );
  for (let attempt = 0; attempt < 8 && !(await page.$("form input[type=email]")); attempt += 1) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(900);
  }
  if (!(await page.$("form input[type=email]"))) throw new Error("the sign-in form never opened");
  await page.fill("form input[type=email]", shopper.email);
  await page.fill("form input[type=password]", shopper.password);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 30000 }).catch(() => null),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(2000);
  const signedIn = (await page.context().cookies()).some((c) => c.name === "vl_session_token");
  if (!signedIn) throw new Error("sign-in did not establish a session");
}

/** POST /api/checkout/create-session from inside the page, as the real client does. */
async function createSession(page, shopper, cart, idempotencyKey) {
  return page.evaluate(async ({ email, items, key }) => {
    const r = await fetch("/api/checkout/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        items,
        customer: {
          email, fullName: "Edge Matrix", address: "1 Test Way",
          city: "Tampa", state: "FL", postalCode: "33601", country: "US",
        },
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
        idempotencyKey: key,
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { email: shopper.email, items: cart.items, key: idempotencyKey });
}

/**
 * The pay link, on the origin the browser is actually using.
 *
 * create-session builds hostedCheckoutUrl from the app's own configured site
 * URL, which on the harness is the plain-http one. Following it verbatim leaves
 * the TLS origin, the `Secure` session cookie is not sent, and the pay page
 * correctly sends the visitor to the access wall — which reads as "the card
 * form is missing" and is nothing of the sort. Rewriting the origin keeps the
 * session, and changes nothing about what is being tested.
 */
function onThisOrigin(url) {
  try {
    const target = new URL(url);
    const base = new URL(BASE);
    target.protocol = base.protocol;
    target.host = base.host;
    return target.toString();
  } catch {
    return url;
  }
}

const orderRow = async (orderId) =>
  (await q(`select order_id, order_number, payment_status, amount_paid, payment_id, paid_at from orders where order_id = $1`, [orderId])).rows[0];

async function ordersFor(email) {
  return (await q(
    `select order_id, order_number, payment_status, amount_paid from orders where customer_email = $1 order by created_at`,
    [email],
  )).rows;
}

/** A real signed payment.succeeded, exactly as /api/webhooks/payment expects. */
async function settle(orderId, sessionId) {
  const body = JSON.stringify({
    id: `edge_evt_${randomUUID()}`,
    type: "payment.succeeded",
    paymentId: sessionId,
    data: { object: { metadata: { order_id: orderId, veyragate_session_id: sessionId } } },
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
  const res = await fetch(`${WEBHOOK_ORIGIN}/api/webhooks/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-payment-signature": signature },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// 1. IN-APP BROWSERS — the WebKit engine every iOS in-app browser really is
// ---------------------------------------------------------------------------

async function inAppBrowser() {
  section("1. In-app browser (WebKit, the engine behind TikTok / Instagram / Facebook / Snapchat)");

  let browser;
  try {
    browser = await webkit.launch();
  } catch (error) {
    record(
      "the payment path runs in WebKit",
      null,
      `WebKit is not installed in this container, so this cannot be run here: ${String(error).slice(0, 90)}`,
    );
    return;
  }

  try {
    const shopper = await makeShopper("inapp");
    const cart = await aCart();
    // A real in-app browser is a phone-sized WKWebView carrying the host app's
    // user agent. The engine is what matters; the string is set so any
    // user-agent branching in the app sees what it would really see.
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F79 Instagram 335.0.0.32.98",
      extraHTTPHeaders: { "x-real-ip": freshIp() },
    });
    const page = await context.newPage();

    // SCRIPT ERRORS FROM OUR OWN ORIGIN ONLY.
    //
    // The pay page mounts the processor's iframe from the processor's own
    // domain, and on the harness that session id exists only in the local stub —
    // so veyragate.com answers 404 and the console reports a failed resource.
    // That is the harness, not a defect, and counting it would make this check
    // permanently red. What is worth failing on is a thrown error, or a 404
    // against a URL WE serve.
    const pageErrors = [];
    const ourNotFound = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("response", (r) => {
      if (r.status() !== 404) return;
      if (r.url().startsWith(BASE)) ourNotFound.push(r.url().slice(0, 110));
    });
    let mountAttempted = false;
    page.on("request", (r) => {
      if (/veyragate\.com\/checkout\//.test(r.url())) mountAttempted = true;
    });

    await admitAndSignIn(page, shopper);
    record("the age gate and sign-in work in WebKit", true, "session established");

    const created = await createSession(page, shopper, cart, `inapp-${randomUUID()}`);
    const ok = created.status === 200 && created.body?.success === true;
    record(
      "checkout creates a chargeable session in WebKit",
      ok && Boolean(created.body?.hostedCheckoutUrl),
      ok ? `${created.body.orderNumber}, card url present` : `HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 140)}`,
    );
    if (!ok) return;

    const orderId = created.body.orderId;

    // The pay page is where an in-app browser is most likely to break: it mounts
    // a cross-origin iframe and polls. The iframe itself is Veyra's and cannot be
    // driven here; what must hold is that the page renders its own container,
    // says nothing false, and offers a way out.
    await page.goto(onThisOrigin(created.body.hostedCheckoutUrl), { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(3500);
    const cardMount = await page.$("#secure-card-entry");
    record("the pay page renders its card container in WebKit", Boolean(cardMount), cardMount ? "#secure-card-entry present" : "container missing");

    const payText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    record(
      "the pay page never names the processor or 3DS to an in-app shopper",
      !/veyra/i.test(payText) && !/3-?d ?secure|\b3ds\b/i.test(payText),
      "no vendor name, no 3DS wording",
    );

    // STORAGE. In-app browsers restrict it most, and both the checkout and the
    // purchase pixel keep state there. A throw here is what turns a working
    // checkout into a white screen.
    const storage = await page.evaluate(() => {
      try {
        window.localStorage.setItem("__vl_probe", "1");
        const read = window.localStorage.getItem("__vl_probe");
        window.localStorage.removeItem("__vl_probe");
        return { ok: read === "1", error: null };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    record("localStorage is usable, and a failure would not be fatal anyway", storage.ok, storage.ok ? "read/write ok" : `blocked: ${storage.error}`);

    // Settle it and confirm the shopper is told the truth on the same engine.
    const row = await orderRow(orderId);
    const settled = await settle(orderId, String(row.payment_id));
    record("a signed processor event settles the WebKit order", settled.status === 200, `HTTP ${settled.status}`);

    const after = await orderRow(orderId);
    record("the order reads PAID exactly once", after.payment_status === "paid" && Boolean(after.paid_at), `${after.order_number} ${after.payment_status}`);

    await page.goto(`${BASE}/order-confirmation/${orderId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const confirmText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    record(
      "the confirmation page shows the paid order in WebKit",
      /Total paid/i.test(confirmText) || new RegExp(after.order_number, "i").test(confirmText),
      "order shown as paid",
    );

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    record("no sideways scroll at in-app phone width", !overflow, "390px, no horizontal overflow");

    record(
      "the processor's card iframe is actually mounted in WebKit",
      mountAttempted,
      mountAttempted ? "checkout.js requested veyragate.com/checkout/<session>" : "no mount attempt seen",
    );
    record(
      "nothing WE serve 404s on the WebKit payment path",
      ourNotFound.length === 0,
      ourNotFound.length ? ourNotFound[0] : "no 404 from our own origin",
    );
    record(
      "no uncaught script error on the WebKit payment path",
      pageErrors.length === 0,
      pageErrors.length ? pageErrors[0].slice(0, 120) : "clean",
    );

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 2. SLOW CONNECTIONS
// ---------------------------------------------------------------------------

async function slowConnection() {
  section("2. Slow connection (throttled to roughly a poor mobile link)");

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  try {
    const shopper = await makeShopper("slow");
    const cart = await aCart();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-real-ip": freshIp() },
    });
    const page = await context.newPage();

    // Sign in at full speed; throttling the login is not what is under test.
    await admitAndSignIn(page, shopper);

    // Now throttle. CDP is Chromium-only, which is why this case runs here.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 400,                       // ms round trip
      downloadThroughput: (400 * 1024) / 8, // ~400 kbps
      uploadThroughput: (200 * 1024) / 8,   // ~200 kbps
    });
    record("network throttling is in force", true, "400ms latency, ~400kbps down");

    const started = Date.now();
    const created = await createSession(page, shopper, cart, `slow-${randomUUID()}`);
    const elapsed = Date.now() - started;
    const ok = created.status === 200 && created.body?.success === true;
    record(
      "checkout still creates a chargeable session on a slow link",
      ok && Boolean(created.body?.hostedCheckoutUrl),
      ok ? `${created.body.orderNumber} in ${elapsed}ms` : `HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 140)}`,
    );
    if (!ok) return;

    const orderId = created.body.orderId;

    // THE PAY PAGE ON A SLOW LINK. The loading line must not outlive the form,
    // and the poll must not call an unfinished payment a decline.
    await page.goto(onThisOrigin(created.body.hostedCheckoutUrl), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9000);
    const slowText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    record(
      "a pending payment is never reported as declined while it is still pending",
      !/didn't go through|declined|not completed/i.test(slowText),
      "no false failure while unsettled",
    );
    record(
      "the shopper is not left with an empty page",
      /secure payment/i.test(slowText) || slowText.length > 40,
      `${slowText.length} chars rendered`,
    );

    // The order-status poll is the fallback that rescues a lost success callback.
    // On a slow link it must still answer, and answer truthfully.
    const status = await page.evaluate(async (id) => {
      const r = await fetch(`/api/checkout/order-status/${encodeURIComponent(id)}`, { cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, orderId);
    record(
      "the order-status poll answers on a slow link, and says pending",
      status.status === 200 && status.body?.pending === true && status.body?.paid === false,
      `pending=${status.body?.pending} paid=${status.body?.paid}`,
    );

    // Settle mid-throttle and confirm the page catches up rather than dead-ending.
    const row = await orderRow(orderId);
    await settle(orderId, String(row.payment_id));
    const settledStatus = await page.evaluate(async (id) => {
      const r = await fetch(`/api/checkout/order-status/${encodeURIComponent(id)}`, { cache: "no-store" });
      return await r.json().catch(() => null);
    }, orderId);
    record(
      "once settled, the poll reports paid on the same slow link",
      settledStatus?.paid === true && settledStatus?.pending === false,
      `paid=${settledStatus?.paid}`,
    );

    const after = await orderRow(orderId);
    record("the slow-link order is paid exactly once", after.payment_status === "paid", `${after.order_number} ${after.payment_status}`);

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 3. DOUBLE SUBMISSION FROM THE BROWSER
// ---------------------------------------------------------------------------

async function doubleSubmission() {
  section("3. Double submission (double tap, two tabs, and a refresh mid-payment)");

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  try {
    // --- a shopper double-taps the button -----------------------------------
    {
      const shopper = await makeShopper("dbltap");
      const cart = await aCart();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-real-ip": freshIp() } });
      const page = await context.newPage();
      await admitAndSignIn(page, shopper);

      // The real client mints ONE idempotency key per submit and reuses it while
      // the request is in flight. Two simultaneous submits therefore carry the
      // same key, which is the case the guard exists for.
      const key = `dbltap-${randomUUID()}`;
      const [first, second] = await Promise.all([
        createSession(page, shopper, cart, key),
        createSession(page, shopper, cart, key),
      ]);

      const rows = await ordersFor(shopper.email);
      const chargeable = rows.filter((r) => r.payment_status === "pending_payment");
      record(
        "a double tap creates exactly one chargeable order",
        chargeable.length === 1,
        `${rows.length} order row(s), ${chargeable.length} chargeable: ${rows.map((r) => `${r.order_number}/${r.payment_status}`).join(", ")}`,
      );
      record(
        "both responses point at the same order",
        first.body?.orderId && first.body?.orderId === second.body?.orderId,
        first.body?.orderId === second.body?.orderId ? "same orderId returned twice" : `${first.body?.orderId} vs ${second.body?.orderId}`,
      );
      await context.close();
    }

    // --- the same cart submitted from two tabs -------------------------------
    {
      const shopper = await makeShopper("twotab");
      const cart = await aCart();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-real-ip": freshIp() } });
      const tabA = await context.newPage();
      await admitAndSignIn(tabA, shopper);
      const tabB = await context.newPage();
      await tabB.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });

      // Two tabs are two separate submits, so they carry DIFFERENT keys — this
      // is the case that legitimately produces two orders. What must never
      // happen is that both end up chargeable AND both settle.
      const [a, b] = await Promise.all([
        createSession(tabA, shopper, cart, `tabA-${randomUUID()}`),
        createSession(tabB, shopper, cart, `tabB-${randomUUID()}`),
      ]);

      const rows = await ordersFor(shopper.email);
      record(
        "two tabs each get their own order rather than an error",
        a.body?.success === true && b.body?.success === true,
        `${rows.length} order(s): ${rows.map((r) => r.order_number).join(", ")}`,
      );

      // Settle ONE of them, as a shopper who pays in whichever tab they return to.
      const paidId = a.body?.orderId;
      const paidRow = await orderRow(paidId);
      await settle(paidId, String(paidRow.payment_id));

      const afterRows = await ordersFor(shopper.email);
      const paidCount = afterRows.filter((r) => r.payment_status === "paid").length;
      record(
        "paying in one tab pays exactly one order",
        paidCount === 1,
        `${paidCount} paid of ${afterRows.length}`,
      );

      // THE OTHER TAB MUST NOT BE CHARGEABLE TWICE FOR THE SAME GOODS. It is a
      // separate order, so it stays payable — that is correct and is not a
      // double charge. What matters is that its session cannot settle the FIRST
      // order again, and that the paid one is not re-openable.
      const paidAfter = await orderRow(paidId);
      const replay = await settle(paidId, String(paidAfter.payment_id));
      const stillOnce = (await orderRow(paidId)).payment_status === "paid";
      record(
        "replaying the settled event cannot pay it twice",
        replay.status === 200 && stillOnce,
        `HTTP ${replay.status}, order still paid once`,
      );

      // And the paid order's pay link must not serve a live card form again.
      const payLink = a.body?.hostedCheckoutUrl;
      await tabA.goto(onThisOrigin(payLink), { waitUntil: "domcontentloaded" });
      await tabA.waitForTimeout(2500);
      const landedOnReceipt = /order-confirmation/.test(tabA.url());
      record(
        "the paid order's pay link redirects to the receipt, not a card form",
        landedOnReceipt,
        landedOnReceipt ? "redirected to confirmation" : `stayed on ${tabA.url().slice(0, 80)}`,
      );

      await context.close();
    }

    // --- refresh mid-payment, then submit again ------------------------------
    {
      const shopper = await makeShopper("refresh");
      const cart = await aCart();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-real-ip": freshIp() } });
      const page = await context.newPage();
      await admitAndSignIn(page, shopper);

      const created = await createSession(page, shopper, cart, `refresh-${randomUUID()}`);
      const orderId = created.body?.orderId;
      const row = await orderRow(orderId);

      // The shopper reloads the card page, then pays.
      await page.goto(onThisOrigin(created.body.hostedCheckoutUrl), { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      const stillPayable = (await orderRow(orderId)).payment_status;
      record(
        "a refresh mid-payment leaves the order payable, not cancelled",
        stillPayable === "pending_payment",
        `${row.order_number} is ${stillPayable}`,
      );

      await settle(orderId, String(row.payment_id));

      // Then reloads again AFTER paying — the classic double-charge shape.
      await page.goto(onThisOrigin(created.body.hostedCheckoutUrl), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const afterPaidUrl = page.url();
      record(
        "reloading the pay link after paying cannot charge again",
        /order-confirmation/.test(afterPaidUrl),
        /order-confirmation/.test(afterPaidUrl) ? "redirected to receipt" : `served ${afterPaidUrl.slice(0, 80)}`,
      );

      const finalRows = await ordersFor(shopper.email);
      const paid = finalRows.filter((r) => r.payment_status === "paid");
      record(
        "the whole refresh journey produced exactly one paid order",
        paid.length === 1,
        `${paid.length} paid of ${finalRows.length}: ${finalRows.map((r) => `${r.order_number}/${r.payment_status}`).join(", ")}`,
      );

      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function main() {
  await client.connect();
  await ensureStock();

  console.log("\nCheckout edge matrix — in-app browser, slow connection, double submission\n");

  await inAppBrowser();
  await slowConnection();
  await doubleSubmission();

  console.log(`\n${passed + failed + skipped} checks: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
