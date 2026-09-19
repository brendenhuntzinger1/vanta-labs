// Does the event log still hold a spin token after the fix?
import { chromium } from "playwright";
import pg from "pg";
const BASE = "http://127.0.0.1:3000";
const pool = new pg.Pool({ connectionString: "postgres://postgres@localhost:55432/storefront" });
const EMAIL = "qa.verified@example.test";
const say = (l, v) => console.log(`  ${String(l).padEnd(46)} ${v}`);
const TOKEN = "v1.cWEudmVyaWZpZWRAZXhhbXBsZS50ZXN0.dGVzdA.1792367457196.deadbeefdeadbeefdeadbeefdeadbeef";

await pool.query("delete from website_analytics_events where page_url like '%deadbeef%' or page_url like '%REDACTED%'");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
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

// A page view carrying the token, exactly as an emailed winner produces one.
await page.goto(`${BASE}/products?t=${TOKEN}&utm_source=email&utm_campaign=winback`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
// And the access wall's nested form.
await page.goto(`${BASE}/products/semax?next=${encodeURIComponent(`/spin?t=${TOKEN}`)}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

const { rows } = await pool.query(
  "select page_url from website_analytics_events where page_url like '%t=%' or page_url like '%next=%' order by created_at desc limit 6");
say("rows the tracker wrote", String(rows.length));
for (const r of rows) say("  ", String(r.page_url).slice(0, 140));
const { rows: leak } = await pool.query(
  "select count(*)::int c from website_analytics_events where page_url like '%deadbeef%' or referrer like '%deadbeef%'");
say("rows still carrying the token", String(leak[0].c));
const { rows: utm } = await pool.query(
  "select count(*)::int c from website_analytics_events where page_url like '%utm_source=email%'");
say("rows that kept their utm tags", String(utm[0].c));
await browser.close(); await pool.end();
