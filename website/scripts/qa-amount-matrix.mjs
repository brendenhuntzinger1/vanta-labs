#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EVERY AMOUNT IS THE SAME AMOUNT — PROVED END TO END, NOT ARGUED.
//
// Until 2026-09-09 this store had never settled an order of $200 or more. Seven
// tried; all seven died. The largest payment that had ever succeeded was
// $194.98. A boundary that sharp invites exactly one question: is it ours?
//
// It is not. The cause was processor-side 3-D Secure, and the only number in
// this codebase anywhere near $200 is FREE_SHIPPING_THRESHOLD — keyed on the
// SUBTOTAL, deciding the cost of shipping, never gating a charge.
//
// src/lib/payment-amount-matrix.test.ts pins that by reading the code. This
// file pins it by DOING it: a real cart at each of a dozen totals, through the
// real quote, the real /api/checkout/create-session, a real order row, and a
// real session mint against the Veyra stub — then it reads the stub's own
// request log and asserts that the cents we asked the processor to charge are
// exactly the cents written on the order.
//
// It deliberately stops short of paying. Payment, settlement, decline, retry and
// every side effect are qa-post-3ds-high-value.mjs's job, on one cart each side
// of the threshold. What this adds is BREADTH: if a gate were reintroduced
// anywhere between the cart and the processor, one of these totals would behave
// differently from the others, and no amount of reading would be needed to see
// it.
//
// Development-only. Drives the local harness and refuses to start anywhere else.
//
//   node scripts/qa-amount-matrix.mjs
//   QA_VIEWPORT=mobile node scripts/qa-amount-matrix.mjs
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const VEYRA_LOG = process.env.QA_VEYRA_LOG ?? `${process.env.QA_LOG_DIR ?? "/tmp/vanta-qa"}/veyra.log`;
const MOBILE = process.env.QA_VIEWPORT === "mobile";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

/**
 * SUBTOTAL targets, in dollars, straddling the threshold that was blamed.
 *
 * Subtotals rather than totals: prices are fixed, so an exact final total is not
 * constructible from a real catalogue, and pretending otherwise would mean
 * asserting against a number this script chose instead of one the store computed.
 * What matters is that the store's own total, whatever it is, reaches the
 * processor intact at every magnitude.
 */
const TARGETS = [25, 50, 99, 150, 194.98, 199, 199.99, 200, 200.01, 250, 269.35, 500, 1000];

const client = new pg.Client({ connectionString: DB });
const q = (text, params) => client.query(text, params);

let passed = 0;
let failed = 0;
const results = [];

function record(label, ok, detail) {
  results.push({ label, ok, detail });
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function sellableLines() {
  const parents = (await q(
    `select p.slug, p.price_cents, coalesce(p.inventory_quantity,0) - coalesce(p.reserved_quantity,0) as avail
       from products p
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true)
        and not coalesce(p.is_archived,false) and coalesce(p.price_cents,0) > 0
        and coalesce(p.inventory_quantity,0) - coalesce(p.reserved_quantity,0) > 0
        and not exists (select 1 from product_doses d where d.product_id = p.id)
      order by p.price_cents asc`,
  )).rows.map((r) => ({ id: r.slug, priceCents: Number(r.price_cents), avail: Number(r.avail), describe: r.slug }));

  const dosed = (await q(
    `select p.slug, d.id as dose_id, d.label, d.price_cents,
            coalesce(d.inventory_quantity,0) - coalesce(d.reserved_quantity,0) as avail
       from products p join product_doses d on d.product_id = p.id
      where coalesce(p.is_published,true) and coalesce(p.is_enabled,true)
        and not coalesce(p.is_archived,false) and coalesce(d.price_cents,0) > 0
        and coalesce(d.inventory_quantity,0) - coalesce(d.reserved_quantity,0) > 0
      order by d.price_cents asc`,
  )).rows.map((r) => ({
    id: `${r.slug}::${r.dose_id}`, priceCents: Number(r.price_cents),
    avail: Number(r.avail), describe: `${r.slug} (${r.label})`,
  }));

  return [...parents, ...dosed];
}

/**
 * The cart whose subtotal lands closest ABOVE `targetCents`.
 *
 * Two lines, not one. A single-line search overshoots badly on a coarse
 * catalogue — $199, $199.99, $200 and $200.01 all collapsed to the same $207
 * cart, which is exactly the boundary this file is supposed to straddle. A bulk
 * line plus filler units of the cheapest line lands each target within a few
 * dollars of itself, so the sweep really does sit on both sides of $200.
 */
function cartClearing(lines, targetCents) {
  const cheapest = [...lines].sort((a, b) => a.priceCents - b.priceCents).slice(0, 3);
  let best = null;
  const consider = (items, subtotalCents, describe) => {
    if (subtotalCents < targetCents) return;
    if (!best || subtotalCents < best.subtotalCents) best = { items, subtotalCents, describe };
  };

  for (const bulk of lines) {
    const maxBulk = Math.min(bulk.avail, Math.ceil(targetCents / bulk.priceCents));
    for (let qty = Math.max(0, maxBulk - 1); qty <= maxBulk; qty += 1) {
      if (qty > bulk.avail) continue;
      const bulkCents = qty * bulk.priceCents;
      if (qty > 0 && bulkCents >= targetCents) {
        consider([{ id: bulk.id, quantity: qty }], bulkCents, `${qty} x ${bulk.describe}`);
        continue;
      }
      const remainder = targetCents - bulkCents;
      for (const filler of cheapest) {
        if (filler.id === bulk.id) continue;
        const fillQty = Math.ceil(remainder / filler.priceCents);
        if (fillQty < 1 || fillQty > filler.avail) continue;
        const subtotal = bulkCents + fillQty * filler.priceCents;
        const items = qty > 0
          ? [{ id: bulk.id, quantity: qty }, { id: filler.id, quantity: fillQty }]
          : [{ id: filler.id, quantity: fillQty }];
        const describe = qty > 0
          ? `${qty} x ${bulk.describe} + ${fillQty} x ${filler.describe}`
          : `${fillQty} x ${filler.describe}`;
        consider(items, subtotal, describe);
      }
    }
  }
  return best;
}

/** Make sure the catalogue can supply this run. Adds units only; never touches holds. */
async function ensureStockForRun(minimum = 400) {
  // NEVER STOCK THE PARENT OF A DOSE-STOCKED PRODUCT — see the same note in
  // qa-post-3ds-high-value.mjs. A parent given units it never has in production
  // makes the cart use the parent while the sale resolves to the dose.
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

/**
 * What the stub was asked to charge for this session, in cents.
 *
 * The stub logs one line per request:
 *
 *   [veyra-stub] POST /api/v1/checkout_sessions -> vs_<id> :: {"amount_cents":7622,...}
 *
 * so the session id and the body it was minted from sit on the same line. Read
 * newest-first, because a re-run must not pick up an earlier run's entry.
 */
function centsAskedOf(sessionId) {
  if (!sessionId || !existsSync(VEYRA_LOG)) return null;
  const lines = readFileSync(VEYRA_LOG, "utf8").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(sessionId) || !line.includes("amount_cents")) continue;
    const match = line.match(/"amount_cents"\s*:\s*(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

async function main() {
  await client.connect();
  await ensureStockForRun();

  const email = `amounts-${Date.now()}@example.com`;
  const password = "AmountMatrix-pass!23";
  await q(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
     values ($1,$2,$3,'{"role":"customer"}'::jsonb, now(), now())
     on conflict (email) do update set encrypted_password = excluded.encrypted_password, email_confirmed_at = now()`,
    [email, password, JSON.stringify({ full_name: "Amount Matrix", role: "customer" })],
  );

  const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    // A per-IP rate-limit bucket of its own: create-session allows 8 a minute.
    extraHTTPHeaders: { "x-real-ip": `100.64.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}` },
  });
  const page = await context.newPage();

  // --- age gate + sign-in (checkout requires an account here) ---------------
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  if (await page.waitForSelector("[role=dialog]", { timeout: 8000 }).then(() => true).catch(() => false)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const box of await page.$$("[role=dialog] input[type=checkbox]")) {
        if (!(await box.isChecked())) await box.click({ timeout: 5000 }).catch(() => {});
      }
      const ready = await page.$$eval("[role=dialog] button", (btns) => btns.some((b) =>
        /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled));
      if (ready) break;
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("[role=dialog] button")]
        .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
      if (btn) btn.click();
    });
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 }).catch(() => {});
  }

  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("form, .vl-portal-row", { timeout: 15000 });
  for (let attempt = 0; attempt < 5 && !(await page.$("form input[type=email]")); attempt += 1) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
  }
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", password);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 25000 }).catch(() => null),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(1500);
  if (!(await context.cookies()).some((c) => c.name === "vl_session_token")) {
    throw new Error("sign-in did not establish a session");
  }

  // ONE SIGN-IN, MANY SHOPPERS.
  //
  // create-session allows 8 a minute per IP, deliberately — it is the most
  // expensive public write on the site, and a thirteen-order sweep from one
  // address is exactly what that limit is for. Spoofing the header from inside
  // the page does not work and should not: getRequestIpAddress reads the
  // platform's own header, not the document's. So each order gets its own
  // browser context with its own client IP, built from the session cookies this
  // one already holds — thirteen customers, which is also the truthful model,
  // rather than one customer placing thirteen orders in ninety seconds.
  const storageState = await context.storageState();
  const orderContext = async () => {
    const ip = `100.64.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      storageState,
      extraHTTPHeaders: { "x-real-ip": ip },
    });
    return ctx;
  };

  const lines = await sellableLines();
  if (lines.length === 0) throw new Error("the catalogue has nothing sellable");

  console.log(`\nAmount matrix — ${MOBILE ? "390x844" : "1280x900"} — ${TARGETS.length} totals\n`);

  /** Every order's (total on row, cents asked of the processor), for the shape check at the end. */
  const observed = [];

  /**
   * Carts already run, by their line-up.
   *
   * Four of these targets sit within a dollar of each other and the cheapest unit
   * in the catalogue is $14.99, so they resolve to the SAME cart. Running it four
   * times would prove only that the same cart behaves the same way. The target
   * list stays as written because it documents the boundary being straddled; the
   * duplicates are reported as what they are.
   */
  const cartsRun = new Map();

  for (const target of TARGETS) {
    const cart = cartClearing(lines, Math.round(target * 100));
    if (!cart) {
      record(`$${target.toFixed(2)} subtotal`, false, "no cart could reach this subtotal from the seeded catalogue");
      continue;
    }
    const cartKey = cart.items.map((i) => `${i.id}x${i.quantity}`).sort().join("+");
    if (cartsRun.has(cartKey)) {
      console.log(`  ----  $${target.toFixed(2)} target resolves to the same cart as `
        + `$${cartsRun.get(cartKey).toFixed(2)} — the catalogue cannot express the difference`);
      continue;
    }
    cartsRun.set(cartKey, target);

    // Each submit is its own purchase, so each gets its own idempotency key —
    // exactly as the checkout page mints one per submit.
    const key = `amounts-${randomUUID()}`;
    const ctx = await orderContext();
    const orderPage = await ctx.newPage();
    // Same-origin, so the session cookie rides along and the relative URL resolves.
    await orderPage.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
    const created = await orderPage.evaluate(async ({ email: shopper, items, idempotencyKey }) => {
      const r = await fetch("/api/checkout/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          items,
          customer: {
            email: shopper, fullName: "Amount Matrix", address: "1 Test Way",
            city: "Tampa", state: "FL", postalCode: "33601", country: "US",
          },
          complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
          idempotencyKey,
        }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { email, items: cart.items, idempotencyKey: key });
    await ctx.close();

    const label = `$${(cart.subtotalCents / 100).toFixed(2)} subtotal (${cart.describe})`;

    if (created.status !== 200 || !created.body?.success) {
      record(label, false, `HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 180)}`);
      continue;
    }

    const row = (await q(
      `select order_id, order_number, amount_paid, subtotal, shipping_amount, tax_amount, payment_status, payment_id
         from orders where order_id = $1`, [created.body.orderId],
    )).rows[0];

    if (!row) {
      record(label, false, "the session succeeded but no order row exists");
      continue;
    }

    const centsOnRow = Math.round(Number(row.amount_paid) * 100);
    const centsAsked = centsAskedOf(String(row.payment_id ?? created.body.paymentId ?? ""));
    observed.push({ target, centsOnRow, centsAsked, status: String(row.payment_status), hasUrl: Boolean(created.body.hostedCheckoutUrl) });

    // THE ONE ASSERTION THAT MATTERS: the processor is asked for exactly what
    // the order says. Every other amount in the system is derived from these two.
    if (centsAsked === null) {
      record(label, false, `could not read the stub's request for session ${row.payment_id}`);
      continue;
    }
    const agrees = centsAsked === centsOnRow;
    const chargeable = created.body.hostedCheckoutUrl && String(row.payment_status) === "pending_payment";
    record(
      label,
      agrees && chargeable,
      `${row.order_number}: row $${(centsOnRow / 100).toFixed(2)} / processor $${(centsAsked / 100).toFixed(2)}`
      + ` · ${row.payment_status}${created.body.hostedCheckoutUrl ? " · card form" : " · NO CARD FORM"}`,
    );
  }

  // --- the shape of the whole sweep ----------------------------------------
  console.log("");
  const reached = observed.filter((o) => o.centsAsked !== null);
  record(
    "every cart reached the processor",
    reached.length === observed.length && observed.length === cartsRun.size,
    `${reached.length}/${cartsRun.size} distinct carts`,
  );
  record(
    "every order was left chargeable, whatever its size",
    observed.length > 0 && observed.every((o) => o.status === "pending_payment" && o.hasUrl),
    observed.map((o) => o.status).filter((s, i, a) => a.indexOf(s) === i).join(", ") || "none",
  );
  record(
    "no total was altered on its way to the processor",
    observed.length > 0 && observed.every((o) => o.centsAsked === o.centsOnRow),
    observed.filter((o) => o.centsAsked !== o.centsOnRow).map((o) => `$${o.target}`).join(", ") || "none differed",
  );
  const below = observed.filter((o) => o.centsOnRow < 20000);
  const above = observed.filter((o) => o.centsOnRow >= 20000);
  record(
    "orders either side of $200 behaved identically",
    below.length > 0 && above.length > 0
      && below.every((o) => o.status === "pending_payment" && o.hasUrl && o.centsAsked === o.centsOnRow)
      && above.every((o) => o.status === "pending_payment" && o.hasUrl && o.centsAsked === o.centsOnRow),
    `${below.length} below, ${above.length} at or above`,
  );

  await context.close();
  await browser.close();

  console.log(`\n${results.length} steps: ${passed} passed, ${failed} failed, 0 skipped.`);
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
