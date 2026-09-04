#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE WHOLE JOURNEY, ON TWO ENGINES, READING THE ACTUAL DOLLARS ON SCREEN.
//
// The gift was priced correctly and displayed incorrectly: a shopper who
// clicked "CLAIM YOUR FREE GHK-CU" reached a checkout showing $15.00 shipping,
// no free vial, and a total $24 higher than the card would be charged. Every
// number came out right at the till and none of them came out right on the
// screen, which is the half the shopper uses to decide.
//
// So this suite asserts on RENDERED TEXT and then on the ORDER ROW, and fails
// unless they agree. Reading a label ("Free shipping applied") would have
// passed against the broken build; reading "$0.00" next to Shipping would not.
//
// email → CTA → /products → offer armed → add to cart → drawer → checkout →
//   order, run once per browser engine.
//
// Local harness only.
//   node scripts/qa-offer-checkout-journey.mjs
//   QA_ENGINES=chromium node scripts/qa-offer-checkout-journey.mjs
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium, webkit } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/vanta-qa/journey";
const ENGINES = (process.env.QA_ENGINES ?? "chromium,webkit").split(",").map((e) => e.trim()).filter(Boolean);

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);
const hash = (token) => createHash("sha256").update(token).digest("hex");

const results = [];
let engine_ = "";
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n  ${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ engine: engine_, section: section_, name, status: "pass", detail });
    console.log(`    PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    return detail;
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 260);
    results.push({ engine: engine_, section: section_, name, status: "fail", detail: message });
    console.log(`    FAIL  ${name}\n          ${message}`);
    return null;
  }
}

// Prices in the harness catalogue: $69 clears the $60 GHK-Cu minimum, $59 does
// not, and $79 is the third product used for the bulk-tier and threshold cases.
const BIG = { slug: "bpc-157-10mg", price: 69 };
const SMALL = { slug: "ipamorelin-5mg", price: 59 };
const THIRD = { slug: "cjc-1295-2mg", price: 79 };

let ipCounter = 0;
const money = (text) => {
  const m = /-?\$\s?([\d,]+\.\d{2})/.exec(String(text ?? ""));
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
};

/** Mint a token the way the sweep does. The sweep itself is proved end to end
 *  in qa-gift-wiring.mjs; this suite is about what the shopper then SEES. */
async function issue(email, kind, { minCents = 6000, percent = null, hours = 48 } = {}) {
  const token = randomBytes(32).toString("base64url");
  const [offerKey, rewardKind, slug] = kind === "ghk"
    ? ["winback_60_free_ghkcu", "free_product", "ghk-cu"]
    : ["winback_60_free_shipping_15", "free_shipping_percent", null];
  await q(
    `insert into customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(hours => $8))`,
    [offerKey, hash(token), email.toLowerCase(), rewardKind, slug, percent, minCents, hours],
  );
  return token;
}

async function clearRateLimit() { await q("delete from rate_limit_hits").catch(() => {}); }

/** A shopper who has clicked the emailed link: their browser holds the cookie
 *  the click route set, and nothing else. */
async function armedContext(browser, token, viewport) {
  ipCounter += 1;
  const context = await browser.newContext({
    ...(viewport ? { viewport } : {}),
    extraHTTPHeaders: { "x-real-ip": `198.51.100.${100 + (ipCounter % 140)}` },
  });
  if (token) {
    await context.addCookies([{
      name: "vl_offer", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
    }]);
  }
  return context;
}

async function passAgeGate(page) {
  const guest = page.getByRole("button", { name: /continue as guest/i });
  if (!(await guest.count())) return;
  for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
    if (!(await box.isChecked())) await box.check();
  }
  await guest.click();
  await page.waitForTimeout(1000);
}

/** Walk the storefront and put things in the basket, as a shopper does. */
async function addToCart(page, products) {
  for (const [index, product] of products.entries()) {
    await page.goto(`${BASE}/products/${product.slug}`, { waitUntil: "domcontentloaded" });
    if (index === 0) await passAgeGate(page);
    await page.getByRole("button", { name: /add to cart/i }).first().click();
    await page.waitForTimeout(700);
  }
}

async function openDrawer(page) {
  const opener = page.getByRole("button", { name: /open cart/i });
  if (await opener.count()) await opener.click();
  await page.locator('[data-testid="cart-total"]').waitFor({ timeout: 15_000 });
  // The drawer's figures arrive from /api/checkout/quote, debounced.
  await page.waitForTimeout(1600);
}

/** Every money row the drawer renders, as numbers. */
async function readDrawer(page) {
  const text = async (testid) => {
    const el = page.locator(`[data-testid="${testid}"]`);
    return (await el.count()) ? (await el.first().innerText()).trim() : null;
  };
  const gifts = await page.locator('[data-testid="offer-gift-line"]').allInnerTexts();
  return {
    shipping: await text("cart-shipping"),
    discount: await text("cart-discount"),
    total: money(await text("cart-total")),
    gifts: gifts.map((g) => g.replace(/\s+/g, " ").trim()),
  };
}

/** Fill the checkout form the way a customer does, and read the rendered rows. */
const ANY_TOTAL = '[data-testid="summary-total"]:visible, [data-testid="summary-total-mobile"]:visible, [data-testid="summary-total-sticky"]:visible';

async function gotoCheckout(page, { email, state = "CA" } = {}) {
  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
  await page.locator(ANY_TOTAL).first().waitFor({ timeout: 20_000 });
  if (email !== undefined) await fillCheckoutForm(page, { email, state });
  await page.waitForTimeout(1800);
}

async function fillCheckoutForm(page, { email, state = "CA" }) {
  const set = async (label, value) => {
    const field = page.getByLabel(label, { exact: true });
    if (await field.count()) await field.first().fill(value);
  };
  await set("Email", email);
  await set("Phone", "5555555555");
  await set("Full name", "Journey Tester");
  await set("Address", "1 Harness Way");
  await set("City", "Testville");
  // "ZIP code" — the exact label. Getting this wrong silently leaves the field
  // empty, checkout refuses on validation, and the failure surfaces much later
  // as "no create-session request", which looks like a broken button.
  await set("ZIP code", "90000");
  const stateSelect = page.getByLabel("State", { exact: true });
  if (await stateSelect.count()) await stateSelect.first().selectOption(state).catch(() => {});
  // Let the debounced preview settle on the address just entered.
  await page.waitForTimeout(1800);
}

async function readCheckout(page) {
  // ":visible" throughout, deliberately. Both summaries are in the DOM at all
  // times; only the one for this viewport is shown, and a test that reads both
  // counts every gift twice and reads the phone's total on a desktop.
  const text = async (testid) => {
    const el = page.locator(`[data-testid="${testid}"]:visible`);
    return (await el.count()) ? (await el.first().innerText()).trim() : null;
  };
  const gifts = await page.locator('[data-testid="checkout-gift-line"]:visible').allInnerTexts();
  const banner = page.locator('[data-testid="checkout-offer-banner"]:visible');
  const total = page.locator(ANY_TOTAL);
  return {
    subtotal: money(await text("summary-subtotal")),
    shipping: await text("summary-shipping"),
    discount: await text("summary-discount"),
    tax: await text("summary-tax"),
    total: money((await total.count()) ? await total.first().innerText() : null),
    gifts: gifts.map((g) => g.replace(/\s+/g, " ").trim()),
    banner: (await banner.count()) ? (await banner.first().innerText()).replace(/\s+/g, " ").trim() : null,
  };
}

/** Place the order through the real form, and return the order row. */
async function placeOrder(page) {
  await clearRateLimit();
  // TICK NOTHING. The compliance boxes are checked by default on this form, and
  // the only unchecked box on the page is shipping protection — an ADD-ON that
  // costs money. An earlier version of this helper checked every unticked box
  // it found, which quietly added $2.76 to the charge after the screen had
  // already been read, and would have reported the resulting mismatch as a bug
  // in the feature rather than in the test.
  const compliance = page.locator('input[type="checkbox"]:visible');
  for (const box of await compliance.all()) {
    const label = await box.evaluate((el) => el.closest("label")?.innerText ?? "");
    if (!/research|compliance|return/i.test(label)) continue;
    if (!(await box.isChecked())) await box.check().catch(() => {});
  }
  // TAKE THE ORDER ID FROM WHERE THE SHOPPER ENDS UP.
  //
  // Reading it from the create-session response body does not work here: the
  // app redirects to the hosted payment step the moment the call returns, and
  // the body of a response on a page that has already navigated is no longer
  // readable — which surfaced as "checkout refused: null" against orders that
  // had in fact been created perfectly. The redirect URL is both readable and
  // closer to what actually happened to the customer.
  const failure = page.locator("text=/Unable to|no longer available|out of stock/i");
  await page.getByRole("button", { name: /continue to secure payment|continue to/i }).first().click();
  try {
    // 45s, not 30. WebKit is materially slower through this form, and a
    // three-product cart pushed it past the shorter timeout on an order that
    // was in fact created — a "checkout did not reach payment" failure with a
    // perfectly good order sitting in the database behind it.
    await page.waitForURL(/\/checkout\/pay\/(order-[0-9a-f-]+)/, { timeout: 45_000 });
  } catch {
    const shown = (await failure.count())
      ? await failure.first().innerText()
      // Nothing matched the known refusal phrasings, so quote the page itself.
      // "(no message on screen)" told me only that my regex was wrong.
      : (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`checkout did not reach payment at ${page.url()} :: ${shown.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const orderId = /\/checkout\/pay\/(order-[0-9a-f-]+)/.exec(page.url())?.[1];
  assert(orderId, `no order id in ${page.url()}`);
  return orderId;
}

async function readOrder(orderId) {
  const { rows } = await q(
    `select subtotal, shipping_amount, discount_amount, tax_amount, amount_paid, card_processing_fee
       from orders where order_id = $1`, [orderId],
  );
  const { rows: lines } = await q(
    "select product_id as slug, quantity, unit_price, unit_cost_cents from order_items where order_id = $1", [orderId],
  );
  return { ...rows[0], lines };
}

async function resetCustomer(email) {
  await q("delete from customer_offers where email = $1", [email]);
  await q("delete from order_items where order_id in (select order_id from orders where customer_email = $1)", [email]);
  await q("delete from orders where customer_email = $1", [email]);
}

// ---------------------------------------------------------------------------

async function runEngine(name, launcher) {
  engine_ = name;
  console.log(`\n${"=".repeat(70)}\n${name.toUpperCase()}\n${"=".repeat(70)}`);
  const browser = await launcher.launch({
    ...(name === "chromium" ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
    args: name === "chromium" ? ["--no-sandbox", "--ssl-version-max=tls1.2"] : [],
  });

  // ---- 1 & 2: the minimum, then the gift, seen on both surfaces -----------
  section("1–2. The $60 minimum, and the gift once it is met");
  const buyer = "journey-ghk@example.test";
  await resetCustomer(buyer);
  const ghkToken = await issue(buyer, "ghk");

  await step("at $59 neither cart nor checkout shows a gift", async () => {
    const context = await armedContext(browser, ghkToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    assert(cart.gifts.length === 0, `cart showed a gift below the minimum: ${cart.gifts.join(" / ")}`);
    assert(cart.total === 74, `cart total ${cart.total}, expected 74.00 ($59 + $15 shipping)`);

    await gotoCheckout(page, { email: buyer });
    const out = await readCheckout(page);
    assert(out.gifts.length === 0, `checkout showed a gift below the minimum: ${out.gifts.join(" / ")}`);
    assert(out.subtotal === 59, `checkout subtotal ${out.subtotal}`);
    assert(/Add \$1\.00 more/.test(out.banner ?? ""), `banner did not ask for the shortfall: ${out.banner}`);
    await context.close();
    return `cart $${cart.total}, checkout $${out.total}, "Add $1.00 more"`;
  });

  await step("the token survives an order that did not qualify", async () => {
    const { rows } = await q("select redeemed_at, reserved_order_id from customer_offers where email = $1", [buyer]);
    assert(rows[0].redeemed_at === null, "the token was spent by an order that got nothing");
    return "unredeemed";
  });

  let ghkOrderId = null;
  let ghkShown = null;
  await step("at $69 the gift is on screen in the cart AND at checkout, at $0", async () => {
    const context = await armedContext(browser, ghkToken);
    const page = await context.newPage();
    await addToCart(page, [BIG]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    assert(cart.gifts.length === 1, `cart gift lines: ${cart.gifts.length}`);
    assert(/GHK-Cu/i.test(cart.gifts[0]), `cart gift reads ${cart.gifts[0]}`);
    assert(/free/i.test(cart.gifts[0]), `cart gift is not priced Free: ${cart.gifts[0]}`);

    await gotoCheckout(page, { email: buyer });
    const out = await readCheckout(page);
    assert(out.gifts.length === 1, `checkout gift lines: ${out.gifts.length}`);
    assert(/GHK-Cu/i.test(out.gifts[0]), `checkout gift reads ${out.gifts[0]}`);
    assert(/free/i.test(out.gifts[0]), `checkout gift is not priced Free: ${out.gifts[0]}`);
    assert(out.subtotal === 69, `checkout subtotal ${out.subtotal} — the gift was charged for`);
    await page.screenshot({ path: `${SHOTS}/${name}-ghk-checkout.png`, fullPage: true });

    ghkShown = out.total;
    ghkOrderId = await placeOrder(page);
    await context.close();
    return `cart+checkout both show the vial free; displayed total $${out.total}`;
  });

  await step("the order matches what was displayed, to the cent", async () => {
    assert(ghkOrderId, "no order was placed");
    const order = await readOrder(ghkOrderId);
    assert(Number(order.amount_paid) === ghkShown,
      `screen said $${ghkShown}, the order charges $${order.amount_paid}`);
    const gift = order.lines.find((l) => l.slug === "ghk-cu");
    assert(gift, `no GHK-Cu line: ${order.lines.map((l) => l.slug).join(", ")}`);
    assert(Number(gift.unit_price) === 0, `gift priced ${gift.unit_price}`);
    assert(Number(gift.unit_cost_cents) === 2288, `COGS recorded as ${gift.unit_cost_cents}`);
    return `$${ghkShown} displayed = $${order.amount_paid} charged`;
  });

  // ---- 3: a spent token grants nothing ------------------------------------
  section("3. A redeemed token gives no second vial");
  await step("once redeemed, neither surface offers it again", async () => {
    await q("update customer_offers set redeemed_at = now(), redeemed_order_id = $2 where email = $1",
      [buyer, ghkOrderId]);
    const context = await armedContext(browser, ghkToken);
    const page = await context.newPage();
    await addToCart(page, [BIG]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    assert(cart.gifts.length === 0, `the cart offered a spent gift: ${cart.gifts.join(" / ")}`);
    await gotoCheckout(page, { email: buyer });
    const out = await readCheckout(page);
    assert(out.gifts.length === 0, `checkout offered a spent gift: ${out.gifts.join(" / ")}`);
    assert(out.banner === null, `a spent offer still rendered a banner: ${out.banner}`);
    const orderId = await placeOrder(page);
    const order = await readOrder(orderId);
    assert(!order.lines.some((l) => l.slug === "ghk-cu"), "a second free vial was granted");
    await context.close();
    return "no banner, no line, no vial";
  });

  // ---- 4: free shipping + a percentage ------------------------------------
  section("4. Free shipping + 15% off, on both surfaces");
  const comboBuyer = "journey-combo@example.test";
  await resetCustomer(comboBuyer);
  const comboToken = await issue(comboBuyer, "combo", { minCents: 3500, percent: 15 });
  let comboShown = null;
  let comboOrderId = null;

  await step("the cart shows $0 shipping and the 15% as dollars", async () => {
    const context = await armedContext(browser, comboToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    assert(/free/i.test(cart.shipping ?? ""), `cart shipping reads ${cart.shipping}, expected Free`);
    assert(money(cart.discount) === 8.85, `cart discount reads ${cart.discount}, expected $8.85 (15% of $59)`);
    assert(cart.total === 50.15, `cart total ${cart.total}, expected 50.15`);
    assert(cart.gifts.length === 0, `a shipping gift added a product line: ${cart.gifts.join(" / ")}`);
    await page.screenshot({ path: `${SHOTS}/${name}-combo-cart.png` });
    await context.close();
    return `shipping ${cart.shipping}, discount ${cart.discount}, total $${cart.total}`;
  });

  await step("checkout shows the same, and charges it", async () => {
    const context = await armedContext(browser, comboToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await gotoCheckout(page, { email: comboBuyer });
    const out = await readCheckout(page);
    assert(/free/i.test(out.shipping ?? ""), `checkout shipping reads ${out.shipping}, expected Free`);
    assert(money(out.discount) === 8.85, `checkout discount reads ${out.discount}`);
    assert(out.gifts.length === 0, `a shipping gift added a product line: ${out.gifts.join(" / ")}`);
    await page.screenshot({ path: `${SHOTS}/${name}-combo-checkout.png`, fullPage: true });
    comboShown = out.total;
    comboOrderId = await placeOrder(page);
    const order = await readOrder(comboOrderId);
    assert(Number(order.shipping_amount) === 0, `charged $${order.shipping_amount} shipping`);
    assert(Number(order.discount_amount) === 8.85, `charged discount $${order.discount_amount}`);
    assert(Number(order.amount_paid) === comboShown,
      `screen said $${comboShown}, the order charges $${order.amount_paid}`);
    await context.close();
    return `$${comboShown} displayed = $${order.amount_paid} charged`;
  });

  // ---- 5, 6, 7: the offer survives navigation -----------------------------
  section("5–7. Refresh, back/forward, and a direct arrival");
  const navBuyer = "journey-nav@example.test";
  await resetCustomer(navBuyer);
  const navToken = await issue(navBuyer, "combo", { minCents: 3500, percent: 15 });

  await step("a refreshed checkout still shows the gift and the same total", async () => {
    const context = await armedContext(browser, navToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await gotoCheckout(page, { email: navBuyer });
    const before = await readCheckout(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(ANY_TOTAL).first().waitFor({ timeout: 20_000 });
    await fillCheckoutForm(page, { email: navBuyer });
    const after = await readCheckout(page);
    assert(after.total === before.total, `total moved across a refresh: $${before.total} → $${after.total}`);
    assert(/free/i.test(after.shipping ?? ""), `shipping after refresh: ${after.shipping}`);
    await context.close();
    return `$${after.total} before and after`;
  });

  await step("walking cart → checkout → back → forward keeps it", async () => {
    const context = await armedContext(browser, navToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    await gotoCheckout(page, { email: navBuyer });
    const out = await readCheckout(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.locator(ANY_TOTAL).first().waitFor({ timeout: 20_000 });
    await fillCheckoutForm(page, { email: navBuyer });
    const back = await readCheckout(page);
    assert(back.total === out.total, `total moved after back/forward: $${out.total} → $${back.total}`);
    assert(/free/i.test(back.shipping ?? ""), `shipping after back/forward: ${back.shipping}`);
    await context.close();
    return `cart $${cart.total} → checkout $${out.total}, unchanged after back/forward`;
  });

  await step("arriving straight at /checkout, never opening the cart, still shows it", async () => {
    const context = await armedContext(browser, navToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    // No drawer, no cart page: straight in.
    await gotoCheckout(page, { email: navBuyer });
    const out = await readCheckout(page);
    assert(/free/i.test(out.shipping ?? ""), `shipping reads ${out.shipping}`);
    assert(money(out.discount) === 8.85, `discount reads ${out.discount}`);
    await context.close();
    return `direct arrival: ${out.shipping}, ${out.discount}`;
  });

  await step("checking out under a DIFFERENT address says so, rather than silently dropping it", async () => {
    // The one case this design could make worse. The cart prices the gift for
    // the address it was mailed to, because the shopper has typed nothing yet
    // and showing nothing would be the old bug again. If they then check out as
    // someone else the gift genuinely does not apply — the binding is enforced
    // under a lock at reservation — so the screen has to say why, at the moment
    // they cause it, instead of letting them find out from a receipt.
    const context = await armedContext(browser, navToken);
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    assert(/free/i.test(cart.shipping ?? ""), `cart did not preview the gift: ${cart.shipping}`);

    await gotoCheckout(page, { email: "someone-else@example.test" });
    const out = await readCheckout(page);
    assert(money(out.shipping) === 15, `a stranger's checkout still showed free shipping: ${out.shipping}`);
    assert(out.discount === null, `a stranger's checkout still discounted: ${out.discount}`);
    assert(/tied to the email address it was sent to/i.test(out.banner ?? ""),
      `no explanation of why the gift is gone: ${out.banner}`);

    // And typing the right address brings it back, in place, without a reload.
    await fillCheckoutForm(page, { email: navBuyer });
    const fixed = await readCheckout(page);
    assert(/free/i.test(fixed.shipping ?? ""), `the right address did not restore it: ${fixed.shipping}`);
    assert(money(fixed.discount) === 8.85, `restored discount reads ${fixed.discount}`);
    await page.screenshot({ path: `${SHOTS}/${name}-wrong-email.png`, fullPage: true });
    await context.close();
    return "explained, then restored when the right address is typed";
  });

  // ---- 8: mobile ----------------------------------------------------------
  section("8. Mobile checkout at 390x844");
  await step("the phone summary shows the gift and the right total", async () => {
    const context = await armedContext(browser, navToken, { width: 390, height: 844 });
    const page = await context.newPage();
    await addToCart(page, [SMALL]);
    await gotoCheckout(page, { email: navBuyer });
    // The mobile summary is collapsed behind its own toggle.
    const toggle = page.getByRole("button", { name: /order summary/i });
    if (await toggle.count()) { await toggle.first().click(); await page.waitForTimeout(900); }
    const out = await readCheckout(page);
    assert(/free/i.test(out.shipping ?? ""), `mobile shipping reads ${out.shipping}`);
    assert(money(out.discount) === 8.85, `mobile discount reads ${out.discount}`);
    // finalTotal, so the 3% card fee is in it: $50.15 payable + $1.50.
    assert(out.total === 51.65, `mobile total $${out.total}, expected 51.65 ($50.15 + the 3% card fee)`);
    await page.screenshot({ path: `${SHOTS}/${name}-mobile-checkout.png`, fullPage: true });
    await context.close();
    return `390x844: ${out.shipping}, ${out.discount}, $${out.total}`;
  });

  // ---- 9: no offer, nothing changes ---------------------------------------
  section("9. A shopper with no offer");
  await step("no banner, no gift, shipping charged, and no quote request at all", async () => {
    const context = await armedContext(browser, null);
    const page = await context.newPage();
    const quoteCalls = [];
    page.on("request", (r) => { if (r.url().includes("/api/checkout/quote")) quoteCalls.push(r.url()); });
    await addToCart(page, [SMALL]);
    await openDrawer(page);
    const cart = await readDrawer(page);
    assert(cart.gifts.length === 0, "a gift appeared without an offer");
    assert(cart.total === 74, `cart total $${cart.total}, expected 74.00`);
    await gotoCheckout(page, { email: "journey-plain@example.test" });
    const out = await readCheckout(page);
    assert(out.banner === null, `an offer banner rendered with no offer: ${out.banner}`);
    assert(out.gifts.length === 0, "a gift line rendered with no offer");
    assert(money(out.shipping) === 15, `shipping reads ${out.shipping}, expected $15.00`);
    assert(quoteCalls.length === 0, `${quoteCalls.length} preview requests were made for a shopper with no offer`);
    const orderId = await placeOrder(page);
    const order = await readOrder(orderId);
    assert(Number(order.amount_paid) === out.total, `screen $${out.total} vs charged $${order.amount_paid}`);
    await context.close();
    return `unchanged: $15.00 shipping, $${out.total}, 0 preview requests`;
  });

  // ---- 10, 11, 12: the other pricing paths still work ---------------------
  section("10–12. Coupons, the free-shipping threshold, and quantity pricing");
  const couponBuyer = "journey-coupon@example.test";
  const thresholdBuyer = "journey-threshold@example.test";
  const bulkBuyer = "journey-bulk@example.test";

  await step("a coupon and an offer together still match the till", async () => {
    await resetCustomer(couponBuyer);
    const token = await issue(couponBuyer, "ghk");
    await q("delete from coupons where code = 'JOURNEY10'");
    await q(`insert into coupons (code, discount_type, discount_value, active, redemptions_count, free_shipping, created_at)
             values ('JOURNEY10','percent',10,true,0,false,now())`);
    const context = await armedContext(browser, token);
    const page = await context.newPage();
    await addToCart(page, [BIG]);
    await gotoCheckout(page, { email: couponBuyer });
    // The code box lives behind a collapsed section. Skipping the toggle types
    // into nothing, applies nothing, and leaves the step asserting that a
    // coupon which never ran did no harm — which it will always pass.
    await page.getByText(/referral or coupon|referral, coupon, or rewards/i).first().click();
    await page.waitForTimeout(700);
    const couponField = page.getByPlaceholder("SAVE10");
    await couponField.first().waitFor({ timeout: 10_000 });
    await couponField.first().fill("JOURNEY10");
    // The Apply BESIDE THIS FIELD. The section holds a referral box with its own
    // Apply above this one, and clicking the first match submits an empty
    // referral code instead — which answers "Enter a referral code", applies no
    // coupon, and leaves the step passing for the wrong reason.
    await couponField.first().locator("xpath=..").getByRole("button", { name: /apply/i }).first().click();
    await page.waitForTimeout(3000);
    const out = await readCheckout(page);
    assert(out.gifts.length === 1, `the coupon displaced the gift: ${out.gifts.length} gift lines`);
    assert(money(out.discount) > 0, `the coupon applied no discount (row: ${out.discount})`);
    const expectedCoupon = Math.round(out.subtotal * 0.10 * 100) / 100;
    assert(Math.abs(money(out.discount) - expectedCoupon) < 0.02,
      `discount ${out.discount}, expected about $${expectedCoupon} (10% of $${out.subtotal})`);
    const orderId = await placeOrder(page);
    const order = await readOrder(orderId);
    assert(Number(order.amount_paid) === out.total, `screen $${out.total} vs charged $${order.amount_paid}`);
    assert(Number(order.discount_amount) === money(out.discount),
      `screen discount ${out.discount} vs charged $${order.discount_amount}`);
    assert(order.lines.some((l) => l.slug === "ghk-cu" && Number(l.unit_price) === 0), "the free vial was lost");
    await context.close();
    return `coupon + gift: $${out.total} displayed and charged, discount $${order.discount_amount}`;
  });

  await step("over the store's free-shipping threshold, nothing double-counts", async () => {
    await resetCustomer(thresholdBuyer);
    const token = await issue(thresholdBuyer, "combo", { minCents: 3500, percent: 15 });
    const context = await armedContext(browser, token);
    const page = await context.newPage();
    // Past the STORE's own free-shipping threshold ($200), which is the point:
    // shipping is already free before the gift touches it, and the two rules
    // must not fight or double-count. $69 + $79 + $59 = $207.
    await addToCart(page, [BIG, THIRD, SMALL]);
    await gotoCheckout(page, { email: thresholdBuyer });
    const out = await readCheckout(page);
    assert(/free/i.test(out.shipping ?? ""), `shipping reads ${out.shipping}`);
    const orderId = await placeOrder(page);
    const order = await readOrder(orderId);
    assert(out.subtotal > 200, `subtotal $${out.subtotal} did not clear the $200 store threshold`);
    assert(Number(order.shipping_amount) === 0, `charged $${order.shipping_amount} shipping`);
    assert(Number(order.amount_paid) === out.total, `screen $${out.total} vs charged $${order.amount_paid}`);
    // The percentage half must still be exactly 15% of the subtotal — not 30%
    // from being counted twice, and not 0 from the threshold swallowing it.
    const expected = Math.round(Number(order.subtotal) * 0.15 * 100) / 100;
    assert(Math.abs(Number(order.discount_amount) - expected) < 0.02,
      `discount $${order.discount_amount}, expected about $${expected} (15% of $${order.subtotal})`);
    await context.close();
    return `$${out.subtotal} subtotal (over the $200 threshold), free shipping once, discount $${order.discount_amount}`;
  });

  await step("quantity/bulk pricing and the gift agree with the till", async () => {
    await resetCustomer(bulkBuyer);
    const token = await issue(bulkBuyer, "ghk");
    const context = await armedContext(browser, token);
    const page = await context.newPage();
    await addToCart(page, [BIG]);
    await gotoCheckout(page, { email: bulkBuyer });
    // Three of the same line: bulk tiers and per-unit bundle pricing engage.
    const plus = page.getByRole("button", { name: /increase .* quantity/i });
    await plus.first().click(); await page.waitForTimeout(500);
    await plus.first().click(); await page.waitForTimeout(2400);
    const out = await readCheckout(page);
    assert(out.gifts.length === 1, `expected exactly one visible gift line at quantity 3, saw ${out.gifts.length}`);
    const orderId = await placeOrder(page);
    const order = await readOrder(orderId);
    assert(Number(order.amount_paid) === out.total, `screen $${out.total} vs charged $${order.amount_paid}`);
    const paid = order.lines.filter((l) => l.slug !== "ghk-cu");
    assert(paid.reduce((n, l) => n + Number(l.quantity), 0) === 3, "the quantity change did not reach the order");
    await context.close();
    return `qty 3 + gift: $${out.total} displayed and charged, subtotal $${order.subtotal}`;
  });

  // ---- 13: stock -----------------------------------------------------------
  section("13. Inventory reservation and release");
  await step("the previewed gift reserves nothing; the ordered one does", async () => {
    const previewBuyer = "journey-stock@example.test";
    await resetCustomer(previewBuyer);
    const token = await issue(previewBuyer, "ghk");
    const before = (await q("select count(*)::int as n from inventory_reservations where slug = 'ghk-cu'")).rows[0].n;
    const context = await armedContext(browser, token);
    const page = await context.newPage();
    await addToCart(page, [BIG]);
    await gotoCheckout(page, { email: previewBuyer });
    const during = (await q("select count(*)::int as n from inventory_reservations where slug = 'ghk-cu'")).rows[0].n;
    assert(during === before, `previewing the gift reserved stock (${before} → ${during})`);
    const orderId = await placeOrder(page);
    const after = (await q(
      "select quantity, status from inventory_reservations where order_id = $1 and slug = 'ghk-cu'", [orderId],
    )).rows;
    assert(after.length === 1, `expected 1 reservation for the ordered gift, found ${after.length}`);
    assert(Number(after[0].quantity) === 1, `reserved ${after[0].quantity}`);
    await context.close();
    return `preview reserved 0, order reserved 1 (${after[0].status})`;
  });

  // ---- 15: the client cannot move the charge ------------------------------
  section("14–15. The server is still the authority");
  await step("a tampered-down total is refused, not charged", async () => {
    const tamperBuyer = "journey-tamper@example.test";
    await resetCustomer(tamperBuyer);
    const token = await issue(tamperBuyer, "ghk");
    const context = await armedContext(browser, token);
    const page = await context.newPage();
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await clearRateLimit();
    const res = await page.evaluate(async ([payload]) => {
      const r = await fetch("/api/checkout/create-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: JSON.stringify(payload),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [{
      items: [{ id: BIG.slug, quantity: 1 }],
      customer: {
        email: tamperBuyer, fullName: "Tamper", address: "1 Harness Way", city: "Testville",
        state: "CA", postalCode: "90000", country: "United States", phone: "5555555555",
      },
      currency: "USD",
      expectedTotal: 1,
      complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
    }]);
    assert(!res.body?.orderId, `a $1 claim created order ${res.body?.orderId}`);
    assert(/no longer available|updated|total/i.test(String(res.body?.error ?? "")),
      `unexpected refusal: ${JSON.stringify(res.body).slice(0, 160)}`);
    await context.close();
    return `refused: ${String(res.body?.error ?? "").slice(0, 70)}…`;
  });

  await step("the preview endpoint hands back no token, ever", async () => {
    const peekBuyer = "journey-peek@example.test";
    await resetCustomer(peekBuyer);
    const token = await issue(peekBuyer, "ghk");
    const context = await armedContext(browser, token);
    const page = await context.newPage();
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const raw = await page.evaluate(async ([slug]) => {
      const r = await fetch("/api/checkout/quote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: JSON.stringify({ items: [{ id: slug, quantity: 1 }] }),
      });
      return r.text();
    }, [BIG.slug]);
    assert(!raw.includes(token), "the preview response contained the offer token");
    assert(!raw.includes(peekBuyer), "the preview response leaked the bound email address");
    assert(JSON.parse(raw)?.quote?.giftLines?.length === 1, `no gift in the preview: ${raw.slice(0, 160)}`);
    await context.close();
    return "no token, no address, gift described";
  });

  await browser.close();
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  await q("update products set inventory_quantity = 900, stock_status = 'In Stock'");
  await q("update product_doses set inventory_quantity = 900, stock_status = 'In Stock'").catch(() => {});
  await q("delete from inventory_reservations").catch(() => {});

  for (const name of ENGINES) {
    const launcher = name === "webkit" ? webkit : chromium;
    try {
      await runEngine(name, launcher);
    } catch (error) {
      results.push({ engine: name, section: "engine", name: `${name} run`, status: "fail", detail: String(error?.message ?? error).slice(0, 200) });
      console.log(`\n  FAIL  ${name} aborted: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }

  const failed = results.filter((r) => r.status === "fail");
  console.log(`\n${"=".repeat(70)}`);
  for (const name of ENGINES) {
    const mine = results.filter((r) => r.engine === name);
    console.log(`${name}: ${mine.filter((r) => r.status === "pass").length}/${mine.length} passed`);
  }
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  [${f.engine}] ${f.section} → ${f.name}\n    ${f.detail}`);
  }
  console.log(`screenshots: ${SHOTS}`);
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
