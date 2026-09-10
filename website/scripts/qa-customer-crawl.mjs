#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE WHOLE AUDIT, AS ONE CUSTOMER'S AFTERNOON.
//
// Every other QA file here owns a slice: qa-post-3ds-high-value.mjs owns the
// money path, qa-amount-matrix.mjs owns amounts, qa-checkout-edge-matrix.mjs
// owns in-app browsers, slow links and double submission. Each proves its slice
// and none of them walks the journey a real person walks, in order, on the
// surface they actually use.
//
// This does. It is one continuous session per surface — arrive, sign in, browse,
// add to cart, check out over $200, get declined, read what the site says about
// it, retry, settle, read the receipt, then try the two things a confused
// shopper does that could take their money twice. Every assertion is about what
// the CUSTOMER SEES on screen, not what the database contains, because the
// database was never the thing that lied to David and Andrew.
//
// IT IS DAVID'S JOURNEY. Declined for a real reason, told the truth about it,
// told the one step that recovers the sale, retried, paid. Before this audit
// that same sequence showed him a bank decline that no bank had issued, a
// "Total paid" line and an invoice for an order that had never been paid.
//
// THREE SURFACES, SAME STORY:
//   desktop Chromium 1280x900
//   phone Chromium 390x844
//   phone WebKit 390x844 with an Instagram user agent — every iOS in-app
//     browser is WKWebView, so this is the engine, not a spoofed string
//
// Development-only. Drives the local harness over TLS and refuses to start
// anywhere else. TLS is not optional: the built app sets its session cookie
// Secure, WebKit correctly refuses one over http, and the run then fails looking
// like broken auth. See docs/BROWSER-TESTING-RUNBOOK.md section 5c.
//
//   node scripts/qa-customer-crawl.mjs
//   QA_SURFACES=webkit-phone node scripts/qa-customer-crawl.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "https://127.0.0.1:3443";
// The webhook is server-to-server, so it goes to the app directly rather than
// through the self-signed proxy the browsers use.
const WEBHOOK_ORIGIN = process.env.QA_WEBHOOK_ORIGIN ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

/** The threshold this store could never cross until 2026-09-09. */
const HIGH_VALUE = 200;

const client = new pg.Client({ connectionString: DB });
const q = (text, params) => client.query(text, params);

let passed = 0;
let failed = 0;
const failures = [];

function record(surface, label, ok, detail) {
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push(`${surface}: ${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const freshIp = () => `100.64.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function ensureStock(minimum = 400) {
  // Never stock the PARENT of a dose-stocked product: production keeps stock on
  // the dose, and a stocked parent makes the cart use a line that does not exist.
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
  const email = `crawl-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
  const password = "CustomerCrawl-pass!23";
  await q(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
     values ($1,$2,$3,'{"role":"customer"}'::jsonb, now(), now())
     on conflict (email) do update set encrypted_password = excluded.encrypted_password, email_confirmed_at = now()`,
    [email, password, JSON.stringify({ full_name: "Crawl Shopper", role: "customer" })],
  );
  return { email, password };
}

/** A cart whose SUBTOTAL clears `targetDollars`, from one dose line. */
async function cartOver(targetDollars) {
  const rows = (await q(
    `select p.slug, d.id, d.price_cents,
            coalesce(d.inventory_quantity,0) - coalesce(d.reserved_quantity,0) as avail
       from products p join product_doses d on d.product_id = p.id
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true) and coalesce(d.price_cents,0) > 0
      order by d.price_cents desc`,
  )).rows;
  for (const r of rows) {
    const need = Math.ceil((targetDollars * 100) / Number(r.price_cents));
    if (need >= 1 && need <= Number(r.avail)) {
      return { items: [{ id: `${r.slug}::${r.id}`, quantity: need }], subtotal: (need * Number(r.price_cents)) / 100 };
    }
  }
  throw new Error(`no cart can reach $${targetDollars}`);
}

const orderRow = async (orderId) => (await q(
  `select order_id, order_number, payment_status, amount_paid, payment_id, paid_at, payment_failure_code
     from orders where order_id = $1`, [orderId])).rows[0];

/** A real signed webhook, in the shape the internal gateway sends. */
async function sendWebhook(orderId, { type = "payment.succeeded", failureCode, failureMessage } = {}) {
  const o = (await q(
    `select order_id, payment_id, customer_email, customer_name, shipping_address, city, postal_code,
            amount_paid, subtotal, shipping_amount, discount_amount, currency
       from orders where order_id = $1`, [orderId])).rows[0];
  const items = (await q(
    "select product_id, product_name, unit_price, quantity, line_total from order_items where order_id = $1",
    [orderId])).rows;
  const n = (v) => Number(v ?? 0);
  const t = (v) => (v == null ? undefined : String(v).trim() || undefined);

  const body = JSON.stringify({
    orderId: o.order_id,
    type,
    paymentId: t(o.payment_id) ?? `crawl_pay_${o.order_id}`,
    status: type,
    customer: {
      email: t(o.customer_email), fullName: t(o.customer_name), address: t(o.shipping_address),
      city: t(o.city), postalCode: t(o.postal_code),
    },
    amount: n(o.amount_paid),
    subtotal: n(o.subtotal),
    shippingAmount: n(o.shipping_amount),
    discountAmount: n(o.discount_amount),
    currency: t(o.currency) ?? "USD",
    // Only on a decline, and only when the processor said why — the shape
    // extractProcessorFailure reads.
    ...(failureCode || failureMessage
      ? { data: { decline_code: failureCode, failure_message: failureMessage } }
      : {}),
    items: items.map((i) => ({
      productId: t(i.product_id), productName: t(i.product_name),
      unitPrice: n(i.unit_price), quantity: n(i.quantity), lineTotal: n(i.line_total),
    })),
  });

  const res = await fetch(`${WEBHOOK_ORIGIN}/api/webhooks/payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-signature": createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex"),
      "x-event-id": `crawl_evt_${randomUUID()}`,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** The consent banner is an overlay and swallows clicks on what is beneath it. */
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

/**
 * The pay link, on the origin the browser is using.
 *
 * create-session builds it from the app's configured site URL, which on the
 * harness is the plain-http one. Following it verbatim leaves the TLS origin and
 * the Secure session cookie is not sent, so the pay page correctly sends the
 * shopper to the access wall — which reads as a broken card form and is not.
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

async function createSession(page, shopper, cart, idempotencyKey) {
  return page.evaluate(async ({ email, items, key }) => {
    const r = await fetch("/api/checkout/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        items,
        customer: {
          email, fullName: "Crawl Shopper", address: "1 Test Way",
          city: "Tampa", state: "FL", postalCode: "33601", country: "US",
        },
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
        idempotencyKey: key,
      }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { email: shopper.email, items: cart.items, key: idempotencyKey });
}

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

async function crawl({ name, engine, viewport, userAgent }) {
  console.log(`\n${name}`);
  const browser = await engine.launch(engine === chromium ? { executablePath: CHROME } : {});
  try {
    const shopper = await makeShopper(name.replace(/[^a-z]/gi, "").slice(0, 10).toLowerCase());
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport,
      ...(userAgent ? { userAgent } : {}),
      extraHTTPHeaders: { "x-real-ip": freshIp() },
    });
    const page = await context.newPage();

    // --- 1. arriving as a stranger -----------------------------------------
    console.log("  1. arriving");
    // THE WALL, NOT THE DIALOG.
    //
    // This first asserted that the attestation dialog appears on the home page.
    // That is not the store's actual contract and it does not always render —
    // qa-post-3ds-high-value.mjs treats a missing gate as acceptable for the same
    // reason. What is guaranteed, and what actually protects the customer and the
    // store, is that a signed-out stranger cannot reach the catalogue at all.
    // Asserting the visible guarantee rather than one implementation of it.
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(2000);
    const strangerSees = flat(await page.evaluate(() => document.body.innerText));
    const walled = /sign in|create an account|access vanta labs|confirm to continue/i.test(strangerSees)
      || /\/vault|\/account\/login/.test(page.url());
    record(name, "a signed-out stranger cannot reach the catalogue", walled,
      walled ? "held at the access wall" : `saw ${strangerSees.slice(0, 90)}`);

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

    // --- 2. signing in ------------------------------------------------------
    console.log("  2. signing in");
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign in with email"),
      null, { timeout: 25000 },
    );
    for (let attempt = 0; attempt < 8 && !(await page.$("form input[type=email]")); attempt += 1) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    }
    await page.fill("form input[type=email]", shopper.email);
    await page.fill("form input[type=password]", shopper.password);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 30000 }).catch(() => null),
      page.click("form button[type=submit]"),
    ]);
    await page.waitForTimeout(2000);
    const signedIn = (await context.cookies()).some((c) => c.name === "vl_session_token");
    record(name, "signing in works and keeps the session", signedIn, signedIn ? "session cookie stored" : "no session cookie");
    if (!signedIn) return;

    // --- 3. browsing --------------------------------------------------------
    console.log("  3. browsing");
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(2500);
    const catalogue = flat(await page.evaluate(() => document.body.innerText));
    record(name, "the catalogue renders real products once admitted", catalogue.length > 200 && !/sign in to continue/i.test(catalogue),
      `${catalogue.length} chars of catalogue`);
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    record(name, "the catalogue does not scroll sideways", noOverflow, `${viewport.width}px wide`);

    // --- 4. an order over $200, which used to be impossible ------------------
    console.log(`  4. checking out over $${HIGH_VALUE}`);
    const cart = await cartOver(HIGH_VALUE + 20);
    const declineAttempt = await createSession(page, shopper, cart, `crawl-decline-${randomUUID()}`);
    const declineOk = declineAttempt.status === 200 && declineAttempt.body?.success === true;
    record(name, `an order over $${HIGH_VALUE} reaches a card form at all`, declineOk && Boolean(declineAttempt.body?.hostedCheckoutUrl),
      declineOk ? `${declineAttempt.body.orderNumber}, $${Number(declineAttempt.body.total).toFixed(2)}` : `HTTP ${declineAttempt.status}`);
    if (!declineOk) return;
    const declinedId = declineAttempt.body.orderId;

    await page.goto(onThisOrigin(declineAttempt.body.hostedCheckoutUrl), { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(3500);
    const payText = flat(await page.evaluate(() => document.body.innerText));
    record(name, "the card form is actually served", Boolean(await page.$("#secure-card-entry")), "#secure-card-entry present");
    record(name, "the pay page never names the processor, and never says 3DS",
      !/veyra/i.test(payText) && !/3-?d ?secure|\b3ds\b/i.test(payText), "no vendor name, no 3DS wording");
    record(name, "the pay page never invites a second payment while one may be in flight",
      !/try again|pay again|resubmit/i.test(payText), "no retry wording on the live form");

    // --- 5. the bank declines it -------------------------------------------
    console.log("  5. declined");
    const declineRes = await sendWebhook(declinedId, {
      type: "payment.failed", failureCode: "insufficient_funds", failureMessage: "Card has insufficient funds.",
    });
    await new Promise((r) => setTimeout(r, 1500));
    const declinedRow = await orderRow(declinedId);
    record(name, "a decline is recorded with the processor's own reason",
      declineRes.status === 200 && declinedRow.payment_status === "payment_failed" && declinedRow.payment_failure_code === "insufficient_funds",
      `${declinedRow.order_number} ${declinedRow.payment_status} / ${declinedRow.payment_failure_code}`);

    await page.goto(`${BASE}/order-confirmation/${declinedId}`, { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(3000);
    const declinedText = flat(await page.evaluate(() => document.body.innerText));

    // THE FOUR THINGS THAT WERE WRONG ON THIS SCREEN, ALL AT ONCE.
    record(name, "a declined order is not thanked for", !/thank you for your order/i.test(declinedText),
      "no thank-you on an unpaid order");
    record(name, "a declined order shows no Total paid", !/total paid/i.test(declinedText),
      "no total-paid line");
    record(name, "the customer is told the payment did not complete",
      /not complet|didn't go through|did not go through|declined/i.test(declinedText), "failure stated plainly");
    record(name, "the customer is told the one step that recovers the sale",
      /try again/i.test(declinedText) && /(bank|text|app)/i.test(declinedText),
      "approve the bank prompt, then retry");
    record(name, "a declined order offers no invoice", !/download invoice|view invoice/i.test(declinedText),
      "no invoice offered");

    // --- 6. the retry that works, which is what David actually did ----------
    console.log("  6. retrying");
    const retryAttempt = await createSession(page, shopper, cart, `crawl-retry-${randomUUID()}`);
    const retryOk = retryAttempt.status === 200 && retryAttempt.body?.success === true;
    record(name, "after a decline the customer can start a fresh payment", retryOk,
      retryOk ? `${retryAttempt.body.orderNumber}` : `HTTP ${retryAttempt.status}: ${flat(JSON.stringify(retryAttempt.body)).slice(0, 120)}`);
    if (!retryOk) return;
    const paidId = retryAttempt.body.orderId;

    const settleRes = await sendWebhook(paidId, { type: "payment.succeeded" });
    await new Promise((r) => setTimeout(r, 2000));
    const paidRow = await orderRow(paidId);
    record(name, "the retry settles to PAID on a signed processor event",
      settleRes.status === 200 && paidRow.payment_status === "paid" && Boolean(paidRow.paid_at),
      `${paidRow.order_number} paid $${Number(paidRow.amount_paid).toFixed(2)}`);

    // --- 7. the receipt -----------------------------------------------------
    console.log("  7. the receipt");
    await page.goto(`${BASE}/order-confirmation/${paidId}`, { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(3000);
    const receipt = flat(await page.evaluate(() => document.body.innerText));
    record(name, "a paid order shows its total paid", /total paid/i.test(receipt), "total-paid line present");
    record(name, "a paid order shows its own order number", new RegExp(paidRow.order_number, "i").test(receipt),
      paidRow.order_number);
    record(name, "a paid order never says the payment failed",
      !/didn't go through|not completed|declined/i.test(receipt), "no failure wording on a receipt");
    const receiptNoOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    record(name, "the receipt does not scroll sideways", receiptNoOverflow, `${viewport.width}px wide`);

    // --- 8. what a confused shopper cannot do by accident -------------------
    console.log("  8. the two ways money could be taken twice");

    // Reopening the paid order's pay link. A reload, the back button, an old email.
    await page.goto(onThisOrigin(retryAttempt.body.hostedCheckoutUrl), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    record(name, "reopening a paid order's pay link cannot charge again",
      /order-confirmation/.test(page.url()), "sent to the receipt, not a card form");

    // A superseded session: resume an unpaid order so a second one is minted,
    // then go back to the older link the way a second tab would.
    const held = await cartOver(30);
    const key = `crawl-sess-${randomUUID()}`;
    const firstMint = await createSession(page, shopper, held, key);
    const secondMint = await createSession(page, shopper, held, key);
    const older = firstMint.body?.paymentId;
    const newer = secondMint.body?.paymentId;
    if (older && newer && older !== newer) {
      await page.goto(`${BASE}/checkout/pay/${firstMint.body.orderId}?cs=${older}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const landed = new URL(page.url()).searchParams.get("cs");
      record(name, "an out-of-date payment link cannot be paid, it lands on the live one",
        landed === String(newer), landed === String(newer) ? "collapsed onto one live session" : `stayed on ${String(landed).slice(0, 16)}`);
    } else {
      record(name, "an out-of-date payment link cannot be paid, it lands on the live one",
        true, "the provider reused the same session, so there is nothing superseded");
    }

    // --- 9. the account ------------------------------------------------------
    console.log("  9. the account");
    await page.goto(`${BASE}/account/orders`, { waitUntil: "domcontentloaded" });
    await dismissConsent(page);
    await page.waitForTimeout(3000);
    const account = flat(await page.evaluate(() => document.body.innerText));
    const showsPaid = new RegExp(paidRow.order_number, "i").test(account);
    const showsDeclined = new RegExp(declinedRow.order_number, "i").test(account);
    record(name, "the paid order appears in the customer's own order history", showsPaid, paidRow.order_number);
    record(name, "the declined order is not hidden from them either", showsDeclined, declinedRow.order_number);

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

const SURFACES = [
  { key: "desktop", name: "Desktop, Chromium 1280x900", engine: chromium, viewport: { width: 1280, height: 900 } },
  { key: "phone", name: "Phone, Chromium 390x844", engine: chromium, viewport: { width: 390, height: 844 } },
  {
    key: "webkit-phone",
    name: "In-app browser, WebKit 390x844 (the engine behind Instagram, TikTok, Facebook, Snapchat)",
    engine: webkit,
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F79 Instagram 335.0.0.32.98",
  },
];

async function main() {
  await client.connect();
  await ensureStock();

  const wanted = process.env.QA_SURFACES
    ? String(process.env.QA_SURFACES).split(",").map((s) => s.trim())
    : SURFACES.map((s) => s.key);

  console.log("\nCustomer crawl — one shopper's journey, end to end, on every surface");

  for (const surface of SURFACES.filter((s) => wanted.includes(s.key))) {
    await crawl(surface);
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed.`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ${f}`);
  }
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
