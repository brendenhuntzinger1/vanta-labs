// Do the two checkout lanes agree about a wheel prize?
//
// WITHOUT SUBMITTING A CHARGE. Both calls below are PRICING calls: the normal
// lane's /api/checkout/quote and the express lane's /api/checkout/express/session,
// which mints an intent and asks the wallet for nothing. No authorize, no
// payment, no order. The intent ages out on its own.
//
// What is compared is the AUTHORITATIVE answer — the gift the server resolved,
// its product, its variant and the minimum it enforced — not a rendered string.
import { chromium } from "playwright";

const BASE = process.env.PARITY_BASE ?? "http://127.0.0.1:3000";
const EMAIL = process.env.PARITY_EMAIL ?? "qa.verified@example.test";
const PASSWORD = process.env.PARITY_PASSWORD ?? "HarnessPass123!";
const say = (l, v) => console.log(`  ${String(l).padEnd(42)} ${v}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
  ...(process.env.HTTPS_PROXY && BASE.startsWith("https") ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();

await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => { try { localStorage.setItem("vl_cookie_consent", "accepted"); localStorage.setItem("vl_age_attested", "true"); } catch {} });
await page.getByRole("checkbox", { name: /21 years/i }).check().catch(() => {});
await page.getByRole("checkbox", { name: /research use/i }).check().catch(() => {});
await page.getByRole("button", { name: /Sign in with email/i }).click().catch(() => {});
await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
await page.getByRole("textbox", { name: /Password/ }).fill(PASSWORD);
await page.getByRole("button", { name: /^Sign In$/ }).click();
await page.waitForURL((u) => !/\/account\/login/.test(u.toString()), { timeout: 25000 });

const held = await page.evaluate(async () => (await (await fetch("/api/offer/status", { credentials: "same-origin" })).json()));
say("prize this session holds", JSON.stringify(held?.offer ?? null));
if (!held?.offer) {
  console.log("\n  NO LIVE PRIZE — parity cannot be measured without one.");
  await browser.close();
  process.exit(0);
}

const items = JSON.parse(process.env.PARITY_ITEMS ?? "[]");
if (!items.length) { console.log("\n  PARITY_ITEMS not set."); await browser.close(); process.exit(0); }

// LANE 1 — the normal checkout's own pricing call.
const normal = await page.evaluate(async (cart) => {
  const r = await fetch("/api/checkout/quote", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart, country: "United States", state: "TX" }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, ok: j?.ok ?? false, reason: j?.reason ?? null,
    offer: j?.quote?.offer ?? j?.offer ?? null,
    giftLines: j?.quote?.giftLines ?? null,
    shortfall: j?.quote?.offerShortfallCents ?? j?.offerShortfallCents ?? null,
    subtotal: j?.quote?.subtotal ?? null };
}, items);
say("normal lane offer", JSON.stringify(normal.offer));
say("normal lane gift line", JSON.stringify(normal.giftLines));
say("normal lane shortfall (cents)", String(normal.shortfall));

// LANE 2 — the express sheet's pricing call. Mints an intent; charges nothing.
const express = await page.evaluate(async (cart) => {
  const r = await fetch("/api/checkout/express/session", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart, shippingProtection: false,
      acknowledgements: { research: true, returns: true } }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j ?? text.slice(0, 260) };
}, items);
say("express lane status", String(express.status));
say("express lane body", JSON.stringify(express.body).slice(0, 320));

await browser.close();
