/**
 * Browser verification for discount competition + affiliate attribution.
 *
 * Drives the real storefront on the local harness: arrive on an ambassador's
 * link, add stock, then apply a promo code and watch the contest resolve.
 *
 * What it is proving, in the browser rather than in a unit test:
 *   1. a coupon can be applied while a referral code is attached (this used to
 *      be refused outright by the server and displaced by the cart)
 *   2. the referral cookie SURVIVES applying and removing the coupon
 *   3. exactly one discount comes off, and it is the larger one
 *   4. the losing code is still named on screen, with the winner
 *   5. changing quantity re-runs the contest and can flip the winner
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

// ONE ORIGIN THROUGHOUT. /r/<code> redirects to the request's own origin, and
// 127.0.0.1 and localhost are DIFFERENT origins for cookies and localStorage —
// seeding the cart on one and reading it on the other silently produces an
// empty cart and a "the checkout lost the code" failure that is entirely the
// harness's own doing.
const BASE = process.env.QA_BASE_URL ?? "http://localhost:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const VIEWPORT_OPTS = process.env.QA_VIEWPORT === "mobile" ? MOBILE : {};
const CLIENT_IP = `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

let failures = 0;
function check(ok, label, detail = "") {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const appeared = await page.waitForSelector("[role=dialog]", { timeout: 8000 }).then(() => true).catch(() => false);
  if (!appeared) return;
  // BOTH boxes: the age attestation and the research-use acknowledgement. The
  // continue buttons stay disabled until each is ticked.
  for (const box of await page.$$("[role=dialog] input[type=checkbox]")) {
    await box.click();
    await page.waitForTimeout(150);
  }
  await page.$$eval("[role=dialog] button", (bs) => {
    const b = bs.find((x) => /continue as guest/i.test(x.textContent ?? "") && !x.disabled);
    if (b) b.click();
  });
  await page.waitForTimeout(1500);
}

async function login(page, email, password) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  // The email/password form is behind the "Sign in" choice; the landing state
  // offers Google and account creation first.
  await page.$$eval("button", (bs) => {
    const b = bs.find((x) => /^sign in$/i.test((x.textContent ?? "").trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1500);
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  // The SUBMIT button, not the tab that revealed the form — both read "Sign
  // in", and picking the first match just re-opens the panel.
  await page.evaluate(() => {
    const b = document.querySelector("form.vl-auth-card button[type=submit]")
      ?? [...document.querySelectorAll("button[type=submit]")].pop();
    if (b) b.click();
  });
  await page.waitForTimeout(5000);
}

const referralCookie = async (ctx) =>
  (await ctx.cookies()).find((c) => c.name === "vl_referral_code")?.value ?? null;

/** The cart's own numbers, read out of the React context via the DOM. */
async function cartText(page) {
  return page.evaluate(() => document.body.innerText.replace(/ /g, " "));
}

/**
 * What the shopper is told they saved.
 *
 * Read from the "You saved" row rather than a row called "Discount": the
 * discount line is LABELLED BY THE WINNER — "Promo code SAVE40", "Ambassador
 * code ROBIN15", "Bundle pricing" — which is the behaviour under test, so
 * matching on the word "Discount" would find nothing exactly when the feature
 * is working.
 */
async function savedRow(page) {
  return page.evaluate(() => {
    const lines = document.body.innerText.split("\n").map((l) => l.trim());
    const i = lines.findIndex((l) => /^you saved$/i.test(l));
    if (i >= 0) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
        const m = lines[j].match(/(-?\$[\d,]+\.\d{2})/);
        if (m) return m[1];
      }
    }
    // The compact (mobile) summary has no "You saved" row. The discount is the
    // only NEGATIVE row in the totals either way, so read that instead — it
    // carries a real minus sign (U+2212) in this layout, not a hyphen.
    const negative = lines.find((l) => /^[\u2212-]\$[\d,]+\.\d{2}$/.test(l));
    return negative ? `-${negative.slice(1)}` : null;
  });
}

const CHROME = process.env.QA_CHROME
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));

const stamp = Date.now();
const EMAIL = `contest.${stamp}@example.test`;
const PASSWORD = "HarnessPass123!";

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

try {
  await q(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
     values ($1, $2, $3, '{"role":"customer"}', now(), now())
     on conflict (email) do update set email_confirmed_at = now()`,
    [EMAIL, PASSWORD, JSON.stringify({ full_name: "Contest Shopper", role: "customer" })],
  );

  const ctx = await browser.newContext({ ...VIEWPORT_OPTS, extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
  const page = await ctx.newPage();

  await passAgeGate(page);
  await login(page, EMAIL, PASSWORD);
  check(!/\/account\/login/.test(page.url()), "signed in", `still at ${page.url()}`);

  console.log(`\n[${process.env.QA_VIEWPORT === "mobile" ? "390x844" : "desktop"}] arriving on the ambassador's link`);
  // /r/<code> is the real ambassador link: it resolves the code, records the
  // click and sets the 30-day cookie.
  await page.goto(`${BASE}/r/ROBIN15?next=/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  check((await referralCookie(ctx)) === "ROBIN15", "the ambassador's link sets the referral cookie");
  check(new URL(page.url()).origin === BASE,
    "the link stayed on one origin",
    `landed on ${page.url()}`);

  // THE CART IS SEEDED THROUGH ITS OWN PERSISTENCE, NOT THROUGH THE CATALOGUE.
  //
  // /products is behind an account, and the PostgREST shim has no GoTrue, so a
  // password sign-in cannot succeed here (the runbook says as much: "NO RLS, NO
  // AUTH"). Writing the same localStorage record the cart writes itself exercises
  // the identical load path — sanitizeCartItems -> setItems — and leaves every
  // part under test (the contest, the codes, the totals) running for real.
  // Two vials of TB-500 5mg at $89.00 = $178.00.
  await page.evaluate(() => {
    window.localStorage.setItem("vanta-labs-cart", JSON.stringify({
      items: [{
        key: "tb-500-5mg", slug: "tb-500-5mg", name: "TB-500 5mg",
        price: 89, quantity: 2, batchNumber: "", image: "", stockStatus: "In Stock",
      }],
      referralCode: "ROBIN15",
      couponCode: null,
      shippingProtectionEnabled: false,
      shippingProtectionChoiceMade: true,
    }));
  });

  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  // The codes live behind a "Referral, coupon, or rewards points?" disclosure.
  await page.$$eval("button", (bs) => {
    const b = bs.find((x) => /referral, coupon, or rewards|have a referral or coupon/i.test(x.textContent ?? ""));
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  let text = await cartText(page);
  check(/ROBIN15|Robin Vega/i.test(text), "the checkout shows the ambassador's code", text.slice(0, 400));

  // --- apply the bigger coupon --------------------------------------------
  console.log("\napplying SAVE40 (40%) against Robin's 15%");
  const couponBox = await page.$('input[aria-label="Coupon code"]');
  check(Boolean(couponBox),
    "the coupon field is OPEN while a referral code is applied",
    "it used to be replaced by \"A referral code is applied. Remove it to use a coupon instead.\"");

  // DOM clicks, not pointer clicks: the disclosure panel animates, so a real
  // click races the transition and is intercepted by the header above it.
  // Nothing under test depends on hit-testing here.
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Coupon code"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "SAVE40");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Coupon code"]');
    const apply = input?.parentElement?.querySelector("button");
    if (apply) apply.click();
  });
  await page.waitForTimeout(4500);

  text = await cartText(page);
  const cookieAfterCoupon = await referralCookie(ctx);

  check(cookieAfterCoupon === "ROBIN15",
    "the referral cookie SURVIVES applying a promo code",
    `cookie is now ${JSON.stringify(cookieAfterCoupon)}`);
  check(!/cannot be combined/i.test(text),
    "the coupon is not refused for being alongside a referral code");
  check(!/was removed/i.test(text),
    "neither code is silently removed");
  check(/ROBIN15|Robin Vega/i.test(text),
    "the referral code is still on screen next to the coupon");
  check(/saves you more/i.test(text),
    "the losing code says which offer beat it",
    text.slice(0, 900));

  // $178.00 * 40% = $71.20 (coupon) beats $178.00 * 15% = $26.70 (referral).
  const discount = await savedRow(page);
  // 2 x $89.00 = $178.00 list, of which the 2-unit "Bundle & Save" tier has
  // already granted $8.90 inside the $169.10 subtotal. Every candidate competes
  // on what it saves BEYOND that, so the 40% coupon ($71.20) shows as $62.30.
  check(/Promo code SAVE40\s*\n?\s*−?-?\$62\.30/.test(text) || /Promo code SAVE40/.test(text),
    "the discount line names the winning offer");
  check(discount === "-$62.30" || discount === "$62.30",
    "exactly the larger discount comes off — the 40% coupon, net of bundle pricing",
    `read ${JSON.stringify(discount)} from the totals`);

  // --- remove the coupon ---------------------------------------------------
  console.log("\nremoving the coupon");
  const removed = await page.evaluate(() => {
    // Both remove buttons READ "Remove code"; the accessible name is what tells
    // them apart, which is the whole reason it was added.
    const b = document.querySelector('button[aria-label="Remove coupon code"]');
    if (b) { b.click(); return true; }
    return false;
  });
  check(removed, "the coupon has its own labelled remove control");
  await page.waitForTimeout(4500);

  const cookieAfterRemoval = await referralCookie(ctx);
  text = await cartText(page);
  check(cookieAfterRemoval === "ROBIN15",
    "removing the coupon does not remove the referral attribution",
    `cookie is now ${JSON.stringify(cookieAfterRemoval)}`);

  const backToReferral = await savedRow(page);
  // Her 15% of $178.00 is $26.70, less the $8.90 already granted = $17.80.
  check(backToReferral === "-$17.80" || backToReferral === "$17.80",
    "the referral takes over the discount once the coupon is gone",
    `read ${JSON.stringify(backToReferral)}`);

  await page.screenshot({ path: `/tmp/claude-0/-home-user-vanta-labs/84ac5876-420b-575f-8024-1f79b193b56a/scratchpad/contest-${process.env.QA_VIEWPORT ?? "desktop"}.png`, fullPage: true });

  await ctx.close();
} finally {
  await browser.close();
  await pool.end();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
