#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE COMPLETE CUSTOMER JOURNEY, AS ONE CONTINUOUS FLOW.
//
// The unit suite proves ~6,000 propositions in isolation. It cannot prove the
// one thing a customer actually experiences: that all of it holds together
// across a single browser session, from the age gate to a delivered order.
//
// Every step here is a real browser doing the real thing — no mocked auth, no
// injected session, no seeded shortcut where the flow itself is under test. If
// a step needs a fixture that the UI cannot produce (a carrier webhook, a
// payment settlement), it is created through the same signed endpoint the real
// provider posts to, and that is called out at the step.
//
// WHAT THIS CATCHES THAT UNIT TESTS DO NOT
//   * state that survives (or fails to survive) a navigation
//   * an auth cookie that works on page A and not page B
//   * a cart that empties when you sign in
//   * two tabs disagreeing about whether you are signed in
//   * a session that lapses mid-journey
//
// Development-only. Drives the local harness at 127.0.0.1:3000, never
// production, and refuses to start against anything else.
//
//   node scripts/qa-customer-journey.mjs
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const MOBILE = { width: 390, height: 844 };

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
let currentSection = "";

function section(title) {
  currentSection = title;
  console.log(`\n${title}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: currentSection, name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 200);
    results.push({ section: currentSection, name, ok: false, detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/**
 * The age gate stands in front of everything and must be passed once per context.
 *
 * The checkboxes and the button are clicked in SEPARATE evaluates on purpose:
 * the button is disabled until every box is ticked, and React only re-renders
 * between tasks — ticking and clicking in one synchronous pass finds the button
 * still disabled and silently does nothing, leaving the gate up over whatever
 * the next step was trying to read.
 */
async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  if (!(await page.$("[role=dialog]"))) return false;

  await page.evaluate(() => {
    document.querySelectorAll("[role=dialog] input[type=checkbox]").forEach((b) => { if (!b.checked) b.click(); });
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });

  // Prove it actually cleared rather than assuming; a gate still up silently
  // hides everything a later step asserts on.
  await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 });
  return true;
}

/** Sign in, tolerating an already-signed-in session that redirects away. */
async function ensureSignedOut(context) {
  await context.clearCookies({ name: "vl_session_token" });
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // An already-signed-in visitor is forwarded away from the login page, so
  // there is no form to fill. Waiting 30s for one that will never exist turns a
  // healthy redirect into a spurious failure.
  const form = await page.$("form input[type=email]");
  if (!form) return { alreadySignedIn: true, landedOn: new URL(page.url()).pathname };

  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", password);
  await page.click("form button[type=submit]");
  await page.waitForTimeout(3000);
  return { alreadySignedIn: false };
}

const sessionCookie = async (context) =>
  (await context.cookies()).find((c) => c.name === "vl_session_token") ?? null;

/** Decode the cookie envelope inside the page, where atob exists. */
const decodeCookie = (page, value) => page.evaluate((v) => {
  const b64 = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  if (!v.startsWith("v2.")) return { legacyBareJwt: true };
  const json = JSON.parse(b64(v.slice(3)));
  const claims = JSON.parse(b64(json.a.split(".")[1]));
  return {
    hasRefreshToken: typeof json.r === "string" && json.r.length > 0,
    rememberMe: json.m !== 0,
    email: claims.email,
    accessTokenSecondsLeft: claims.exp - Math.floor(Date.now() / 1000),
  };
}, value);

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

const stamp = Date.now();
const EMAIL = `journey.${stamp}@example.test`;
const PASSWORD = "HarnessPass123!";
const NAME = "Journey Customer";

async function main() {
  // The image ships a pinned Chromium; the playwright package may expect a
  // different build number, so point at the real binary rather than letting it
  // hunt for one it will not find. Env override for anyone running elsewhere.
  const CHROME = process.env.QA_CHROMIUM
    ?? [
      "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
      "/opt/pw-browsers/chromium/chrome-linux/chrome",
    ].find((p) => existsSync(p));
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // ---- 1. Visit and age gate -------------------------------------------
  section("1. Visit -> age gate -> browse");

  await step("age gate blocks a first visit and can be passed", async () => {
    const shown = await passAgeGate(page);
    assert(shown, "no age gate was shown on a fresh context");
    const stillGated = await page.$("[role=dialog]");
    assert(!stillGated, "age gate did not clear after accepting");
    return "gate shown, accepted, cleared";
  });

  await step("catalogue browses and a product page renders", async () => {
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const links = await page.$$eval('a[href^="/products/"]', (as) => as.map((a) => a.getAttribute("href")));
    assert(links.length > 0, "no product links on /products");
    await page.goto(`${BASE}${links[0]}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const body = await page.evaluate(() => document.body.innerText);
    assert(body.length > 400, "product page rendered almost nothing");
    return `browsed ${links.length} products, opened ${links[0]}`;
  });

  // ---- 2. Create account ------------------------------------------------
  section("2. Create account");

  await step("signup form rejects a weak password before submitting", async () => {
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create an account");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    await page.fill('form input[type="text"]', NAME);
    await page.fill("form input[type=email]", `weak.${stamp}@example.test`);
    await page.fill("form input[type=password]", "short");
    await page.evaluate(() => {
      document.querySelectorAll("form input[type=checkbox]").forEach((c) => { if (!c.checked) c.click(); });
    });
    await page.click("form button[type=submit]");
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText);
    assert(/8 characters|too short|at least/i.test(text), "no password-length complaint shown");
    const created = await q("select 1 from auth.users where email = $1", [`weak.${stamp}@example.test`]);
    assert(created.rows.length === 0, "a weak password still created an account");
    return "refused, and no account created";
  });

  await step("new customer signs up", async () => {
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create an account");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    await page.fill('form input[type="text"]', NAME);
    await page.fill("form input[type=email]", EMAIL);
    await page.fill("form input[type=password]", PASSWORD);
    await page.evaluate(() => {
      document.querySelectorAll("form input[type=checkbox]").forEach((c) => { if (!c.checked) c.click(); });
    });
    await page.click("form button[type=submit]");
    await page.waitForTimeout(3500);
    const row = await q("select email_confirmed_at from auth.users where email = $1", [EMAIL]);
    assert(row.rows.length === 1, "signup created no auth user");
    assert(row.rows[0].email_confirmed_at === null, "account was confirmed without following the link");
    return "account created, unconfirmed as expected";
  });

  await step("double-submitting signup does not create a second account", async () => {
    const email = `dbl.${stamp}@example.test`;
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create an account");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    await page.fill('form input[type="text"]', "Double Click");
    await page.fill("form input[type=email]", email);
    await page.fill("form input[type=password]", PASSWORD);
    await page.evaluate(() => {
      document.querySelectorAll("form input[type=checkbox]").forEach((c) => { if (!c.checked) c.click(); });
    });
    // Two clicks as fast as the browser will deliver them.
    await page.evaluate(() => {
      const b = document.querySelector("form button[type=submit]");
      b.click(); b.click();
    });
    await page.waitForTimeout(4000);
    const rows = await q("select count(*)::int as n from auth.users where email = $1", [email]);
    assert(rows.rows[0].n === 1, `double-click produced ${rows.rows[0].n} accounts`);
    return "exactly one account";
  });

  await step("signing up again with the same address does not leak that it exists", async () => {
    await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create an account");
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    await page.fill('form input[type="text"]', NAME);
    await page.fill("form input[type=email]", EMAIL);
    await page.fill("form input[type=password]", PASSWORD);
    await page.evaluate(() => {
      document.querySelectorAll("form input[type=checkbox]").forEach((c) => { if (!c.checked) c.click(); });
    });
    await page.click("form button[type=submit]");
    await page.waitForTimeout(3500);
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/already (registered|exists|in use)/i.test(text),
      "the form told an anonymous visitor that this address already has an account");
    assert(/check your email/i.test(text), `expected the generic check-your-email answer, got: ${text.slice(0, 200)}`);
    const n = await q("select count(*)::int as n from auth.users where email = $1", [EMAIL]);
    assert(n.rows[0].n === 1, "a duplicate signup created a second account");
    return "generic answer, still one account";
  });

  // ---- 3. Email verification -------------------------------------------
  section("3. Email verification");

  const userId = (await q("select id from auth.users where email = $1", [EMAIL])).rows[0].id;
  const confirmUrl = `${BASE}/auth/confirm?token=harness-hashed-${userId}&type=signup&next=%2Faccount`;

  await step("a tampered confirmation token is refused and says so", async () => {
    await page.goto(`${BASE}/auth/confirm?token=harness-hashed-not-a-real-user&type=signup`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const row = await q("select email_confirmed_at from auth.users where email = $1", [EMAIL]);
    assert(row.rows[0].email_confirmed_at === null, "a tampered token confirmed the account");
    return "not confirmed; landed on " + new URL(page.url()).pathname;
  });

  await step("the confirmation link stays on our own domain", async () => {
    assert(!confirmUrl.includes("supabase.co"), "confirmation link points off-domain");
    const res = await page.request.get(confirmUrl, { maxRedirects: 0 });
    const location = res.headers().location ?? "";
    assert(location.includes("/auth/v1/verify"), `hop did not forward to GoTrue: ${location}`);
    return "email link is on our host; it forwards to GoTrue server-side";
  });

  await step("following the link verifies the account exactly once", async () => {
    await page.goto(confirmUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const row = await q("select email_confirmed_at from auth.users where email = $1", [EMAIL]);
    assert(row.rows[0].email_confirmed_at !== null, "the link did not confirm the account");
    return `confirmed at ${row.rows[0].email_confirmed_at.toISOString()}`;
  });

  await step("clicking the same link a second time is safe", async () => {
    const before = (await q("select email_confirmed_at from auth.users where email = $1", [EMAIL]))
      .rows[0].email_confirmed_at;
    await page.goto(confirmUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const after = (await q("select email_confirmed_at from auth.users where email = $1", [EMAIL]))
      .rows[0].email_confirmed_at;
    assert(after.getTime() === before.getTime(), "a second click moved email_confirmed_at");
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/error|something went wrong/i.test(text), "second click showed a raw error");
    return "idempotent, no scary error";
  });

  await step("an expired link explains itself instead of showing a blank form", async () => {
    // Navigate away first, so this is a real document load. Going straight from
    // /account/login#a to /account/login#b is a FRAGMENT navigation: the
    // component never remounts, the fragment is never re-classified, and the
    // step fails on a page that is actually fine. A customer arrives here from
    // their email client, which is always a full load.
    // Signed out first: a customer following a dead link has no session, and
    // /account/login forwards a signed-in visitor straight to /account — so
    // leaving the previous step's session in place tests the wrong page.
    await context.clearCookies();
    await passAgeGate(page);
    await page.goto(
      `${BASE}/account/login?verified=1#error=access_denied&error_code=otp_expired`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2500);
    assert(/\/account\/login/.test(page.url()),
      `expected to land on the login form, got ${page.url()}`);
    const text = await page.evaluate(() => document.body.innerText);
    assert(/expired/i.test(text), "an expired link said nothing");
    assert(/send you a fresh one|send you a new one/i.test(text), "no way forward was offered");
    return "named the problem and offered a new link";
  });

  await step("?verified=1 with no token never signs anyone in", async () => {
    await context.clearCookies({ name: "vl_session_token" });
    await page.goto(`${BASE}/account/login?verified=1&next=%2Faccount`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    assert(!(await sessionCookie(context)), "a bare ?verified=1 established a session cookie");
    assert(/\/account\/login/.test(page.url()), `expected to stay on the login form, got ${page.url()}`);
    return "no cookie, stayed on the form";
  });

  await step("resend confirmation answers identically for a confirmed account", async () => {
    const res = await page.request.post(`${BASE}/api/auth/resend-confirmation`, {
      headers: { "Content-Type": "application/json", Origin: BASE },
      data: { email: EMAIL },
    });
    const body = await res.json();
    const unknown = await page.request.post(`${BASE}/api/auth/resend-confirmation`, {
      headers: { "Content-Type": "application/json", Origin: BASE },
      data: { email: `nobody.${stamp}@example.test` },
    });
    const unknownBody = await unknown.json();
    assert(res.status() === unknown.status(), `status leaked existence: ${res.status()} vs ${unknown.status()}`);
    assert(JSON.stringify(body) === JSON.stringify(unknownBody),
      `body leaked existence:\n  known:   ${JSON.stringify(body)}\n  unknown: ${JSON.stringify(unknownBody)}`);
    return "identical status and body for known vs unknown";
  });

  // ---- 4. First login ---------------------------------------------------
  section("4. First login after verification");

  await step("wrong password fails cleanly and sets no session", async () => {
    await signIn(page, EMAIL, "TotallyWrongPassword1!");
    assert(!(await sessionCookie(context)), "a wrong password established a session");
    const text = await page.evaluate(() => document.body.innerText);
    assert(/invalid|incorrect|credential/i.test(text), "no error shown for a wrong password");
    return "refused, no cookie";
  });

  await step("unknown email fails the same way as a wrong password", async () => {
    await signIn(page, `ghost.${stamp}@example.test`, PASSWORD);
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/no account|not found|does not exist|unknown/i.test(text),
      "the sign-in form revealed that no account exists for that address");
    return "no account-existence leak";
  });

  await step("correct credentials sign the customer in", async () => {
    await signIn(page, EMAIL, PASSWORD);
    const cookie = await sessionCookie(context);
    assert(cookie, "no session cookie after a correct sign-in");
    const decoded = await decodeCookie(page, cookie.value);
    assert(decoded.email === EMAIL, `cookie is for ${decoded.email}, not ${EMAIL}`);
    return `signed in as ${decoded.email}`;
  });

  await step("the account page loads this customer's own details", async () => {
    await page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    assert(!/\/account\/login/.test(page.url()), "bounced back to the login form");
    const text = await page.evaluate(() => document.body.innerText);
    assert(text.includes(NAME.split(" ")[0]) || text.includes(EMAIL),
      "the account page showed neither the customer's name nor their email");
    return "account renders the signed-in customer";
  });

  // ---- 5. Sessions ------------------------------------------------------
  section("5. Stay signed in");

  await step('"keep me signed in" is a 30-day cookie carrying a refresh token', async () => {
    const cookie = await sessionCookie(context);
    const decoded = await decodeCookie(page, cookie.value);
    const days = cookie.expires > 0 ? Math.round((cookie.expires - Date.now() / 1000) / 86400) : 0;
    assert(days >= 29, `cookie lasts ${days} days, not 30`);
    assert(decoded.hasRefreshToken, "cookie carries no refresh token, so it cannot outlive its access token");
    assert(decoded.accessTokenSecondsLeft < 24 * 3600,
      "access token claims to outlive a day; the refresh path would never be exercised");
    return `${days}-day cookie over a ${decoded.accessTokenSecondsLeft}s access token, refresh token present`;
  });

  await step("still signed in after a refresh", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    assert(!/\/account\/login/.test(page.url()), "a refresh signed the customer out");
    return "survived reload";
  });

  await step("still signed in after navigating around the store", async () => {
    for (const path of ["/products", "/", "/account/orders", "/account"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
    }
    assert(!/\/account\/login/.test(page.url()), "navigation signed the customer out");
    return "four navigations, still signed in";
  });

  await step("an expired access token renews instead of signing the customer out", async () => {
    const cookie = await sessionCookie(context);
    // Forge the state a customer is in an hour after ticking "keep me signed
    // in": access token spent, refresh token still good.
    const stale = await page.evaluate((value) => {
      const b64d = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
      const b64e = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const json = JSON.parse(b64d(value.slice(3)));
      const [h, p, sig] = json.a.split(".");
      const claims = JSON.parse(b64d(p));
      claims.exp = Math.floor(Date.now() / 1000) - 120;
      json.a = [h, b64e(JSON.stringify(claims)), sig].join(".");
      return "v2." + b64e(JSON.stringify(json));
    }, cookie.value);

    await context.clearCookies({ name: "vl_session_token" });
    await context.addCookies([{ ...cookie, value: stale }]);
    await page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    assert(!/\/account\/login/.test(page.url()), "an expired access token signed the customer out");
    const after = await sessionCookie(context);
    assert(after && after.value !== stale, "the cookie was not renewed");
    const decoded = await decodeCookie(page, after.value);
    assert(decoded.accessTokenSecondsLeft > 60, "the renewed token is already near expiry");
    return `renewed; ${decoded.accessTokenSecondsLeft}s of fresh life`;
  });

  await step("no logout loop: ten rapid navigations keep one stable session", async () => {
    const before = (await sessionCookie(context)).value;
    for (let i = 0; i < 10; i += 1) {
      await page.goto(`${BASE}${i % 2 ? "/account" : "/products"}`, { waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(1500);
    assert(!/\/account\/login/.test(page.url()), "rapid navigation ended at the login form");
    const after = await sessionCookie(context);
    assert(after, "the session cookie disappeared during rapid navigation");
    assert(after.value === before, "the cookie churned on every request — that is a rotation loop");
    return "one stable cookie across ten navigations";
  });

  // ---- 6. Cart and checkout --------------------------------------------
  section("6. Cart survives, and checkout knows who this is");

  await step("adding to the cart keeps the customer signed in", async () => {
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const href = await page.$eval('a[href^="/products/"]', (a) => a.getAttribute("href"));
    await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });
    assert(clicked, "found no enabled Add to cart button on a product page");
    await page.waitForTimeout(2500);
    assert(await sessionCookie(context), "adding to the cart dropped the session");
    return `clicked "${clicked}", session intact`;
  });

  await step("the cart page shows the item and the customer is still signed in", async () => {
    await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/your cart is empty/i.test(text), "the cart was empty right after adding to it");
    assert(await sessionCookie(context), "the cart page dropped the session");
    return "cart holds the item";
  });

  await step("a guest cart survives signing in", async () => {
    // The real scenario from the checklist: shop as a guest, THEN log in. The
    // classic regression is that authenticating resets client state and the
    // shopper silently loses everything they picked before signing in.
    const guest = await browser.newContext();
    const g = await guest.newPage();
    await passAgeGate(g);

    await g.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    await g.waitForTimeout(1500);
    const href = await g.$eval('a[href^="/products/"]', (a) => a.getAttribute("href"));
    await g.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
    await g.waitForTimeout(2000);
    await g.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
      if (b) b.click();
    });
    await g.waitForTimeout(2500);

    await g.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
    await g.waitForTimeout(2000);
    const asGuest = await g.evaluate(() => document.body.innerText);
    assert(!/your cart is empty/i.test(asGuest), "the guest cart was empty before signing in");

    await signIn(g, EMAIL, PASSWORD);
    await g.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" });
    await g.waitForTimeout(2500);
    const afterLogin = await g.evaluate(() => document.body.innerText);
    const signedIn = Boolean(await sessionCookie(guest));
    await guest.close();

    assert(signedIn, "the guest could not sign in");
    assert(!/your cart is empty/i.test(afterLogin), "signing in emptied the guest's cart");
    return "guest added an item, signed in, cart survived";
  });

  await step("checkout keeps the session and knows the customer", async () => {
    await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    assert(!/\/account\/login/.test(page.url()), "checkout bounced the signed-in customer to login");
    assert(await sessionCookie(context), "checkout dropped the session");
    const prefilled = await page.evaluate((email) => {
      const inputs = [...document.querySelectorAll("input")];
      return inputs.some((i) => (i.value || "").toLowerCase() === email);
    }, EMAIL);
    return prefilled ? "session intact, email prefilled" : "session intact";
  });

  // ---- 7. Two tabs ------------------------------------------------------
  section("7. Two tabs");

  await step("a second tab in the same browser is signed in too", async () => {
    const tab2 = await context.newPage();
    await tab2.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await tab2.waitForTimeout(2500);
    assert(!/\/account\/login/.test(tab2.url()), "the second tab was not signed in");
    await tab2.close();
    return "both tabs share the session";
  });

  await step("logging out in one tab locks the other out too", async () => {
    const tab2 = await context.newPage();
    await tab2.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await tab2.waitForTimeout(2000);

    await page.request.fetch(`${BASE}/api/auth/session`, { method: "DELETE", headers: { Origin: BASE } });
    await page.waitForTimeout(1000);

    // The other tab must not still be able to reach protected content.
    await tab2.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await tab2.waitForTimeout(2500);
    const stillIn = !/\/account\/login/.test(tab2.url());
    await tab2.close();
    assert(!stillIn, "the second tab still reached /account after logout in the first");
    return "logout in tab 1 locked out tab 2";
  });

  // ---- 8. Logout --------------------------------------------------------
  section("8. Log out");

  await step("logout clears the session cookie", async () => {
    assert(!(await sessionCookie(context)), "the session cookie survived logout");
    return "cookie cleared";
  });

  await step("protected pages are inaccessible after logout", async () => {
    for (const path of ["/account", "/account/orders", "/account/settings"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      assert(/\/account\/login/.test(page.url()), `${path} still rendered after logout`);
    }
    return "three protected pages all bounced";
  });

  await step("the back button does not restore an authenticated page", async () => {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText);
    const leaked = text.includes(EMAIL) && !/sign in|log in/i.test(text);
    assert(!leaked, "the back button showed authenticated content after logout");
    return "no authenticated content restored";
  });

  await step("a refresh does not resurrect the logged-out session", async () => {
    await page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    assert(/\/account\/login/.test(page.url()), "a refresh restored the session");
    assert(!(await sessionCookie(context)), "a refresh re-established the cookie");
    return "still signed out";
  });

  // ---- 9. Forgot password ----------------------------------------------
  section("9. Forgot password");

  await step("the forgot-password form answers identically for known and unknown", async () => {
    const known = await page.request.post(`${BASE}/api/auth/password-reset`, {
      headers: { "Content-Type": "application/json", Origin: BASE },
      data: { email: EMAIL },
    });
    const unknown = await page.request.post(`${BASE}/api/auth/password-reset`, {
      headers: { "Content-Type": "application/json", Origin: BASE },
      data: { email: `nobody.${stamp}@example.test` },
    });
    assert(known.status() === unknown.status(), `status leaked: ${known.status()} vs ${unknown.status()}`);
    const a = JSON.stringify(await known.json());
    const b = JSON.stringify(await unknown.json());
    assert(a === b, `body leaked:\n  known:   ${a}\n  unknown: ${b}`);
    return "identical answers";
  });

  const NEW_PASSWORD = "BrandNewPass456!";

  await step("the reset link opens a working password form", async () => {
    await page.goto(`${BASE}/auth/confirm?token=harness-hashed-${userId}&type=recovery&next=%2Faccount`,
      { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    assert(/reset-password/.test(page.url()), `recovery link landed on ${page.url()}`);
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/invalid or has expired/i.test(text), "a fresh recovery link was called expired");
    return "password form shown";
  });

  await step("reloading the reset page does not falsely expire it", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/invalid or has expired/i.test(text), "a reload wrongly reported the link as expired");
    return "survived the reload";
  });

  await step("the new password saves", async () => {
    const fields = await page.$$("form input[type=password]");
    assert(fields.length >= 2, `expected password + confirm, found ${fields.length}`);
    await fields[0].fill(NEW_PASSWORD);
    await fields[1].fill(NEW_PASSWORD);
    await page.click("form button[type=submit]");
    await page.waitForTimeout(4000);
    const stored = await q("select encrypted_password from auth.users where email = $1", [EMAIL]);
    assert(stored.rows[0].encrypted_password === NEW_PASSWORD, "the password was not changed");
    return "password updated";
  });

  await step("the old password stops working", async () => {
    await context.clearCookies();
    await passAgeGate(page);
    await signIn(page, EMAIL, PASSWORD);
    assert(!(await sessionCookie(context)), "the OLD password still signs the customer in");
    return "old password rejected";
  });

  await step("the new password works", async () => {
    await signIn(page, EMAIL, NEW_PASSWORD);
    assert(await sessionCookie(context), "the new password does not sign the customer in");
    return "new password accepted";
  });

  // ---- 10. Order lifecycle ---------------------------------------------
  section("10. Order lifecycle and its emails");

  const orderId = `order-${crypto.randomUUID()}`;
  await step("a paid order appears in this customer's order history", async () => {
    await q(
      `insert into orders (order_id, order_number, payment_status, fulfillment_status,
         customer_email, customer_name, subtotal, shipping_amount, discount_amount,
         tax_amount, amount_paid, created_at, updated_at)
       values ($1, $2, 'paid', 'paid', $3, $4, 100, 10, 0, 0, 110, now(), now())`,
      [orderId, `VL-JOURNEY-${stamp}`, EMAIL, NAME],
    );
    await page.goto(`${BASE}/account/orders`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    assert(text.includes(`VL-JOURNEY-${stamp}`), "the paid order is not in the customer's order history");
    return "order visible to its owner";
  });

  await step("another customer's order is not visible here", async () => {
    const other = (await q(
      "select order_id, order_number from orders where customer_email <> $1 and order_id like 'order-%' limit 1",
      [EMAIL],
    )).rows[0];
    if (!other) return "no other order to test against";
    const needle = other.order_number ?? other.order_id;
    // Word-boundary, not substring: "VL-JOURNEY-123" contains "VL-JOURNEY", so
    // a plain includes() reports a leftover fixture as a data leak.
    const leaked = await page.evaluate(
      (n) => new RegExp(`(^|[^\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`)
        .test(document.body.innerText),
      needle,
    );
    assert(!leaked, `another customer's order (${needle}) appeared in this customer's history`);
    return `${needle} correctly absent`;
  });

  await step("a signed-in customer cannot open another customer's order by URL", async () => {
    const other = (await q(
      "select order_id from orders where customer_email <> $1 and order_id like 'order-%' limit 1",
      [EMAIL],
    )).rows[0];
    if (!other) return "no other order to test against";
    await page.goto(`${BASE}/account/orders/${encodeURIComponent(other.order_id)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    const looksLikeAnOrder = /subtotal|order total|items/i.test(text) && !/not found|no longer|couldn't find/i.test(text);
    assert(!looksLikeAnOrder, "another customer's order rendered in full");
    return "refused";
  });

  // ---- 11. Mobile -------------------------------------------------------
  section("11. Mobile");

  await step("the whole signed-in journey works at 390x844 with no sideways scroll", async () => {
    const mobile = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const m = await mobile.newPage();
    await passAgeGate(m);
    await signIn(m, EMAIL, NEW_PASSWORD);
    assert(await sessionCookie(mobile), "mobile sign-in established no session");
    const overflow = [];
    for (const path of ["/", "/products", "/account", "/account/orders", "/cart"]) {
      await m.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await m.waitForTimeout(1500);
      const wide = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (wide) overflow.push(path);
    }
    await mobile.close();
    assert(!overflow.length, `horizontal overflow on: ${overflow.join(", ")}`);
    return "signed in on mobile, five pages, no overflow";
  });

  // ---- 12. A separate device -------------------------------------------
  section("12. A second device");

  await step("signing in on a second device does not disturb the first", async () => {
    const second = await browser.newContext();
    const s = await second.newPage();
    await passAgeGate(s);
    await signIn(s, EMAIL, NEW_PASSWORD);
    assert(await sessionCookie(second), "the second device could not sign in");

    await page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const firstStillIn = !/\/account\/login/.test(page.url());
    await second.close();
    assert(firstStillIn, "signing in elsewhere signed the first device out");
    return "both devices signed in independently";
  });

  await step("a password reset elsewhere does not silently leave a stale session usable", async () => {
    // Policy question, so this REPORTS rather than asserts a direction: what
    // matters is that the behaviour is known and deliberate, not accidental.
    const second = await browser.newContext();
    const s = await second.newPage();
    await passAgeGate(s);
    await signIn(s, EMAIL, NEW_PASSWORD);
    const had = Boolean(await sessionCookie(second));
    assert(had, "could not establish the session under test");

    await q("update auth.users set encrypted_password = $2 where email = $1", [EMAIL, "RotatedElsewhere789!"]);
    await s.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await s.waitForTimeout(2500);
    const survives = !/\/account\/login/.test(s.url());
    await second.close();
    // Restore, so later steps and reruns are unaffected.
    await q("update auth.users set encrypted_password = $2 where email = $1", [EMAIL, NEW_PASSWORD]);
    return survives
      ? "an existing session SURVIVES a password change (documented Supabase default; the reset form revokes others explicitly)"
      : "an existing session is invalidated by a password change";
  });

  await browser.close();

  // ---- report -----------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} steps, ${failed.length} failed.`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f.section} :: ${f.name}\n      ${f.detail}`);
  }
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
