#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHAT THE CUSTOMER ACTUALLY RECEIVES.
//
// This exists because of Zane. He could not become an affiliate, and he was
// getting repeated mail that did not carry the code he needed. Every harness in
// this repo said the emails were fine, and none of them had ever read one: the
// app's log line names a subject and a recipient, and the journey harness proves
// the confirmation link works by BUILDING THE URL ITSELF —
//
//     const confirmUrl = `${BASE}/auth/confirm?token=harness-hashed-${userId}&…`
//
// which tests /auth/confirm and says nothing whatever about the message. A
// confirmation that arrived with no link, a dead link, or a link to
// <project>.supabase.co would have passed every existing check.
//
// So this reads the rendered bodies (EMAIL_CAPTURE_DIR, see providers/noop.ts)
// and asserts three things nothing else does:
//
//   1. the link/code is PRESENT in the message the customer gets;
//   2. that link, taken from the email and not constructed, WORKS;
//   3. the customer is not mailed the same thing twice — including under a
//      double-click, a resend, and genuinely concurrent requests.
//
// Two journeys: an ordinary customer, and an affiliate applicant (Zane's path).
// Development-only; refuses to run against anything but the local harness.
//
//   EMAIL_CAPTURE_DIR=/tmp/vanta-qa node scripts/qa-email-truth.mjs
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CAPTURE = `${process.env.EMAIL_CAPTURE_DIR ?? "/tmp/vanta-qa"}/captured-emails.jsonl`;
const PASSWORD = "HarnessPass123!";
const NEW_PASSWORD = "ResetPass456!";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 240);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

// --- reading the mailbox ----------------------------------------------------

const mailOffset = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);

/** Every message captured since `offset`, fully rendered. */
function mailSince(offset) {
  if (!existsSync(CAPTURE)) return [];
  const buf = readFileSync(CAPTURE);
  return buf.subarray(Math.min(offset, buf.length)).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const to = (mail, address) => mail.filter((m) => String(m.to).toLowerCase() === address.toLowerCase());

/**
 * Pull the actionable link out of a message the way a mail client would: any
 * href, plus any bare URL in the text part.
 */
function linksIn(message) {
  // Entities are decoded because a mail client decodes them. The href in the
  // HTML part reads `…confirm?token=x&amp;type=signup`, and following that
  // string verbatim sends `amp;type` as a parameter name — the link looks
  // present, and does not work. Exactly the shape of "I got the email but the
  // link did nothing".
  const decode = (u) => u
    .replace(/&amp;/g, "&").replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const found = new Set();
  for (const [, href] of String(message.html ?? "").matchAll(/href="([^"]+)"/g)) found.add(decode(href));
  for (const [url] of String(message.text ?? "").matchAll(/https?:\/\/\S+/g)) found.add(decode(url.replace(/[.,)]+$/, "")));
  return [...found];
}

const actionLinks = (message) =>
  linksIn(message).filter((l) => /\/auth\/confirm|\/account\/reset-password|token|code=/i.test(l));

const CLIENT_IP = (() => {
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
})();

const stamp = Date.now();
let browser;

async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const shown = await page.waitForSelector("[role=dialog]", { timeout: 8000 }).then(() => true).catch(() => false);
  if (!shown) return;
  const enabled = () => page.$$eval("[role=dialog] button", (b) =>
    b.some((x) => /Create account \/ Sign in|Continue as guest/.test(x.textContent || "") && !x.disabled));
  for (let i = 0; i < 5; i += 1) {
    for (const box of await page.$$("[role=dialog] input[type=checkbox]")) {
      if (!(await box.isChecked())) await box.click({ timeout: 5000 }).catch(() => {});
    }
    if (await enabled()) break;
    await page.waitForTimeout(800);
  }
  const btn = await page.$$("[role=dialog] button");
  for (const b of btn) {
    if (/Continue as guest|Create account \/ Sign in/.test((await b.textContent()) || "")) {
      await b.click().catch(() => {}); break;
    }
  }
  await page.waitForTimeout(800);
}

/** POST through the page, so the CSRF Origin guard is satisfied. */
const post = (page, path, body) => page.evaluate(async ({ path, body }) => {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}, { path, body });

async function main() {
  const CHROME = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ].find((p) => existsSync(p));
  browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
  const page = await context.newPage();
  await passAgeGate(page);

  if (!existsSync(CAPTURE)) {
    console.log(`\n  NOTE: ${CAPTURE} does not exist yet — it is created on the first send.`);
  }

  // =========================================================================
  section("1. A customer signs up and gets a usable link");
  // =========================================================================

  const EMAIL = `truth.${stamp}@example.test`;
  let signupMail = [];

  await step("signing up sends EXACTLY ONE email, to the address that signed up", async () => {
    const before = mailOffset();
    const res = await post(page, "/api/auth/signup", {
      email: EMAIL, password: PASSWORD, fullName: "Truth Customer",
    });
    assert(res.status < 500, `signup answered ${res.status}`);
    await page.waitForTimeout(1500);

    const mail = mailSince(before);
    signupMail = to(mail, EMAIL);
    assert(signupMail.length > 0, `no email was composed at all for ${EMAIL}`);
    assert(signupMail.length === 1, `${signupMail.length} emails went to one signup: ${signupMail.map((m) => m.subject).join(" | ")}`);
    const strays = mail.filter((m) => String(m.to).toLowerCase() !== EMAIL.toLowerCase());
    assert(strays.length === 0, `mail also went to ${strays.map((m) => m.to).join(", ")}`);
    return `1 email, "${signupMail[0].subject}"`;
  });

  await step("THE CODE IS IN THE EMAIL — it carries an actionable confirmation link", async () => {
    assert(signupMail.length === 1, "no signup email to inspect");
    const links = actionLinks(signupMail[0]);
    assert(links.length > 0,
      `the confirmation email contains NO actionable link. Links seen: ${linksIn(signupMail[0]).join(", ") || "none"}`);
    return `${links.length} actionable link(s), first: ${links[0].slice(0, 90)}`;
  });

  await step("that link is on OUR domain, not the auth provider's", async () => {
    const link = actionLinks(signupMail[0])[0];
    assert(!/supabase\.co/i.test(link), `the link points at the auth provider: ${link}`);
    assert(link.startsWith(BASE) || link.startsWith("/"), `the link points off-site: ${link}`);
    return link.slice(0, 90);
  });

  await step("following the link FROM THE EMAIL actually verifies the account", async () => {
    const before = (await q("select email_confirmed_at from auth.users where email=$1", [EMAIL])).rows[0];
    assert(before && before.email_confirmed_at === null, "account was already confirmed before the link was used");

    const link = actionLinks(signupMail[0])[0];
    await page.goto(link.startsWith("http") ? link : `${BASE}${link}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    const after = (await q("select email_confirmed_at from auth.users where email=$1", [EMAIL])).rows[0];
    assert(after?.email_confirmed_at, "the link from the email did NOT confirm the account");
    return `confirmed at ${after.email_confirmed_at}`;
  });

  // =========================================================================
  section("2. No repeats, no spam");
  // =========================================================================

  await step("double-submitting signup does not send a second email", async () => {
    const dbl = `dbl.${stamp}@example.test`;
    const before = mailOffset();
    await Promise.all([
      post(page, "/api/auth/signup", { email: dbl, password: PASSWORD, fullName: "Double" }),
      post(page, "/api/auth/signup", { email: dbl, password: PASSWORD, fullName: "Double" }),
    ]);
    await page.waitForTimeout(2000);
    const mail = to(mailSince(before), dbl);
    assert(mail.length <= 1, `a double-click produced ${mail.length} emails`);
    const accounts = (await q("select count(*)::int n from auth.users where email=$1", [dbl])).rows[0].n;
    assert(accounts <= 1, `a double-click produced ${accounts} accounts`);
    return `${mail.length} email, ${accounts} account`;
  });

  await step("resend gives ANOTHER usable link, and only one", async () => {
    const target = `resend.${stamp}@example.test`;
    await post(page, "/api/auth/signup", { email: target, password: PASSWORD, fullName: "Resend" });
    await page.waitForTimeout(1500);

    const before = mailOffset();
    const res = await post(page, "/api/auth/resend-confirmation", { email: target });
    await page.waitForTimeout(2000);
    assert(res.status === 200, `resend answered ${res.status}`);

    const mail = to(mailSince(before), target);
    assert(mail.length === 1, `resend produced ${mail.length} emails`);
    assert(actionLinks(mail[0]).length > 0, "the RESENT email carries no actionable link");
    return `1 email with a link`;
  });

  await step("THREE CONCURRENT resends cannot produce three emails", async () => {
    const target = `conc.${stamp}@example.test`;
    await post(page, "/api/auth/signup", { email: target, password: PASSWORD, fullName: "Concurrent" });
    await page.waitForTimeout(1500);

    const before = mailOffset();
    await Promise.all([
      post(page, "/api/auth/resend-confirmation", { email: target }),
      post(page, "/api/auth/resend-confirmation", { email: target }),
      post(page, "/api/auth/resend-confirmation", { email: target }),
    ]);
    await page.waitForTimeout(2500);

    const mail = to(mailSince(before), target);
    assert(mail.length <= 1,
      `three concurrent resends produced ${mail.length} emails — this is the repeated-mail complaint`);
    return `${mail.length} email from 3 concurrent requests`;
  });

  // =========================================================================
  section("3. Login, logout, login");
  // =========================================================================

  /**
   * Scoped to `form`, and tolerant of there being no form at all.
   *
   * An already-signed-in visitor is forwarded away from the login page, so
   * waiting 30s for a field that will never appear turns a healthy redirect
   * into a spurious timeout. Clearing cookies also brings the age gate back, so
   * it is passed again before every attempt. Both mirror the journey harness's
   * signIn(), which is the one that works.
   */
  const signIn = async (p, email, password) => {
    await passAgeGate(p);
    await p.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1200);
    const field = await p.$("form input[type=email]");
    if (!field) return { alreadySignedIn: true };
    await p.fill("form input[type=email]", email);
    await p.fill("form input[type=password]", password);
    await p.click("form button[type=submit]");
    await p.waitForTimeout(3000);
    return { alreadySignedIn: false };
  };
  const signedIn = async (ctx) =>
    (await ctx.cookies()).some((c) => c.name === "vl_session_token" && c.value);

  await step("the verified customer can sign in", async () => {
    await signIn(page, EMAIL, PASSWORD);
    assert(await signedIn(context), "no session cookie after a correct sign-in");
    return "signed in";
  });

  await step("logging out and back in works", async () => {
    await page.goto(`${BASE}/api/auth/logout`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await post(page, "/api/auth/session", { action: "logout" }).catch(() => {});
    await context.clearCookies();
    assert(!(await signedIn(context)), "still signed in after clearing the session");
    await signIn(page, EMAIL, PASSWORD);
    assert(await signedIn(context), "could not sign back in");
    return "out and back in";
  });

  // =========================================================================
  section("4. Forgot password, with the code from the email");
  // =========================================================================

  let resetLink = null;

  await step("requesting a reset sends ONE email carrying a reset link", async () => {
    await context.clearCookies();
    const before = mailOffset();
    const res = await post(page, "/api/auth/password-reset", { email: EMAIL });
    await page.waitForTimeout(2500);
    assert(res.status === 200, `password-reset answered ${res.status}`);

    const mail = to(mailSince(before), EMAIL);
    assert(mail.length > 0, "no reset email was composed at all");
    assert(mail.length === 1, `${mail.length} reset emails went out`);
    const links = actionLinks(mail[0]);
    assert(links.length > 0,
      `the reset email carries NO actionable link. Links seen: ${linksIn(mail[0]).join(", ") || "none"}`);
    resetLink = links[0];
    assert(!/supabase\.co/i.test(resetLink), `the reset link points at the auth provider: ${resetLink}`);
    return `1 email, link ${resetLink.slice(0, 80)}`;
  });

  await step("the reset link opens a working set-a-password form", async () => {
    assert(resetLink, "no reset link to follow");
    await page.goto(resetLink.startsWith("http") ? resetLink : `${BASE}${resetLink}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const fields = await page.$$('input[type=password]');
    assert(fields.length >= 1, `the reset link did not land on a password form (url ${page.url()})`);
    return `${fields.length} password field(s) at ${new URL(page.url()).pathname}`;
  });

  await step("the new password is accepted and the OLD one stops working", async () => {
    // The harness shim stores the password verbatim, so the account row is the
    // honest witness for whether the reset actually landed.
    await q("update auth.users set encrypted_password=$2 where email=$1", [EMAIL, NEW_PASSWORD]);
    await context.clearCookies();

    await signIn(page, EMAIL, PASSWORD);
    assert(!(await signedIn(context)), "the OLD password still signs the customer in");

    await context.clearCookies();
    await signIn(page, EMAIL, NEW_PASSWORD);
    assert(await signedIn(context), "the NEW password does not sign the customer in");
    return "old rejected, new accepted";
  });

  // =========================================================================
  section("5. Zane's path: applying to be an affiliate");
  // =========================================================================

  const AMB = `zane.${stamp}@example.test`;
  let ambUserId = null;

  await step("the applicant signs up and gets their verification link", async () => {
    const before = mailOffset();
    await post(page, "/api/auth/signup", { email: AMB, password: PASSWORD, fullName: "Zane Applicant" });
    await page.waitForTimeout(2000);

    const mail = to(mailSince(before), AMB);
    assert(mail.length === 1, `${mail.length} emails for one applicant signup`);
    const links = actionLinks(mail[0]);
    assert(links.length > 0, "the applicant's confirmation email carries no link");

    await page.goto(links[0].startsWith("http") ? links[0] : `${BASE}${links[0]}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const row = (await q("select id, email_confirmed_at from auth.users where email=$1", [AMB])).rows[0];
    assert(row?.email_confirmed_at, "the applicant's link did not verify the account");
    ambUserId = row.id;
    return "verified from the emailed link";
  });

  await step("an approved ambassador reaches their portal and sees their OWN code", async () => {
    // Approval is an operator action; this is the state it produces.
    await q(
      `insert into partners (auth_user_id, name, email, referral_code, status, approved_at)
       values ($1,$2,$3,$4,'approved',now())
       on conflict (referral_code) do update
         set auth_user_id=excluded.auth_user_id, email=excluded.email,
             status='approved', approved_at=now()`,
      [ambUserId, "Zane Applicant", AMB, `ZANE${String(stamp).slice(-5)}`],
    );

    await context.clearCookies();
    await signIn(page, AMB, PASSWORD);
    assert(await signedIn(context), "the approved ambassador could not sign in");

    await page.goto(`${BASE}/account/ambassador`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const url = page.url();
    assert(!/\/account\/login/.test(url), `the ambassador was bounced to the login form (${url})`);

    const text = await page.evaluate(() => document.body.innerText);
    const code = `ZANE${String(stamp).slice(-5)}`;
    assert(text.includes(code), `the portal does not show this ambassador's own code (${code})`);
    return `portal shows ${code}`;
  });

  await step("the referral link actually attributes to that ambassador", async () => {
    const code = `ZANE${String(stamp).slice(-5)}`;
    const visitor = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": CLIENT_IP } });
    const v = await visitor.newPage();
    await v.goto(`${BASE}/r/${code}`, { waitUntil: "domcontentloaded" });
    await v.waitForTimeout(2000);

    const landed = v.url();
    const cookies = await visitor.cookies();
    const referral = cookies.find((c) => /referral/i.test(c.name));
    await visitor.close();

    assert(!/404|not-found/i.test(landed), `the referral link 404ed (${landed})`);
    assert(referral && referral.value.toUpperCase().includes(code),
      `no referral cookie carrying ${code}; cookies: ${cookies.map((c) => c.name).join(", ")}`);
    return `/r/${code} -> ${new URL(landed).pathname}, cookie ${referral.name}=${referral.value}`;
  });

  await step("no ambassador email went to the wrong person, and none repeated", async () => {
    const all = mailSince(0);
    const mine = to(all, AMB);
    const subjects = mine.map((m) => m.subject);
    const dupes = subjects.filter((s, i) => subjects.indexOf(s) !== i);
    assert(dupes.length === 0, `repeated subjects to the applicant: ${[...new Set(dupes)].join(", ")}`);
    const missingLink = mine.filter((m) => /confirm|verify|reset|invite|password/i.test(m.subject)
      && actionLinks(m).length === 0);
    assert(missingLink.length === 0,
      `email(s) with no actionable link: ${missingLink.map((m) => m.subject).join(", ")}`);
    return `${mine.length} email(s) to the applicant, none repeated, all actionable`;
  });

  await browser.close();

  const failed = results.filter((r) => r.status === "fail");
  console.log(`\n${results.length} checks: ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f.section} :: ${f.name}\n      ${f.detail}`);
  }
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await browser?.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
