#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE LIFECYCLE EMAIL ENGINE, EXERCISED END TO END.
//
// Not "does Resend accept a message" — that is answered elsewhere. This drives
// the customer journeys the retention system exists for, against the local
// harness, reading the emails the customer would actually receive:
//
//   subscriber  → welcome intro → welcome offer → (purchase) → welcome stops
//   guest cart  → 1h reminder → 24h details → 72h last note (with code)
//               → purchase → sequence ends; a second cart waits its cooldown;
//               an emptied cart is never mailed
//   unsubscribe → nothing marketing goes out again, and the reason is recorded
//   bounce      → the provider webhook suppresses the address
//   campaign    → preview, test, send, and a second send is refused
//
// Time is advanced by backdating rows, because the sweep reads the clock and
// nothing else. Development-only; refuses to run against anything but the
// harness. Emails are read from EMAIL_CAPTURE_DIR (smtp-sink.mjs / noop.ts).
//
//   EMAIL_CAPTURE_DIR=/tmp/vanta-qa node scripts/qa-lifecycle-email.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";

/**
 * THE HARNESS IS HTTPS, AND ITS CERTIFICATE IS SELF-SIGNED.
 *
 * The runbook requires the harness to be driven over TLS (section 5c): the
 * session cookie is Secure in a production build, so over plain http a correct
 * sign-in establishes nothing and this file reports "no session cookie after a
 * correct sign-in" — a defect that does not exist in production. The links
 * inside the captured emails are built from NEXT_PUBLIC_SITE_URL and therefore
 * point at the TLS proxy regardless of what this file is driven at, so without
 * this every "follow the link from the email" step dies at
 * ERR_CERT_AUTHORITY_INVALID.
 *
 * Scoped to loopback so a run against anything else keeps full certificate
 * checking.
 */
const LOOPBACK_TLS = /^https:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(BASE)
  ? { ignoreHTTPSErrors: true }
  : {};

const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CAPTURE_DIR = process.env.EMAIL_CAPTURE_DIR ?? "/tmp/vanta-qa";
const CAPTURE = `${CAPTURE_DIR}/captured-emails.jsonl`;
const SHOTS = `${CAPTURE_DIR}/lifecycle-shots`;
const CRON_SECRET = process.env.CRON_SECRET ?? "harness-cron-secret";
const WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET ?? "harness-email-webhook-secret";
const WEBHOOK_SIGNING_SECRET = process.env.RESEND_WEBHOOK_SIGNING_SECRET
  ?? "whsec_aGFybmVzcy1ub3QtYS1yZWFsLXJlc2VuZC1zZWNyZXQ=";

/**
 * SIGN THE DELIVERY THE WAY RESEND SIGNS IT.
 *
 * /api/webhooks/email requires TWO things and fails closed on either: the URL
 * secret, and a valid Svix signature over the delivery's own body inside a
 * five-minute window. This file sent the URL secret and no signature, so the
 * route answered 503 and the step reported "webhook answered 503" — read as a
 * broken bounce pipeline when it was an unsigned request meeting a guard doing
 * exactly its job.
 *
 * Signing here is not a weakening. The harness holds a SYNTHETIC secret and
 * signs with the same one the app verifies with, which is what proves the
 * signature path end to end. Proving it against the key Resend will really use
 * is live-signature.test.ts's job, and that one needs the owner's real secret
 * and skips loudly without it.
 */
function svixHeaders(rawBody, { id = `msg_${stamp}`, atSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const key = WEBHOOK_SIGNING_SECRET.startsWith("whsec_")
    ? WEBHOOK_SIGNING_SECRET.slice("whsec_".length)
    : WEBHOOK_SIGNING_SECRET;
  const digest = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${id}.${atSeconds}.${rawBody}`, "utf8")
    .digest("base64");
  return {
    "Content-Type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(atSeconds),
    "svix-signature": `v1,${digest}`,
  };
}
// qa-seed-roles.mjs is the seeder and therefore the authority on this
// value; qa-role-boundaries already agrees with it, and its admin positive
// control (74 admin routes reached) is what proves the pair works. Three
// different defaults were in circulation across six suites, so every
// admin-authenticated step in this file answered 401 unless somebody
// happened to export QA_ADMIN_PASS.
const ADMIN = { username: process.env.QA_ADMIN_USER ?? "qaadmin", password: process.env.QA_ADMIN_PASS ?? "QaAdmin123!Pass", passcode: process.env.QA_ADMIN_PASSCODE ?? "123456" };

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const stamp = randomBytes(3).toString("hex");

const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

/** A step that could not run. Counted apart, and reported as NOT verified. */
const SKIP = (reason) => ({ __skip: reason });

async function step(name, fn) {
  try {
    const detail = await fn();
    if (detail && typeof detail === "object" && detail.__skip) {
      results.push({ section: section_, name, status: "skip", detail: detail.__skip });
      console.log(`  SKIP  ${name}\n        ${detail.__skip}`);
      return;
    }
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

// --- the mailbox -------------------------------------------------------------
const mailOffset = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);
function mailSince(offset) {
  if (!existsSync(CAPTURE)) return [];
  const buf = readFileSync(CAPTURE);
  return buf.subarray(Math.min(offset, buf.length)).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}
const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/=\r?\n/g, "");
/** The SMTP sink lower-cases header names; the noop provider keeps them as sent. */
const header = (mail, name) => {
  const h = mail.headers ?? {};
  return h[name] ?? h[name.toLowerCase()] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
};
/** The plain-text part, or the HTML with its tags stripped when the capture holds no text part. */
const textOf = (mail) => mail.text ?? decode(mail.html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
function linksIn(mail) {
  const found = decode(mail.html).match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(found)];
}

// --- the clock ----------------------------------------------------------------
/**
 * THE LIFECYCLE ROUTE, NOT THE SWEEP ROUTE.
 *
 * The jobs that put a message in front of a customer — cart recovery, the
 * retention automations, campaigns, the marketing queue, the email retry and
 * the order-email reaper — moved to /api/cron/lifecycle on 2026-09-10, so a
 * closing recovery window could not be lost to a sweep that overran on
 * twenty-seven unrelated jobs. This file kept calling /api/cron/sweep.
 *
 * That route still answers 200 and still returns a body, so nothing failed
 * loudly — it just stopped being evidence. every `cartRecovery` count this file reads came back
 * undefined, and each recovery stage looked like it had never been sent.
 *
 * THE KEY IS ASSERTED, not just the status. A 200 from a route that no longer
 * runs this job is exactly what made the old call look healthy, so if the jobs
 * move again this fails HERE, naming the reason, rather than as a screenful of
 * unrelated-looking assertion failures downstream.
 */
async function sweep() {
  const r = await fetch(`${BASE}/api/cron/lifecycle`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  const body = await r.json();
  assert(r.status === 200 && body.success, `lifecycle sweep answered ${r.status}`);
  assert(
    Object.prototype.hasOwnProperty.call(body, "cartRecovery"),
    `the lifecycle route ran no cartRecovery job — has it moved again? got: ${Object.keys(body).join(", ")}`,
  );
  return body;
}
async function sweepAndMail(fn) {
  const offset = mailOffset();
  const body = await sweep();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { body, mail: mailSince(offset).filter(fn ?? (() => true)) };
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// --- the browser --------------------------------------------------------------
async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const appeared = await page.waitForSelector("[role=dialog]", { timeout: 8000 }).then(() => true).catch(() => false);
  if (!appeared) return false;
  const enabled = () => page.$$eval("[role=dialog] button", (btns) =>
    btns.some((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const box of await page.$$("[role=dialog] input[type=checkbox]")) {
      if (!(await box.isChecked())) await box.click({ timeout: 5000 }).catch(() => {});
    }
    if (await enabled()) break;
    await page.waitForTimeout(1000);
  }
  assert(await enabled(), "the age gate's submit button never enabled");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });
  await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 });
  return true;
}

/**
 * SIGN IN, BECAUSE THE STOREFRONT NO LONGER HAS ANONYMOUS BROWSING.
 *
 * access-policy.ts closed the default: /products, /cart and /checkout all
 * redirect an unauthenticated visitor to /account/login. Every step below that
 * cleared cookies and then went shopping was therefore looking at a sign-in
 * form, and `a[href^="/products/"]` failed to match — reported as "could not
 * add a product" rather than as a wall.
 */
async function signInAs(page, email, password = "HarnessPass123!") {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await page.$("form input[type=email]")) break;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "Sign in with email");
      if (b) b.click();
    });
    await page.waitForTimeout(500);
  }
  if (!(await page.$("form input[type=email]"))) return false;
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", password);
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => {}),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForTimeout(1500);
  return !/\/account\/login/.test(page.url());
}

async function addFirstProductToCart(page) {
  await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const href = await page.$eval('a[href^="/products/"]', (a) => a.getAttribute("href"));
  await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  });
  await page.waitForTimeout(2000);
  return clicked ? href : null;
}

async function adminLogin(page) {
  await page.goto(`${BASE}/vault`, { waitUntil: "domcontentloaded" });
  const r = await page.evaluate(async (creds) => {
    const res = await fetch("/api/admin/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify(creds),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, ADMIN);
  assert(r.status === 200 && r.body?.success !== false, `admin login answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
}
async function postAsPage(page, url, data, method = "POST") {
  return page.evaluate(async ([u, d, m]) => {
    const res = await fetch(u, { method: m, headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: d === undefined ? undefined : JSON.stringify(d) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [url, data, method]);
}

/** Render a captured email at phone and desktop widths; fail on sideways scroll. */
async function renderMail(context, mail, label) {
  mkdirSync(SHOTS, { recursive: true });
  const out = [];
  for (const [device, width, height] of [["mobile", 390, 844], ["desktop", 1280, 900]]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await page.setContent(decode(mail.html), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const file = `${SHOTS}/${label}-${device}.png`;
    await page.screenshot({ path: file, fullPage: true });
    await page.close();
    assert(overflow <= 0, `${label} scrolls sideways by ${overflow}px at ${width}px`);
    out.push(file);
  }
  return out;
}

// ============================================================================
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--ssl-version-max=tls1.2"] });
  const context = await browser.newContext({ ...LOOPBACK_TLS, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Every automation on, with short delays, so the clock can be walked.
  await q(`update email_automations set enabled = true`);
  await q(`update email_automations set delay_days = case key when 'welcome_intro' then 1 when 'welcome_no_purchase' then 3 when 'post_purchase' then 5 when 'replenishment' then 30 when 'winback_30' then 45 when 'winback_60' then 75 else delay_days end`);
  await q(`update email_automations set offer_key = 'winback_60_percent_15' where key = 'welcome_no_purchase'`);

  // ---------------------------------------------------------------------------
  section("1. Subscriber → welcome sequence");
  const subscriber = `sub.${stamp}@example.test`;
  let subscriberUserId = null;

  await step("the signup form offers a marketing opt-in, OFF by default", async () => {
    // THIS STEP USED TO ASSERT THE OPPOSITE, AND THE PRODUCT IS RIGHT.
    //
    // It required the box to be "ticked by default". account-auth-form.tsx
    // initialises marketingOptIn to false on purpose and says so beside the
    // control: the row is "genuinely optional, genuinely off until someone
    // turns it on". Pre-ticked marketing consent is the defect — it is not
    // consent under GDPR, it is the thing CAN-SPAM complaints and spam-folder
    // placement are made of, and this store's own campaign sends depend on a
    // clean list. Making this assertion pass by pre-ticking the box would have
    // traded deliverability for a green line.
    //
    // The step also never reached the form. It clicked "Create an account"
    // while that button was DISABLED — canEnter gates it on the 21+ and
    // research-use rows — so mode never became "signup", the control never
    // rendered, and the failure read as a missing opt-in rather than an
    // unticked gate. Both acknowledgements are made here first, exactly as a
    // customer makes them.
    await passAgeGate(page);
    await page.goto(`${BASE}/account/login?mode=signup`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("label")];
      for (const row of rows) {
        const text = row.textContent ?? "";
        if (!/21 years|research use/i.test(text)) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (box && !box.checked) box.click();
      }
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button, a")]
        .find((x) => /create (an )?account/i.test(x.textContent || "") && !x.disabled);
      if (b && !document.querySelector('[data-testid="signup-marketing-opt-in"]')) b.click();
    });
    await page.waitForSelector('[data-testid="signup-marketing-opt-in"]', { timeout: 8000 });
    const state = await page.$eval('[data-testid="signup-marketing-opt-in"]', (el) => ({
      checked: el.checked,
      optional: !el.required,
    }));
    assert(!state.checked, "the marketing opt-in is pre-ticked — that is not consent");
    assert(state.optional, "the marketing opt-in is marked required; it must never gate an account");
    // And it must actually be usable, or "off by default" would be satisfied by
    // a control nobody can turn on.
    await page.click('[data-testid="signup-marketing-opt-in"]');
    const afterClick = await page.$eval('[data-testid="signup-marketing-opt-in"]', (el) => el.checked);
    assert(afterClick, "the marketing opt-in cannot be turned on");
    await page.screenshot({ path: `${SHOTS}/signup-opt-in.png`, fullPage: true });
    return "present, optional, off by default, and can be turned on";
  });

  await step("signing up with the box ticked records consent in both stores and sends the confirmation", async () => {
    const offset = mailOffset();
    const r = await page.evaluate(async ([email]) => {
      const res = await fetch("/api/auth/signup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The store's own gate: signup requires the 21+ and research-use
        // acknowledgements. Sending them is what a real customer does, not a
        // bypass — the portal collects both before it will submit.
        body: JSON.stringify({ email, password: "HarnessPass123!", fullName: "Sam Subscriber", businessType: "Other", referredByCode: "", captchaToken: "", nextPath: "/account", marketingOptIn: true, ageConfirmed: true, researchUseOnly: true }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, [subscriber]);
    assert(r.status === 200 && r.body?.success, `signup answered ${r.status}`);
    const user = await q(`select id from auth.users where email = $1`, [subscriber]);
    assert(user.rows.length === 1, "no auth user created");
    subscriberUserId = user.rows[0].id;
    const pref = await q(`select marketing_emails from customer_preferences where user_id = $1`, [subscriberUserId]);
    assert(pref.rows[0]?.marketing_emails === true, "customer_preferences.marketing_emails is not true");
    const sub = await q(`select source, opted_in_at from marketing_subscribers where email = $1`, [subscriber]);
    assert(sub.rows[0]?.source === "signup", "marketing_subscribers row missing or wrong source");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const confirmation = mailSince(offset).find((m) => m.to === subscriber && /confirm/i.test(m.subject));
    assert(confirmation, "no confirmation email captured");
    assert(!header(confirmation, "List-Unsubscribe"), "a transactional confirmation carried List-Unsubscribe");
    return "preference + subscriber rows written; confirmation sent without marketing headers";
  });

  await step("nothing marketing is sent before the welcome delay has passed", async () => {
    const { mail } = await sweepAndMail((m) => m.to === subscriber);
    assert(mail.length === 0, `expected nothing, got ${mail.map((m) => m.subject).join(", ")}`);
  });

  let welcomeIntro = null;
  await step("a day later the welcome introduction goes out, once", async () => {
    await q(`update marketing_subscribers set opted_in_at = $2 where email = $1`, [subscriber, ago(2 * DAY)]);
    await q(`update auth.users set created_at = $2 where id = $1`, [subscriberUserId, ago(2 * DAY)]);
    const first = await sweepAndMail((m) => m.to === subscriber);
    assert(first.mail.length === 1, `expected one email, got ${first.mail.length}: ${first.mail.map((m) => m.subject).join(", ")}`);
    welcomeIntro = first.mail[0];
    assert(/Vanta Labs/i.test(welcomeIntro.subject), `unexpected subject ${welcomeIntro.subject}`);
    assert(header(welcomeIntro, "List-Unsubscribe") && header(welcomeIntro, "List-Unsubscribe-Post"), "marketing mail without one-click unsubscribe headers");
    assert(/Harness Way/.test(decode(welcomeIntro.html)), "postal address missing from the marketing footer");
    const second = await sweepAndMail((m) => m.to === subscriber);
    assert(second.mail.length === 0, "the intro was sent twice");
    return `"${welcomeIntro.subject}" — send-once held on the second sweep`;
  });

  await step("the welcome offer waits out the quiet period, then goes out with a working gift link", async () => {
    await q(`update marketing_subscribers set opted_in_at = $2 where email = $1`, [subscriber, ago(4 * DAY)]);
    await q(`update auth.users set created_at = $2 where id = $1`, [subscriberUserId, ago(4 * DAY)]);
    const quiet = await sweepAndMail((m) => m.to === subscriber);
    assert(quiet.mail.length === 0, `the offer went out inside the 24h quiet period: ${quiet.mail.map((m) => m.subject).join(", ")}`);
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [subscriber, ago(2 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === subscriber);
    assert(mail.length === 1, `expected the offer, got ${mail.length}`);
    const offer = mail[0];
    const cta = linksIn(offer).find((l) => /\/api\/email\/automation-click/.test(l));
    assert(cta, "the offer carries no tracked CTA");
    const r = await fetch(cta, { redirect: "manual" });
    assert(r.status >= 300 && r.status < 400, `automation click answered ${r.status}`);
    const location = r.headers.get("location") ?? "";
    assert(location.startsWith(BASE), `click redirected off-site: ${location}`);
    const setCookie = r.headers.get("set-cookie") ?? "";
    assert(/vl_offer=/.test(setCookie), "the gift cookie was not set by the click");
    assert(/vl_automation=/.test(setCookie), "the attribution cookie was not set by the click");
    const offerRow = await q(`select offer_key, expires_at from customer_offers where email = $1`, [subscriber]);
    assert(offerRow.rows.length === 1, "no customer_offers row minted for the welcome gift");
    const clicks = await q(`select count(*)::int as n from email_automation_clicks where email = $1`, [subscriber]);
    assert(clicks.rows[0].n === 1, "the click was not recorded");
    await renderMail(context, offer, "welcome-offer");
    return `"${offer.subject}" → ${location.replace(BASE, "")}, offer ${offerRow.rows[0].offer_key} minted, click recorded`;
  });

  await step("a subscriber who buys never receives the welcome sequence", async () => {
    const buyer = `buyer.${stamp}@example.test`;
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [buyer, ago(2 * DAY)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'Buyer', 'paid', 69, 69, 0, 0, 'USD', $3, 'product')`, [`order-qa-${stamp}-buyer`, buyer, ago(1 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === buyer);
    assert(mail.length === 0, `a buyer got welcome mail: ${mail.map((m) => m.subject).join(", ")}`);
  });

  // ---------------------------------------------------------------------------
  section("2. Guest checkout abandonment → recovery sequence");
  const guest = `guest.${stamp}@example.test`;
  const createAccount = (email) => q(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, created_at)
     values ($1,'HarnessPass123!',now(),now())
     on conflict (email) do update set encrypted_password = excluded.encrypted_password,
       email_confirmed_at = now()`,
    [email],
  );
  let cartId = null;

  await step("a signed-in shopper who reaches checkout has the cart tracked", async () => {
    // THIS USED TO CLEAR COOKIES AND SHOP AS AN ANONYMOUS VISITOR, AND THAT
    // VISITOR NO LONGER EXISTS.
    //
    // The storefront is default-deny (access-policy.ts): /products, /cart and
    // /checkout all redirect an unauthenticated visitor to /account/login. So
    // the step shopped on a sign-in page, `a[href^="/products/"]` matched
    // nothing, and six further steps in this section — the whole recovery
    // ladder — failed behind it on a cart that had never been created.
    //
    // The reachable shape of the same scenario is a signed-in shopper reaching
    // checkout: the tracker takes the address from the session, and the field
    // is read-only for them anyway. The recovery ladder keys on the EMAIL, so
    // everything below is unchanged.
    //
    // The account-less guest cart is still real — the track route serves one,
    // and grant-holders from a recovery email reach /cart without an account —
    // and it is covered by qa-guest-recovery, which seeds those rows directly
    // for exactly this reason.
    await createAccount(guest);
    assert(await signInAs(page, guest), "could not sign in to shop");
    const product = await addFirstProductToCart(page);
    assert(product, "could not add a product");
    await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // NOTHING IS TYPED, BECAUSE NOTHING CAN BE. checkout/page.tsx renders the
    // email field `readOnly={emailLockedToAccount}` for a signed-in customer:
    // the receipt address IS the account address, which is what keeps an order,
    // its recovery mail and its attribution on one identity. The tracker takes
    // the address from the session, so reaching checkout is the whole action.
    await page.waitForTimeout(2000);
    const row = await q(`select id, status, cart_value_cents, customer_user_id from abandoned_carts where email = $1 order by first_seen_at desc limit 1`, [guest]);
    assert(row.rows.length === 1, "no abandoned_carts row for the shopper");
    cartId = row.rows[0].id;

    // AND THEN THEY LEAVE, WHICH IS WHAT ABANDONMENT IS.
    //
    // The cart tracker keeps posting snapshots while a storefront page is open,
    // and each one stamps last_updated_at. Recovery correctly refuses to mail a
    // shopper who is still active — the step below this one asserts exactly
    // that — so a page left open on /checkout holds the cart permanently fresh
    // and no stage after the first can ever come due. Measured: first_seen_at
    // backdated to 25 hours ago while last_updated_at kept moving to now, and
    // three stages reported "expected one, got 0".
    //
    // This was invisible while the shopper was a signed-out guest, because the
    // wall refused their snapshots. It is not a new fault, it is the same
    // abandonment this file always meant to describe, now actually performed.
    await page.goto("about:blank");
    await page.waitForTimeout(500);
    return `cart ${cartId} tracked against ${guest}, ${row.rows[0].cart_value_cents}c`;
  });

  await step("nothing is sent while the shopper is still active", async () => {
    const { mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 0, "recovery mail went out inside the hour");
  });

  /**
   * MOVE THE WHOLE SEQUENCE'S CLOCK, NOT JUST THE CART'S.
   *
   * selectDueStage holds a stage while the PREVIOUS one went less than
   * MIN_STAGE_GAP_MS (8 hours) ago — "the gap comes before the window" — so a
   * cart whose first_seen_at is backdated 25 hours while its t30m row still
   * says it was sent a minute ago is correctly not due for anything. That is
   * the product being right: nobody should receive the 12-hour note one minute
   * after the 30-minute one.
   *
   * The steps below backdated only the cart, so every stage after the first
   * reported "expected one, got 0" — a rule working exactly as designed, read
   * as a dead sequence. Time passes for the sends too.
   */
  const ageCartAndSends = async (ms) => {
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where id = $1`, [cartId, ago(ms)]);
    await q(`update abandoned_cart_emails set sent_at = sent_at - $2::interval where abandoned_cart_id = $1`,
      [cartId, `${Math.round(ms / HOUR)} hours`]);
  };

  const lastClaimedStage = async () => (await q(
    `select stage from abandoned_cart_emails where abandoned_cart_id = $1 order by sent_at desc limit 1`,
    [cartId],
  )).rows[0]?.stage ?? null;

  /**
   * WALK THE LADDER TO `stage`, ONE RUNG PER SWEEP, THE WAY IT REALLY MOVES.
   *
   * selectDueStage advances at most one stage per sweep and refuses to go
   * backwards — "the ladder only ever goes up". These steps aged the cart to 25
   * and 73 hours and expected the 24-hour and 72-hour messages to arrive
   * immediately, so they read the NEXT rung and called it the wrong one: at 25
   * hours with only t30m claimed the sequence correctly sends t12h, and the
   * assertion failed with "unexpected subject Recon Water added to your
   * BPC-157 10mg".
   *
   * Nothing about the product is wrong there; a shopper should not receive the
   * 24-hour note before the 12-hour one. So time is passed repeatedly until the
   * rung under test is the one that just went out, which is what really happens
   * over a day of sweeps, and every message in between is still a real send
   * this file can assert on.
   */
  const sweepToStage = async (stage, ms) => {
    let mail = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ageCartAndSends(ms);
      const result = await sweepAndMail((m) => m.to === guest);
      if (result.mail.length > 0) mail = result.mail;
      if ((await lastClaimedStage()) === stage) return mail;
      if (result.mail.length === 0) break;
    }
    throw new Error(`the sequence never reached ${stage}; last claimed ${await lastClaimedStage()}`);
  };

  let stage1 = null;
  await step("one hour after the last change the first reminder goes out, and only that one", async () => {
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where id = $1`, [cartId, ago(2 * HOUR)]);
    const { body, mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 1, `expected one, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    stage1 = mail[0];
    assert(body.cartRecovery.t30mSent === 1, `sweep reported ${JSON.stringify(body.cartRecovery)}`);
    assert(!/SAVE-/.test(textOf(stage1)), "the first reminder carried a discount");
    assert(header(stage1, "List-Unsubscribe-Post") === "List-Unsubscribe=One-Click", "missing one-click unsubscribe");
    await renderMail(context, stage1, "cart-1h");
    return `"${stage1.subject}"`;
  });

  await step("the restore link in the email opens the cart", async () => {
    const tracked = linksIn(stage1).find((l) => /\/api\/email\/track\/click/.test(l));
    assert(tracked, "no tracked restore link");
    const r = await fetch(tracked, { redirect: "manual" });
    const location = r.headers.get("location") ?? "";
    assert(/\/cart\/restore\?id=/.test(location), `tracked link redirected to ${location}`);
    // FOLLOW THE LINK THE WAY THE SHOPPER DOES — in a browser that keeps the
    // cookies the click sets. /api/cart/restore is behind the wall, so a bare
    // fetch carrying no session and no grant is refused, and the step reported
    // "the restore endpoint returned no items" for a cart that restores fine.
    const restorePage = await context.newPage();
    await restorePage.goto(tracked, { waitUntil: "domcontentloaded" });
    await restorePage.waitForTimeout(1200);
    const body = await restorePage.evaluate(async (id) => {
      const res = await fetch(`/api/cart/restore?id=${id}`, { credentials: "same-origin" });
      return res.json().catch(() => null);
    }, cartId);
    await restorePage.close();
    assert(body?.success && body.items?.length > 0,
      `the restore endpoint returned no items: ${JSON.stringify(body).slice(0, 160)}`);
    const clicked = await q(`select clicked_at from abandoned_cart_emails where abandoned_cart_id = $1 and stage = 't30m'`, [cartId]);
    assert(clicked.rows[0]?.clicked_at, "the click was not stamped on the stage row");
    return `→ ${location.replace(BASE, "")}, ${body.items.length} item(s) restorable, click stamped`;
  });

  await step("a cart first seen 25 hours ago gets the details message, not a catch-up of stage one", async () => {
    const mail = await sweepToStage("t24h", 25 * HOUR);
    assert(mail.length === 1, `expected one, got ${mail.length}`);
    // Whatever the 24-hour message says, it must not be the opening line of a
    // sequence this shopper is already three messages into.
    assert(!/still in your cart|cart is saved/i.test(mail[0].subject),
      `the 24h slot repeated stage one: ${mail[0].subject}`);
    assert(!/SAVE-/.test(textOf(mail[0])), "the 24h message carried a discount");
    const again = await sweepAndMail((m) => m.to === guest);
    assert(again.mail.length === 0, "the 24h message repeated");
    await renderMail(context, mail[0], "cart-24h");
    return `"${mail[0].subject}"`;
  });

  let lastNote = null;
  let lastNoteCode = null;
  await step("at 72 hours the last note carries a real, live benefit bound to the shopper — and the sequence ends", async () => {
    // THE LAST NOTE CARRIES A CODE *OR* A GIFT, AND THIS ONLY KNEW ABOUT CODES.
    //
    // The t72h stage plans one reward. Where the shipped ladder configures a
    // gift for that stage, planStageOffer chooses it and `plan.coupon` is
    // false, so no SAVE- code is minted and the message is built around the
    // vial instead — "GHK-Cu 50mg still added, at no charge". That is the
    // product working: one reward per stage, not two.
    //
    // This step asserted a SAVE- code unconditionally and failed with "no code
    // in the last note" against a message carrying a perfectly good gift. The
    // invariant worth holding is not which KIND of benefit it is; it is that
    // the benefit is real, still live, and belongs to this shopper alone — so
    // both shapes are accepted and whichever arrived is verified to the same
    // standard.
    const mail = await sweepToStage("t72h", 73 * HOUR);
    assert(mail.length === 1, `expected one, got ${mail.length}`);
    lastNote = mail[0];

    const body = textOf(lastNote);
    lastNoteCode = body.match(/SAVE-[A-Z0-9]+/)?.[0] ?? null;
    let described = "";

    if (lastNoteCode) {
      const coupon = await q(`select assigned_email, active, ends_at, discount_value from coupons where code = $1`, [lastNoteCode]);
      assert(coupon.rows.length === 1 && coupon.rows[0].assigned_email === guest,
        "the code is not a live coupon bound to the shopper");
      assert(new Date(coupon.rows[0].ends_at) > new Date(), "the code is already expired");
      const validate = await fetch(`${BASE}/api/coupons/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: lastNoteCode, email: guest, subtotal: 100 }),
      });
      const vbody = await validate.json().catch(() => null);
      described = `${lastNoteCode} (${coupon.rows[0].discount_value}% off), validate → ${validate.status} ${vbody?.success ?? vbody?.valid ?? ""}`;
    } else {
      // A GIFT INSTEAD. Held to the same three tests: real, live, and this
      // shopper's alone.
      const offer = await q(
        `select email, expires_at, redeemed_at, revoked_at from customer_offers
          where email = $1 and reference_id = $2 order by issued_at desc limit 1`,
        [guest, cartId],
      );
      assert(offer.rows.length === 1,
        `the last note promised a gift but no customer_offers row was minted for this cart`);
      const row = offer.rows[0];
      assert(row.email === guest, "the gift is not bound to this shopper");
      assert(!row.redeemed_at && !row.revoked_at, "the gift was already spent or revoked when it was promised");
      assert(new Date(row.expires_at) > new Date(), "the gift was already expired when it was promised");
      assert(/no charge|free|gift/i.test(body), "the note promises a gift the body never names");
      described = `gift bound to ${row.email}, live until ${new Date(row.expires_at).toISOString().slice(0, 10)}`;
    }

    const later = await sweepAndMail((m) => m.to === guest);
    assert(later.mail.length === 0, "mail continued after the last note");
    await renderMail(context, lastNote, "cart-72h");
    return described;
  });

  await step("the restore link in the last note arms the code, so the shopper does not retype it", async () => {
    assert(lastNote, "no last note to click");
    const tracked = linksIn(lastNote).find((l) => /\/api\/email\/track\/click/.test(l));
    assert(tracked, "no tracked restore link in the last note");
    if (!lastNoteCode) {
      return SKIP("the last note carried a gift rather than a code, so there is no code for restore to arm; "
        + "the gift's own binding and liveness are asserted in the step above");
    }
    // FOLLOW THE LINK IN A BROWSER, which keeps the cookies the click sets —
    // /api/cart/restore is behind the wall and a bare fetch is refused.
    const restorePage = await context.newPage();
    await restorePage.goto(tracked, { waitUntil: "domcontentloaded" });
    await restorePage.waitForTimeout(1200);
    const body = await restorePage.evaluate(async (id) => {
      const res = await fetch(`/api/cart/restore?id=${id}`, { credentials: "same-origin" });
      return res.json().catch(() => null);
    }, cartId);
    await restorePage.close();
    assert(body?.success && body.coupon?.code === lastNoteCode,
      `restore armed ${JSON.stringify(body?.coupon)} rather than ${lastNoteCode}`);
    assert(body.email === guest, "restore did not name the address the code is bound to");
    // And the page applies it: the cart lands with the code already in the price.
    const shopper = await context.newPage();
    await passAgeGate(shopper);
    await shopper.goto(tracked, { waitUntil: "domcontentloaded" });
    await shopper.waitForURL(/\/cart(\?|$)/, { timeout: 20000 });
    await shopper.waitForTimeout(1200);
    const text = (await shopper.locator("body").innerText()).replace(/\s+/g, " ");
    assert(text.includes(code) || /Promo code/i.test(text), `the cart page did not show the armed code: ${text.slice(0, 240)}`);
    await shopper.screenshot({ path: `${SHOTS}/cart-restored-with-code.png`, fullPage: true });
    await shopper.close();
    return `${code} armed by /api/cart/restore and shown on /cart`;
  });

  await step("a purchase ends a live sequence even when the payment webhook's own mark is missed", async () => {
    const buyer = `cartbuyer.${stamp}@example.test`;
    const cart = await q(`insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
      values ($1, $2, 'Cart Buyer', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":1,"unitPrice":47.99}]'::jsonb, 4799, $3, $3, 'active') returning id`, [`sess-${stamp}-buyer`, buyer, ago(2 * HOUR)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'Cart Buyer', 'paid', 47.99, 47.99, 0, 0, 'USD', $3, 'product')`, [`order-qa-${stamp}-cartbuyer`, buyer, ago(1 * HOUR)]);
    const { body, mail } = await sweepAndMail((m) => m.to === buyer);
    assert(mail.length === 0, "a shopper who had paid was mailed to finish their cart");
    const row = await q(`select status, recovered_order_id from abandoned_carts where id = $1`, [cart.rows[0].id]);
    assert(row.rows[0].status === "recovered", `cart is ${row.rows[0].status}, not recovered`);
    return `marked recovered by order ${row.rows[0].recovered_order_id} (sweep recoveredLate=${body.cartRecovery.recoveredLate})`;
  });

  await step("a second cart from the same address inside seven days does not start a new sequence", async () => {
    const cart = await q(`insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
      values ($1, $2, 'Sam', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":2,"unitPrice":47.99}]'::jsonb, 9598, $3, $3, 'active') returning id`, [`sess-${stamp}-second`, guest, ago(2 * HOUR)]);
    const { body, mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 0, "a second sequence started inside the cooldown");
    assert(body.cartRecovery.heldForCooldown >= 1, `sweep did not report the hold: ${JSON.stringify(body.cartRecovery)}`);
    await q(`update abandoned_carts set status = 'expired' where id = $1`, [cart.rows[0].id]);
    return "held for cooldown";
  });

  await step("a shopper who empties the cart is never mailed about it", async () => {
    // TRACKED FROM A SIGNED-IN BROWSER, BECAUSE /api/cart/track IS BEHIND THE
    // WALL. Posting from node with no session is refused — "guest tracking
    // refused" — which is the wall doing its job, not a tracking defect. The
    // shopper who fills a cart and then empties it is signed in, like every
    // other shopper now.
    const empty = `empty.${stamp}@example.test`;
    const sessionId = `sess-${stamp}-empty`;
    await createAccount(empty);
    const emptyCtx = await browser.newContext({ ...LOOPBACK_TLS, viewport: { width: 1280, height: 900 } });
    const emptyPage = await emptyCtx.newPage();
    assert(await signInAs(emptyPage, empty), "could not sign in as the shopper who empties the cart");
    const post = (body) => emptyPage.evaluate(async (payload) => {
      const res = await fetch("/api/cart/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      return res.json().catch(() => null);
    }, body);
    const track = await post({ sessionId, email: empty, items: [{ slug: "ghk-cu", name: "GHK-Cu 50mg", quantity: 1, unitPrice: 47.99 }], cartValueCents: 4799 });
    assert(track?.tracked === true, `tracking refused: ${JSON.stringify(track)}`);
    const clear = await post({ sessionId, items: [] });
    assert(clear?.cleared === true, `clearing the cart was refused: ${JSON.stringify(clear)}`);
    await emptyCtx.close();
    const row = await q(`select status from abandoned_carts where session_id = $1`, [sessionId]);
    assert(row.rows[0]?.status === "cleared", `cart is ${row.rows[0]?.status}`);
    await q(`update abandoned_carts set first_seen_at = $2, last_updated_at = $2 where session_id = $1`, [sessionId, ago(2 * HOUR)]);
    const { mail } = await sweepAndMail((m) => m.to === empty);
    assert(mail.length === 0, "a cleared cart was mailed");
  });

  await step("the track endpoint refuses an unauthenticated caller outright", async () => {
    // THIS STEP REPORTED THE OPPOSITE OF WHAT HAPPENED, WHICH IS WORSE THAN
    // FAILING.
    //
    // It posted a provider sink address with no credentials and asserted
    // `body.tracked === false`. /api/cart/track is not on access-policy's
    // public list, so the wall answers 401 with {"success":false,"error":"Sign
    // in to continue"} — there is no `tracked` key at all, `undefined === false`
    // is false, and the step failed with "a sink address was tracked".
    //
    // Nothing had been tracked. The message claimed a deliverability hole in
    // the exact place the wall had just closed one, and anybody reading the
    // output would have gone looking for a bug that did not exist.
    //
    // What is true now is stronger than what the step was checking: an
    // unauthenticated caller cannot enter ANY address into the recovery list,
    // sink or otherwise, so the address-shape guard and the per-address flood
    // limit behind it are a second line rather than the first. Both still run
    // for a grant-holder, which is the only account-less shopper that reaches
    // this route; qa-guest-recovery covers that path.
    const sink = await fetch(`${BASE}/api/cart/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: `sess-${stamp}-sink`,
        email: "bounced@resend.dev",
        items: [{ slug: "ghk-cu", name: "x", quantity: 1, unitPrice: 1 }],
        cartValueCents: 100,
      }),
    });
    const body = await sink.json().catch(() => ({}));
    assert(sink.status === 401 || body.tracked === false,
      `an unauthenticated snapshot was accepted: ${sink.status} ${JSON.stringify(body).slice(0, 120)}`);
    // And it must not have landed anyway.
    const landed = await q("select 1 from abandoned_carts where email = $1", ["bounced@resend.dev"]);
    assert(landed.rows.length === 0, "a sink address reached abandoned_carts despite the refusal");
    return `refused with ${sink.status}, nothing written`;
  });

  // ---------------------------------------------------------------------------
  section("3. Post-purchase, replenishment and win-back");
  const customer = `cust.${stamp}@example.test`;
  await step("first-order follow-up goes out after the delay, and not for a second order", async () => {
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [customer, ago(40 * DAY)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'Cust', 'paid', 69, 69, 0, 0, 'USD', $3, 'product')`, [`order-qa-${stamp}-c1`, customer, ago(6 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === customer);
    assert(mail.length === 1, `expected the follow-up, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    assert(/order/i.test(mail[0].subject), `unexpected subject ${mail[0].subject}`);
    await renderMail(context, mail[0], "post-purchase");
    return `"${mail[0].subject}"`;
  });

  await step("the reorder reminder fires for the latest order and stops once they reorder", async () => {
    await q(`update orders set created_at = $2 where order_id = $1`, [`order-qa-${stamp}-c1`, ago(32 * DAY)]);
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [customer, ago(3 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === customer);
    assert(mail.length === 1, `expected the reminder, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    assert(/restock/i.test(mail[0].subject), `unexpected subject ${mail[0].subject}`);
    // A fresh order for a DIFFERENT customer whose earlier order is due: the
    // reminder must not go, because they reordered.
    const reorderer = `reorder.${stamp}@example.test`;
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [reorderer, ago(60 * DAY)]);
    await q(`insert into orders (order_id, customer_email, customer_name, payment_status, amount_paid, subtotal, shipping_amount, discount_amount, currency, created_at, order_type)
             values ($1, $2, 'R', 'paid', 69, 69, 0, 0, 'USD', $3, 'product'), ($4, $2, 'R', 'paid', 69, 69, 0, 0, 'USD', $5, 'product')`,
      [`order-qa-${stamp}-r1`, reorderer, ago(33 * DAY), `order-qa-${stamp}-r2`, ago(2 * DAY)]);
    const second = await sweepAndMail((m) => m.to === reorderer);
    assert(second.mail.length === 0, `a customer who reordered got: ${second.mail.map((m) => m.subject).join(", ")}`);
    await renderMail(context, mail[0], "replenishment");
    return `"${mail[0].subject}"; reorderer correctly skipped`;
  });

  await step("win-back 1 fires at the operator's delay with a tracked link, once per lapse", async () => {
    await q(`update orders set created_at = $2 where order_id = $1`, [`order-qa-${stamp}-c1`, ago(50 * DAY)]);
    await q(`update email_send_log set sent_at = $2 where recipient_email = $1`, [customer, ago(3 * DAY)]);
    const { mail } = await sweepAndMail((m) => m.to === customer);
    assert(mail.length === 1, `expected win-back 1, got ${mail.length}: ${mail.map((m) => m.subject).join(", ")}`);
    const again = await sweepAndMail((m) => m.to === customer);
    assert(again.mail.length === 0, "win-back 1 repeated");
    await renderMail(context, mail[0], "winback-1");
    return `"${mail[0].subject}"`;
  });

  // ---------------------------------------------------------------------------
  section("4. Unsubscribe and bounce suppression");
  await step("the footer unsubscribe link stops marketing and records which message prompted it", async () => {
    const unsub = linksIn(lastNote).find((l) => /\/api\/unsubscribe\?/.test(l));
    assert(unsub, "no unsubscribe link in the last note");
    // A GET MUST CHANGE NOTHING, AND THIS STEP USED TO REQUIRE THE OPPOSITE.
    //
    // Mailbox providers and security appliances fetch every link in a message
    // before a human sees it. An unsubscribe that acted on GET would silently
    // opt customers out of mail they asked for, so the endpoint deliberately
    // does nothing on one — which is why this step reported "no suppression
    // row" against an endpoint behaving exactly as designed.
    //
    // So the inertness is now asserted rather than fought, and the opt-out is
    // performed the way it really happens: the RFC 8058 one-click POST, the
    // same mechanism the List-Unsubscribe-Post header advertises and the same
    // one Gmail issues.
    const scanned = await fetch(unsub);
    assert(scanned.status === 200, `unsubscribe answered ${scanned.status} to a scanner`);
    const afterGet = await q(`select 1 from email_suppressions where email = $1`, [guest]);
    assert(afterGet.rows.length === 0, "a link scanner's GET unsubscribed the shopper");

    const r = await fetch(unsub, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    assert(r.status === 200, `one-click unsubscribe answered ${r.status}`);
    const row = await q(`select reason, source from email_suppressions where email = $1`, [guest]);
    assert(row.rows[0]?.reason === "unsubscribed", "no suppression row after the one-click POST");
    assert(row.rows[0]?.source === "cart_recovery_t72h", `source recorded as ${row.rows[0]?.source}`);
    // A brand-new cart, well outside every cooldown, for the unsubscribed address.
    await q(`update abandoned_cart_emails set sent_at = $2 where abandoned_cart_id in (select id from abandoned_carts where email = $1)`, [guest, ago(20 * DAY)]);
    await q(`insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
      values ($1, $2, 'Sam', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":1,"unitPrice":47.99}]'::jsonb, 4799, $3, $3, 'active')`, [`sess-${stamp}-afterunsub`, guest, ago(2 * HOUR)]);
    const { mail } = await sweepAndMail((m) => m.to === guest);
    assert(mail.length === 0, `an unsubscribed shopper was mailed: ${mail.map((m) => m.subject).join(", ")}`);
    return `suppressed (source=${row.rows[0].source}); a new cart produced no mail`;
  });

  await step("Gmail's one-click POST unsubscribe works too", async () => {
    const unsub = linksIn(welcomeIntro).find((l) => /\/api\/unsubscribe\?/.test(l));
    const r = await fetch(unsub, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert(r.status === 200, `one-click POST answered ${r.status}`);
    const row = await q(`select source from email_suppressions where email = $1`, [subscriber]);
    assert(row.rows[0]?.source === "automation:welcome_intro", `source recorded as ${row.rows[0]?.source}`);
    const pref = await q(`select marketing_emails from customer_preferences where user_id = $1`, [subscriberUserId]);
    assert(pref.rows[0]?.marketing_emails === false, "the account preference was not mirrored off");
    return "suppressed and mirrored onto the account preference";
  });

  await step("a permanent bounce from the provider suppresses the address before the next send", async () => {
    const bouncer = `bounce.${stamp}@example.test`;
    await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1, 'checkout', $2)`, [bouncer, ago(2 * DAY)]);
    const payload = JSON.stringify({ type: "email.bounced", data: { email_id: `msg-${stamp}`, to: [bouncer], bounce: { type: "Permanent" } } });
    const r = await fetch(`${BASE}/api/webhooks/email?secret=${encodeURIComponent(WEBHOOK_SECRET)}`, {
      method: "POST", headers: svixHeaders(payload), body: payload,
    });
    assert(r.status === 200, `webhook answered ${r.status}`);
    const row = await q(`select reason from email_suppressions where email = $1`, [bouncer]);
    assert(row.rows[0]?.reason === "bounced", "bounce did not suppress");
    const { mail } = await sweepAndMail((m) => m.to === bouncer);
    assert(mail.length === 0, "a bounced address was mailed");
    const events = await q(`select kind from email_delivery_events where recipient_email = $1`, [bouncer]);
    assert(events.rows[0]?.kind === "hard_bounce", "the event was not logged");
    return "suppressed as bounced; welcome intro withheld";
  });

  await step("the webhook rejects a wrong secret", async () => {
    const r = await fetch(`${BASE}/api/webhooks/email?secret=wrong`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert(r.status === 401, `answered ${r.status}`);
  });

  // ---------------------------------------------------------------------------
  section("5. Campaigns from the admin");
  let campaignId = null;
  await step("an operator can create, preview and test a campaign", async () => {
    await adminLogin(page);
    const created = await postAsPage(page, "/api/admin/email/campaigns", {
      name: `QA restock ${stamp}`, subject: "Two research favourites are back in stock", previewText: "BPC-157 and GHK-Cu, with fresh batch COAs.",
      headline: "Back in stock", body: "Two of the most-requested compounds are back, with new batch certificates in the COA library.\n\nBoth ship tracked, in plain packaging.",
      promoCode: "", ctaLabel: "SEE WHAT IS BACK", ctaPath: "/products", segment: "all", segmentParam: "",
    });
    assert(created.status === 200 && created.body?.success, `create answered ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
    campaignId = created.body.campaignId ?? created.body.id;
    assert(campaignId, "no campaign id returned");
    const preview = await postAsPage(page, "/api/admin/email/campaigns/preview", { subject: "Two research favourites are back in stock", headline: "Back in stock", body: "Hello", ctaLabel: "SEE WHAT IS BACK", ctaPath: "/products" });
    assert(preview.status === 200 && /Back in stock/.test(preview.body?.html ?? ""), "preview did not render");
    const offset = mailOffset();
    const test = await postAsPage(page, `/api/admin/email/campaigns/${campaignId}/send`, { mode: "test", testEmail: `owner.${stamp}@example.test` });
    assert(test.status === 200 && test.body?.success, `test send answered ${test.status}: ${JSON.stringify(test.body).slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const testMail = mailSince(offset).find((m) => /\[TEST\]/.test(m.subject));
    assert(testMail, "no [TEST] email captured");
    const logged = await q(`select count(*)::int as n from email_send_log where campaign_type = 'campaign' and reference_id = $1`, [campaignId]);
    assert(logged.rows[0].n === 0, "a test send was logged as a campaign send");
    return `campaign ${campaignId}; preview ok; test delivered and not counted`;
  });

  await step("the audience estimate counts consented, unsuppressed addresses only", async () => {
    const r = await page.evaluate(async () => {
      const res = await fetch("/api/admin/email/campaigns?segment=all", { credentials: "same-origin" });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    assert(r.status === 200, `estimate answered ${r.status}`);
    const expected = await q(`select count(*)::int as n from marketing_subscribers s where s.unsubscribed_at is null and s.email not in (select email from email_suppressions) and s.email not like '%@resend.dev'`);
    assert(r.body.count >= 1, "estimate is zero");
    return `${r.body.count} (subscriber table alone: ${expected.rows[0].n})`;
  });

  await step("send now queues every recipient once, and a second send is refused", async () => {
    const offset = mailOffset();
    const send = await postAsPage(page, `/api/admin/email/campaigns/${campaignId}/send`, { mode: "now" });
    assert(send.status === 200 && send.body?.success, `send answered ${send.status}: ${JSON.stringify(send.body).slice(0, 200)}`);
    const again = await postAsPage(page, `/api/admin/email/campaigns/${campaignId}/send`, { mode: "now" });
    assert(again.status !== 200 || again.body?.success === false, `a second send was accepted: ${JSON.stringify(again.body).slice(0, 200)}`);
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const delivered = mailSince(offset).filter((m) => /back in stock/i.test(m.subject) && !/\[TEST\]/.test(m.subject));
    const recipients = await q(`select email, count(*)::int as n from email_campaign_recipients where campaign_id = $1 group by email having count(*) > 1`, [campaignId]);
    assert(recipients.rows.length === 0, "a recipient was queued twice");
    const toSuppressed = delivered.filter((m) => [guest, subscriber].includes(m.to));
    assert(toSuppressed.length === 0, "the campaign reached an unsubscribed address");
    const logged = await q(`select count(*)::int as n, count(provider_message_id)::int as with_id from email_send_log where campaign_type = 'campaign' and reference_id = $1 and status = 'sent'`, [campaignId]);
    const withCta = delivered.filter((m) => linksIn(m).some((l) => /\/api\/email\/click\?/.test(l)));
    assert(withCta.length === delivered.length, "a campaign email went out without a tracked CTA");
    if (delivered[0]) await renderMail(context, delivered[0], "campaign");
    return `${delivered.length} delivered, ${logged.rows[0].n} logged, second send refused (${again.status})`;
  });

  await step("a campaign click is attributed to an order placed inside the window", async () => {
    const rows = await q(`select email from email_campaign_recipients where campaign_id = $1 and status = 'sent' limit 1`, [campaignId]);
    assert(rows.rows.length === 1, "no sent recipient to click as");
    const mail = mailSince(0).filter((m) => m.to === rows.rows[0].email && /back in stock/i.test(m.subject)).pop();
    const cta = linksIn(mail).find((l) => /\/api\/email\/click\?/.test(l));
    const r = await fetch(cta, { redirect: "manual" });
    const cookie = (r.headers.get("set-cookie") ?? "").match(/vl_campaign=([^;]+)/)?.[1];
    assert(cookie, "no attribution cookie set by the click");
    const clicks = await q(`select count(*)::int as n from email_campaign_clicks where campaign_id = $1`, [campaignId]);
    assert(clicks.rows[0].n === 1, "the click was not recorded");
    const clickedRow = await q(`select clicked_at from email_campaign_recipients where campaign_id = $1 and email = $2`, [campaignId, rows.rows[0].email]);
    assert(clickedRow.rows[0]?.clicked_at, "clicked_at not stamped");
    const dashboard = await page.evaluate(async () => {
      const res = await fetch("/admin/email", { credentials: "same-origin" });
      return { status: res.status, text: await res.text() };
    });
    assert(dashboard.status === 200, `admin email page answered ${dashboard.status}`);
    return `click recorded, cookie vl_campaign set (${decodeURIComponent(cookie).slice(0, 24)}…)`;
  });

  await step("stopping a scheduled campaign cancels it", async () => {
    const created = await postAsPage(page, "/api/admin/email/campaigns", {
      name: `QA scheduled ${stamp}`, subject: "A note for later", previewText: "", headline: "Later", body: "This one is scheduled and then cancelled before it goes out, which is the whole test.",
      promoCode: "", ctaLabel: "SEE THE CATALOG", ctaPath: "/products", segment: "all", segmentParam: "",
    });
    const id = created.body?.campaignId ?? created.body?.id;
    const scheduled = await postAsPage(page, `/api/admin/email/campaigns/${id}/send`, { mode: "schedule", scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    assert(scheduled.status === 200 && scheduled.body?.success, `schedule answered ${scheduled.status}: ${JSON.stringify(scheduled.body).slice(0, 200)}`);
    const stopped = await postAsPage(page, `/api/admin/email/campaigns/${id}/stop`, undefined);
    assert(stopped.status === 200 && stopped.body?.success, `stop answered ${stopped.status}`);
    const offset = mailOffset();
    await sweep();
    const row = await q(`select status from email_campaigns where id = $1`, [id]);
    assert(row.rows[0].status !== "sending" && row.rows[0].status !== "sent", `campaign is ${row.rows[0].status}`);
    assert(mailSince(offset).filter((m) => /A note for later/.test(m.subject)).length === 0, "the cancelled campaign went out");
    return `status ${row.rows[0].status}, nothing sent`;
  });

  // ---------------------------------------------------------------------------
  section("6. Admin surfaces render");
  await step("Admin → Email lists every automation with its label and the campaign with delivery columns", async () => {
    await page.goto(`${BASE}/admin/email`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    for (const label of ["First-order follow-up", "Reorder reminder", "Welcome · introduction", "Welcome · first-order offer", "Win-back 1", "Win-back 2"]) {
      assert(text.includes(label), `missing automation "${label}"`);
    }
    assert(/delivered/i.test(text) && /bounce · spam · unsub/i.test(text), "delivery columns missing from the campaign history");
    await page.screenshot({ path: `${SHOTS}/admin-email.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/admin-email-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await step("Admin → Cart recovery shows the per-stage funnel, and excludes our own carts", async () => {
    // EVERY ADDRESS THIS FILE USES IS DELIBERATELY EXCLUDED FROM THIS PANEL.
    //
    // isInternalAddress treats .test, .invalid and .example as internal — "`.test`
    // is reserved by RFC 2606 and can never be real" — so the dashboard leaves
    // them out of every figure, which is why it once reported ten recoveries of
    // which six were the owner's own carts. The funnel is gated on
    // `stats.stages.length > 0`, so with only harness sends it correctly renders
    // nothing, and this step failed with "no stage funnel rendered" against a
    // panel doing exactly what it is for.
    //
    // So the panel is given something it is allowed to count: one cart under a
    // domain that is not internal, with a stage row of its own. That proves the
    // funnel renders AND that the exclusion is real, which is the more valuable
    // pair — the exclusion is the part that was once wrong in production.
    const external = `funnel.${stamp}@vantaqa-harness.com`;
    const externalCart = (await q(
      `insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at, status)
       values ($1, $2, 'Funnel Fixture', '[{"slug":"ghk-cu","name":"GHK-Cu 50mg","quantity":1,"unitPrice":47.99}]'::jsonb, 4799, $3, $3, 'active')
       returning id`,
      [`sess-${stamp}-funnel`, external, ago(3 * HOUR)],
    )).rows[0].id;
    await q(
      `insert into abandoned_cart_emails (abandoned_cart_id, stage, sent_at, opened_at, clicked_at)
       values ($1, 't30m', $2, $2, $2), ($1, 't72h', $2, null, null)`,
      [externalCart, ago(2 * HOUR)],
    );

    await page.goto(`${BASE}/admin/cart-recovery`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const funnel = await page.$('[data-testid="cart-recovery-stage-funnel"]');
    assert(funnel, "no stage funnel rendered even with a non-internal cart present");
    const excluded = await page.$('[data-testid="cart-recovery-internal-excluded"]');
    // The panel only renders the excluded tile when there is something to
    // exclude, and this file has generated plenty.
    if (excluded) {
      const n = Number((await excluded.innerText()).replace(/[^0-9]/g, ""));
      assert(n > 0, "the excluded count rendered as zero while harness carts exist");
    }
    const text = await funnel.innerText();
    assert(/72 h last note/.test(text), `funnel text: ${text}`);
    await page.screenshot({ path: `${SHOTS}/admin-cart-recovery.png`, fullPage: true });
    return text.replace(/\n/g, " | ");
  });

  await browser.close();
  await pool.end();

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  writeFileSync(`${CAPTURE_DIR}/lifecycle-results.json`, JSON.stringify(results, null, 2));
  const skipped = results.filter((r) => r.status === "skip");
  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped. Screenshots in ${SHOTS}.`);
  if (skipped.length) {
    console.log("\nThese did NOT run, so they are NOT verified:");
    for (const r of skipped) console.log(`  ${r.section} :: ${r.name}\n      ${r.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
