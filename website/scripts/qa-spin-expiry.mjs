// The 72-hour promise, from both ends: what the customer is told, and what the
// server does at the boundary.
import { chromium } from "playwright";
import pg from "pg";
const BASE = "http://127.0.0.1:3000";
const pool = new pg.Pool({ connectionString: "postgres://postgres@localhost:55432/storefront" });
const EMAIL = "qa.verified@example.test";
const say = (label, value) => console.log(`  ${label.padEnd(52)} ${value}`);

await pool.query("delete from customer_offers where email=$1", [EMAIL]);
await pool.query("delete from rate_limit_hits where bucket like 'welcome-offer%' or bucket like 'spin%'");

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

console.log("\n1. what the customer is told when the prize is won");
await page.goto(`${BASE}/spin`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Spin the wheel/i }).click();
await page.waitForFunction(() => /Expires in|Expired/i.test(document.body.innerText), { timeout: 40000 });
const panel = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
const shown = panel.match(/Expires in\s*([^A-Z]{0,24})/i)?.[1]?.trim() ?? "(not found)";
say("the wheel states a deadline", JSON.stringify(shown));
const { rows: minted } = await pool.query(
  "select reward_kind, product_slug, issued_at, expires_at, extract(epoch from (expires_at - issued_at))*1000 as span_ms from customer_offers where email=$1", [EMAIL]);
say("prize minted", `${minted[0].reward_kind}/${minted[0].product_slug ?? "-"}`);
say("expires_at - issued_at, in ms", minted[0].span_ms);
say("that is exactly 72 hours", String(Number(minted[0].span_ms) === 259200000));

console.log("\n2. inside the window: 90 seconds left");
await pool.query("update customer_offers set expires_at = now() + interval '90 seconds' where email=$1", [EMAIL]);
await page.goto(`${BASE}/spin`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const near = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
say("the wheel still shows a live countdown", JSON.stringify(near.match(/Expires in\s*([^A-Z]{0,20})/i)?.[1]?.trim() ?? "(none)"));
say("and does NOT say Expired", String(!/Expired/i.test(near)));
const q1 = await page.evaluate(async () => {
  const r = await fetch("/api/offer/status", { credentials: "same-origin" });
  return { status: r.status, body: (await r.text()).slice(0, 180) };
});
say("/api/offer/status inside the window", `${q1.status} ${q1.body}`);

console.log("\n3. one second past the boundary");
await pool.query("update customer_offers set expires_at = now() - interval '1 second' where email=$1", [EMAIL]);
await page.goto(`${BASE}/spin`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const past = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
say("the wheel says Expired", String(/Expired/i.test(past)));
const q2 = await page.evaluate(async () => {
  const r = await fetch("/api/offer/status", { credentials: "same-origin" });
  return { status: r.status, body: (await r.text()).slice(0, 180) };
});
say("/api/offer/status past the boundary", `${q2.status} ${q2.body}`);
const q3 = await page.evaluate(async () => {
  const r = await fetch("/api/checkout/quote", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ slug: "glp-1", quantity: 4 }] }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, offer: j?.offer ?? j?.offerLabel ?? null, discount: j?.discountCents ?? j?.discount ?? null, keys: j ? Object.keys(j).slice(0, 14) : [] };
});
say("/api/checkout/quote past the boundary", JSON.stringify(q3));

await browser.close(); await pool.end();
