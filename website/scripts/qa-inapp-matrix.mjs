// Drives the acquisition funnel under realistic device/in-app profiles.
// SIMULATED: Chromium engine + UA + viewport + touch. WebKit is not installed
// here, so iOS Safari's own engine behaviour is NOT covered — reported as such.
import { chromium } from "playwright";
import pg from "pg";

const BASE = "http://127.0.0.1:3000";
const DB = "postgres://postgres@localhost:55432/storefront";
const EMAIL = "qa.verified@example.test";
const PASSWORD = "HarnessPass123!";

const PROFILES = [
  { name: "Desktop Chrome", w: 1280, h: 800, touch: false,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36" },
  { name: "iPhone 14 (390x844)", w: 390, h: 844, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  { name: "iPhone SE (375x667)", w: 375, h: 667, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  { name: "Android Pixel (412x915)", w: 412, h: 915, touch: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36" },
  { name: "TikTok in-app (390x780)", w: 390, h: 780, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US" },
  { name: "Instagram in-app (390x760)", w: 390, h: 760, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0.0 (iPhone14,3; iOS 17_0; en_US)" },
  { name: "Facebook in-app (412x840)", w: 412, h: 840, touch: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]" },
];

const pool = new pg.Pool({ connectionString: DB });
async function resetCustomer() {
  await pool.query("delete from customer_offers where email=$1", [EMAIL]);
  await pool.query("delete from sms_subscribers where email=$1", [EMAIL]);
  await pool.query("delete from customer_preferences where phone is not null");
  // The limiter is per account now, but seven profiles are one account, so the
  // bucket is cleared between profiles the way an hour would clear it.
  await pool.query("delete from rate_limit_hits");
}

const results = [];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--ssl-version-max=tls1.2"] });

for (const p of PROFILES) {
  await resetCustomer();
  const ctx = await browser.newContext({
    viewport: { width: p.w, height: p.h },
    userAgent: p.ua,
    hasTouch: p.touch,
    isMobile: p.touch,
    deviceScaleFactor: p.touch ? 3 : 1,
  });
  const page = await ctx.newPage();
  const r = { profile: p.name, steps: {} };
  try {
    // consent + login
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { try { localStorage.setItem("vl_cookie_consent","accepted"); localStorage.removeItem("vl_spin_invite_dismissed_at"); } catch {} });
    await page.getByRole("checkbox", { name: /21 years/i }).check().catch(()=>{});
    await page.getByRole("checkbox", { name: /research use/i }).check().catch(()=>{});
    await page.getByRole("button", { name: /Sign in with email/i }).click().catch(()=>{});
    await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
    await page.getByRole("textbox", { name: /Password/ }).fill(PASSWORD);
    await page.getByRole("button", { name: /^Sign In$/ }).click();
    await page.waitForURL(u => !/\/account\/login/.test(u.toString()), { timeout: 20000 });
    r.steps.login = "ok";

    // catalogue + invitation
    await page.goto(`${BASE}/products/kisspeptin`, { waitUntil: "domcontentloaded" });
    // THE PROMOTIONS CARD GETS THE FIRST SHOPPING PAGE. The invitation
    // deliberately yields to any open overlay, so this is a correct
    // suppression, not a failure. Escape is the modal's own documented close.
    const promo = page.locator('[data-offer-modal]');
    await promo.first().waitFor({ state: "visible", timeout: 8000 }).catch(()=>{});
    if (await promo.first().isVisible().catch(()=>false)) {
      await page.keyboard.press("Escape");
      await promo.first().waitFor({ state: "detached", timeout: 8000 }).catch(()=>{});
    }
    r.steps.promoDismissed = !(await promo.first().isVisible().catch(()=>false));
    // Next qualifying page view: the invitation now gets its ten seconds.
    await page.goto(`${BASE}/products/semax`, { waitUntil: "domcontentloaded" });
    r.steps.overlayClearAtStart = !(await promo.first().isVisible().catch(()=>false));
    const card = page.locator('[data-testid="entry-offer-modal"]');
    await card.waitFor({ state: "visible", timeout: 30000 });
    r.steps.invitation = "appeared";

    // fits the viewport? no horizontal overflow?
    const box = await card.boundingBox();
    r.steps.cardWithinViewport = box ? (box.width <= p.w + 1) : "no box";
    r.steps.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

    // inputs usable
    await page.getByTestId("entry-offer-phone").fill("512-555-0161");
    r.steps.phoneInput = (await page.getByTestId("entry-offer-phone").inputValue()) === "512-555-0161" ? "ok" : "FAILED";
    await page.getByTestId("entry-offer-confirm").check();
    await page.getByTestId("entry-offer-sms-consent").check();
    r.steps.checkboxesReachable = (await page.getByTestId("entry-offer-sms-consent").isChecked()) ? "ok" : "FAILED";

    // spin
    await page.getByTestId("entry-offer-submit").click();
    await page.waitForURL(/\/spin/, { timeout: 20000 });
    r.steps.reachedWheel = "ok";
    await page.getByRole("button", { name: /Spin the wheel/i }).click();
    // The mint is a server write; the panel only appears after the wheel has
    // finished turning. Poll the row rather than reading it once, and say
    // plainly whether the panel arrived, so a slow animation is never read as
    // a failed mint.
    r.steps.resultPanel = await page
      .waitForFunction(() => /You won|Your reward|Spend \$/i.test(document.body.innerText), { timeout: 40000 })
      .then(() => "appeared").catch(() => "TIMED OUT");
    let rows = [];
    for (let i = 0; i < 40; i += 1) {
      ({ rows } = await pool.query("select reward_kind, product_slug, min_subtotal_cents from customer_offers where email=$1", [EMAIL]));
      if (rows.length) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    r.steps.prizeMinted = rows.length === 1 ? `${rows[0].reward_kind}/${rows[0].product_slug ?? "-"}` : `UNEXPECTED ${rows.length} rows`;
    if (rows.length !== 1) {
      r.steps.pageSays = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 300);
    }
    r.steps.wheelOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  } catch (e) {
    r.error = String(e).split("\n")[0].slice(0, 180);
  }
  results.push(r);
  await ctx.close();
}
await browser.close();
await pool.end();
console.log(JSON.stringify(results, null, 2));
