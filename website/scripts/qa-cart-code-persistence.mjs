#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A code the shopper was shown must still be there after a reload.
//
// THE DEFECT THIS EXISTS TO CATCH. `couponCode` lived only in React state while
// `referralCode` was persisted beside the items in localStorage. Both look
// identical on screen — a code, a discount line, a lower total — so nothing
// hinted that only one of them survived a new document. Refreshing checkout
// dropped the coupon and put the total back UP by the discount the shopper had
// just been promised, with no message saying the code was gone. The cart page
// meanwhile says "Your cart persists locally while you review or continue
// checkout", which was true of the items and the referral and not of the coupon.
//
// It hid because the ordinary path never reloads: drawer -> checkout is a
// client-side navigation and React state survives it. The reload paths are the
// ones a shopper actually hits — refresh, restore a tab, open checkout in a new
// tab, come back from the payment hand-off (window.location.assign).
//
// Restoring the code is only half of it, so this asserts the other half too: a
// restored code is re-validated before it discounts anything, and a coupon that
// has since been switched off must NOT come back out of the shopper's own
// localStorage as a live discount.
//
//   node scripts/qa-cart-code-persistence.mjs
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL || "postgres://postgres@localhost:55432/storefront";
const COUPON = process.env.QA_COUPON_CODE || "HARNESS10";
const PRODUCT = process.env.QA_PRODUCT_SLUG || "bpc-157-10mg";

let passed = 0;
let failed = 0;
const step = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const money = (text) => {
  const m = text.match(/TOTAL\s*\$([0-9,]+\.[0-9]{2})/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

const client = new pg.Client({ connectionString: DB });
await client.connect();

// Same resolution qa-purchase-path.mjs uses: the pre-installed Chromium moves
// between image builds, so probe for it rather than hardcoding one path, and
// fall back to Playwright's own default when neither exists.
// --ssl-version-max=tls1.2 is not optional in a cloud session: the egress proxy
// resets Chromium's default TLS 1.3 ClientHello on EVERY host, which reads as a
// site-wide outage and is not one. See docs/BROWSER-TESTING-RUNBOOK.md.
const CHROME = process.env.QA_CHROMIUM
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => {
  try {
    window.sessionStorage.setItem("vl-age-confirmed-session", "true");
  } catch { /* private mode */ }
});
const page = await context.newPage();

const openDrawer = async () => {
  await page.click('button[aria-label*="art" i]');
  await page.waitForTimeout(1200);
  const disclosure = page.locator('button:has-text("Have a referral or coupon code")');
  if (await disclosure.count()) {
    await disclosure.first().click();
    await page.waitForTimeout(500);
  }
};

const applyCoupon = async (code) => {
  const input = page.locator('input[placeholder="LAUNCH"]').first();
  await input.fill(code);
  await page.waitForTimeout(200);
  await page.locator('button:has-text("Apply")').last().click();
  await page.waitForTimeout(2200);
};

const drawerText = () => page.evaluate(() => document.body.innerText);

try {
  console.log("\n1. A coupon applied in the drawer survives a reload");

  await page.goto(`${BASE}/products/${PRODUCT}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('button.flex-1:has-text("Add")').first().click();
  await page.waitForTimeout(1800);

  await openDrawer();
  await applyCoupon(COUPON);

  let text = await drawerText();
  const discountedTotal = money(text);
  const showsCode = text.includes(COUPON);
  step(
    showsCode && discountedTotal !== null,
    "the coupon applies and lowers the total",
    `${COUPON}, total $${discountedTotal}`,
  );

  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("vanta-labs-cart") || "{}"),
  );
  step(
    stored.couponCode === COUPON,
    "the coupon is written to the persisted cart",
    `stored couponCode=${JSON.stringify(stored.couponCode)}`,
  );

  // The reload. This is the whole point of the file.
  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  text = await page.evaluate(() => document.body.innerText);
  const survivedCode = /Promo code\s*HARNESS10|Coupon applied/i.test(text) || text.includes(COUPON);
  step(
    survivedCode,
    "after a full page load the coupon is STILL applied",
    survivedCode ? "code and discount line present" : "the coupon was silently dropped",
  );

  const afterReloadDiscount = /Promo code/i.test(text);
  step(
    afterReloadDiscount,
    "the discount line is still on the total, not just the code in the box",
    afterReloadDiscount ? "promo line rendered" : "no promo line after reload",
  );

  console.log("\n2. A restored code is re-validated, not trusted");

  // Switch the coupon OFF in the database, then reload with it still in the
  // shopper's localStorage. A restored code that is merely replayed would keep
  // discounting; a re-validated one must not.
  await client.query("update coupons set active = false where upper(code) = upper($1)", [COUPON]);
  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3200);
  text = await page.evaluate(() => document.body.innerText);
  const stillDiscounting = /Promo code/i.test(text);
  step(
    !stillDiscounting,
    "a coupon switched off since it was stored does NOT come back as a discount",
    stillDiscounting
      ? "an inactive coupon was replayed out of localStorage"
      : "re-validated and dropped",
  );
} finally {
  await client.query("update coupons set active = true where upper(code) = upper($1)", [COUPON]);
  await client.end();
  await browser.close();
}

console.log(`\n${passed + failed} steps: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
