// Does the cart drawer promise a reward the till withholds?
// Controlled: a free-KLOW prize with a $200 floor, and a basket of 2 x KLOW.
import { chromium } from "playwright";
import pg from "pg";
const BASE = "http://127.0.0.1:3000";
const pool = new pg.Pool({ connectionString: "postgres://postgres@localhost:55432/storefront" });
const EMAIL = "qa.verified@example.test";
const say = (l, v) => console.log(`  ${l.padEnd(46)} ${v}`);

await pool.query("delete from customer_offers where email=$1", [EMAIL]);
await pool.query(`insert into customer_offers
  (offer_key, email, token_hash, reward_kind, product_slug, quantity, min_subtotal_cents, issued_at, expires_at)
  values ('spin:winback_2026q4', $1, 'seed-not-a-real-token', 'free_product', 'klow', 1, 20000, now(), now() + interval '72 hours')`, [EMAIL]);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => { try { localStorage.setItem("vl_cookie_consent","accepted"); } catch {} });
await page.getByRole("checkbox", { name: /21 years/i }).check().catch(()=>{});
await page.getByRole("checkbox", { name: /research use/i }).check().catch(()=>{});
await page.getByRole("button", { name: /Sign in with email/i }).click().catch(()=>{});
await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
await page.getByRole("textbox", { name: /Password/ }).fill("HarnessPass123!");
await page.getByRole("button", { name: /^Sign In$/ }).click();
await page.waitForURL(u => !/\/account\/login/.test(u.toString()), { timeout: 20000 });

// Arm this browser with the seeded prize the way the storefront does.
const claim = await page.evaluate(async () => {
  const r = await fetch("/api/spin/claim", { method: "POST", credentials: "same-origin" });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
});
say("claim", `${claim.status} ${claim.body}`);
const status = await page.evaluate(async () => (await (await fetch("/api/offer/status", { credentials: "same-origin" })).text()).slice(0, 220));
say("offer the browser now holds", status);

// Two KLOW in the basket, the way a shopper builds one.
await page.goto(`${BASE}/products/klow`, { waitUntil: "domcontentloaded" });
// The promotions card takes the first shopping page; Escape is its own close.
const promo = page.locator('[data-offer-modal]');
await promo.first().waitFor({ state: "visible", timeout: 8000 }).catch(()=>{});
if (await promo.first().isVisible().catch(()=>false)) {
  await page.keyboard.press("Escape");
  await promo.first().waitFor({ state: "detached", timeout: 8000 }).catch(()=>{});
}
const dismissAnySheet = async () => {
  for (const name of [/No thanks, continue shopping/i, /Continue shopping/i]) {
    const b = page.getByRole("button", { name });
    if (await b.first().isVisible().catch(()=>false)) { await b.first().click().catch(()=>{}); await page.waitForTimeout(800); }
  }
  await page.keyboard.press("Escape").catch(()=>{});
  await page.waitForTimeout(600);
};
await page.getByRole("button", { name: /add to cart/i }).first().click();
await page.waitForTimeout(1800);
await dismissAnySheet();
await page.getByRole("button", { name: /add to cart/i }).first().click();
await page.waitForTimeout(1800);
await dismissAnySheet();

// Open the cart itself, which is where the banner lives.
await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const drawerText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
say("cart line count", JSON.stringify(drawerText.match(/KLOW/g)?.length ?? 0));
const banner = drawerText.match(/(Free KLOW[^.]{0,80}|applied at checkout|add \$[\d.]+ more[^.]{0,40}|\$[\d.]+ away)/gi) ?? [];
say("what the cart says", JSON.stringify(banner.slice(0, 4)));
console.log("\n  CART TEXT:", drawerText.slice(0, 1100));

// And what the till says for the same basket.
// The drawer, which is a different component from /cart.
await page.goto(`${BASE}/products/klow`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await page.keyboard.press("Escape").catch(()=>{});
const cartBtn = page.getByRole("button", { name: /Open cart with/i }).first();
await cartBtn.click({ timeout: 8000 }).catch((e) => console.log("  (cart trigger)", String(e).split("\n")[0].slice(0,90)));
await page.getByTestId("offer-banner").waitFor({ timeout: 8000 }).catch(()=>{});
const banner2 = await page.getByTestId("offer-banner").innerText().catch(() => "(no offer banner in the drawer)");
say("the DRAWER banner", JSON.stringify(banner2.replace(/\s+/g, " ").slice(0, 200)));

// And the checkout, which is the last thing they see before paying.
await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const checkout = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
console.log("\n  CHECKOUT TEXT:", checkout.slice(0, 1400));

const quote = await page.evaluate(async () => {
  const r = await fetch("/api/checkout/quote", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "bea3052e-b65e-4cb7-a278-3707fda38f0a", quantity: 2 }] }),
  });
  const j = await r.json().catch(() => null);
  return j ? {
    subtotal: j.subtotal, total: j.total,
    offer: j.offer ?? null,
    offerShortfallCents: j.offerShortfallCents ?? null,
    offerWithdrawnBy: j.offerWithdrawnBy ?? null,
    discountLines: (j.discounts ?? j.discountLines ?? []).map((d) => d.label ?? d.name ?? d),
    reason: j.reason ?? null,
    keys: Object.keys(j).slice(0, 24),
  } : null;
});
say("what the till says", JSON.stringify(quote));
await browser.close(); await pool.end();
