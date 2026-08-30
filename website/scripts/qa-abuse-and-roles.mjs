#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ABUSE RESISTANCE AND THE AMBASSADOR LIFECYCLE.
//
// The other two harnesses answer "does the right person get in" and "does the
// journey hold together". This one answers the two questions neither covers:
//
//   * does the wrong person get STOPPED when they try repeatedly — brute force,
//     signup spam, reset flooding, resend flooding, CSRF, and script injected
//     through a profile field that another page later renders;
//   * does an ambassador's own lifecycle work end to end, and can one
//     ambassador see another's numbers.
//
// WHAT A RATE-LIMIT TEST HAS TO PROVE, AND WHAT IT MUST NOT ASSUME
//
// A limiter that fails OPEN under load is worse than none, because it reports
// success while doing nothing. The harness logs `FAILING OPEN` when its backing
// store is unavailable, so this script reads that and reports UNENFORCED rather
// than quietly passing — a limit that is not enforced here would not be
// enforced in production either, and calling it "covered" is the failure mode
// this whole exercise exists to remove.
//
// Development-only. Drives the local harness at 127.0.0.1:3000 and refuses to
// start against anything else.
//
//   node scripts/qa-abuse-and-roles.mjs
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const HARNESS_LOG = process.env.QA_HARNESS_LOG ?? null;

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script drives the local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

const results = [];
let currentSection = "";
const SKIP = (reason) => ({ __skip: reason });

function section(title) {
  currentSection = title;
  console.log(`\n${title}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    if (detail && typeof detail === "object" && detail.__skip) {
      results.push({ section: currentSection, name, status: "skip", detail: detail.__skip });
      console.log(`  SKIP  ${name}  — ${detail.__skip}`);
      return;
    }
    results.push({ section: currentSection, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 220);
    results.push({ section: currentSection, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

const logOffset = () => (HARNESS_LOG && existsSync(HARNESS_LOG) ? statSync(HARNESS_LOG).size : 0);

/** Read the harness log as BYTES — see the mail watcher note in qa-customer-journey. */
function logSince(offset) {
  if (!HARNESS_LOG || !existsSync(HARNESS_LOG)) return "";
  const buf = readFileSync(HARNESS_LOG);
  return buf.subarray(Math.min(offset, buf.length)).toString("utf8");
}

/**
 * Hammer an endpoint and report what the limiter did.
 *
 * Deliberately reports THREE outcomes rather than pass/fail: enforced, or
 * failing open (which the harness logs and which is not the endpoint's fault),
 * or genuinely unlimited. Collapsing the middle case into a pass is how a
 * limiter that does nothing gets recorded as working.
 */
/**
 * What a flood test can and cannot observe here.
 *
 * Clearing `rate_limit_hits` does NOT reset the limiter: lib/rate-limit.ts also
 * holds a spent bucket in an in-process `deniedUntil` Map for the whole window,
 * so it can refuse without a round trip. That is correct behaviour, and it means
 * the per-IP bucket (every run shares 127.0.0.1) is usually still held from
 * earlier in the same run — so "the first N were allowed, then throttled" is
 * simply not observable on a warm server.
 *
 * What IS provable, and what these steps therefore require: flooding is refused,
 * and it produces no side effect — no second account, no second email. The
 * allowed-then-throttled transition is REPORTED when it happens to be visible
 * and never asserted, because asserting an unobservable makes the check fail on
 * a limiter that is working perfectly.
 */
async function hammer(page, path, body, attempts, buckets = []) {
  // Clear this endpoint's buckets first, so the run shows the TRANSITION from
  // allowed to throttled rather than a wall of 429s left over from an earlier
  // run. "Everything was refused" proves a limiter exists; "the first N were
  // allowed and the rest refused" proves it fires at the right threshold.
  for (const bucket of buckets) {
    await q("delete from rate_limit_hits where bucket like $1", [bucket]);
  }
  const before = logOffset();
  const statuses = [];
  for (let i = 0; i < attempts; i += 1) {
    const res = await page.evaluate(async ({ path, body }) => {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      return r.status;
    }, { path, body: typeof body === "function" ? body(i) : body });
    statuses.push(res);
  }
  const failedOpen = /FAILING OPEN/.test(logSince(before));
  return { statuses, failedOpen, throttled: statuses.filter((s) => s === 429).length };
}

const stamp = Date.now();

async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  if (!(await page.$("[role=dialog]"))) return;
  await page.evaluate(() => {
    document.querySelectorAll("[role=dialog] input[type=checkbox]").forEach((b) => { if (!b.checked) b.click(); });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });
  await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 });
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/account/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  if (!(await page.$("form input[type=email]"))) return;
  await page.fill("form input[type=email]", email);
  await page.fill("form input[type=password]", password);
  await page.click("form button[type=submit]");
  await page.waitForTimeout(3000);
}

const sessionCookie = async (ctx) =>
  (await ctx.cookies()).find((c) => c.name === "vl_session_token") ?? null;

async function main() {
  const CHROME = process.env.QA_CHROMIUM
    ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
      .find((p) => existsSync(p));
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  await passAgeGate(page);

  // ---- Rate limiting ----------------------------------------------------
  section("1. Rate limiting and flood protection");

  await step("password reset cannot be used to flood one mailbox", async () => {
    const email = `flood.${stamp}@example.test`;
    const out = await hammer(page, "/api/auth/password-reset", { email }, 8,
      ["password-reset-ip:%", `password-reset-email:${email}`]);
    if (out.failedOpen) {
      return SKIP("the limiter failed open (its store was unavailable) — UNENFORCED in this run, not proven");
    }
    assert(out.throttled > 0, `8 rapid resets were never throttled (${out.statuses.join(",")})`);
    const allowedFirst = out.statuses.findIndex((st) => st === 429);
    return allowedFirst > 0
      ? `${allowedFirst} allowed, then throttled (${out.throttled} of 8)`
      : `${out.throttled} of 8 refused (per-IP bucket already held from earlier in this run)`;
  });

  await step("signup cannot be used to flood one mailbox", async () => {
    const email = `spam.${stamp}@example.test`;
    const out = await hammer(page, "/api/auth/signup",
      { email, password: "HarnessPass123!", fullName: "Spam Probe", businessType: "lab" }, 10,
      ["signup-ip:%", `signup-email:${email}`]);
    if (out.failedOpen) return SKIP("the limiter failed open — UNENFORCED in this run, not proven");
    const created = await q("select count(*)::int as n from auth.users where email = $1", [email]);
    assert(created.rows[0].n <= 1, `${created.rows[0].n} accounts were created for one address`);
    assert(out.throttled > 0, `10 rapid signups were never throttled (${out.statuses.join(",")})`);
    // The side effect is the thing that actually matters: a flood must not
    // create accounts or send mail, whichever layer stops it.
    return `${out.throttled} of 10 refused; ${created.rows[0].n} account(s) created`;
  });

  await step("confirmation resend cannot be used to flood one mailbox", async () => {
    const resendEmail = `resend.${stamp}@example.test`;
    const out = await hammer(page, "/api/auth/resend-confirmation", { email: resendEmail }, 8,
      ["resend-confirmation-ip:%", `resend-confirmation-email:${resendEmail}`]);
    if (out.failedOpen) return SKIP("the limiter failed open — UNENFORCED in this run, not proven");
    assert(out.throttled > 0, `8 rapid resends were never throttled (${out.statuses.join(",")})`);
    const allowedFirst = out.statuses.findIndex((st) => st === 429);
    return allowedFirst > 0
      ? `${allowedFirst} allowed, then throttled (${out.throttled} of 8)`
      : `${out.throttled} of 8 refused (per-IP bucket already held from earlier in this run)`;
  });

  await step("repeated wrong admin passwords do not go unnoticed", async () => {
    const before = (await q("select count(*)::int as n from admin_login_attempts")).rows[0].n;
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate(async () => {
        await fetch("/api/admin/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "qaadmin", password: "definitely-wrong" }),
        });
      });
    }
    const after = (await q(
      "select count(*)::int as n from admin_login_attempts where username = 'qaadmin'",
    )).rows[0].n;
    const ok = await page.evaluate(async () => {
      const r = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "qaadmin", password: "definitely-wrong" }),
      });
      return r.status;
    });
    assert(ok !== 200, "a wrong admin password was accepted");
    // EITHER proves the protection: attempts are being recorded for later
    // lockout, or the account is already locked and refusing without recording.
    // Requiring only the first fails on a working lockout, which is backwards.
    assert(after > 0 || ok === 429,
      `six failed admin logins were neither recorded nor throttled (last status ${ok})`);

    // And a CORRECT password must still work once the lockout clears, or this
    // is a denial of service rather than a protection.
    await q("delete from admin_login_attempts where username = 'qaadmin'");
    const good = await page.evaluate(async () => {
      const r = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "qaadmin", password: "QaAdmin123!Pass" }),
      });
      return r.status;
    });
    assert(good === 200, `the correct admin password was refused after the lockout cleared: ${good}`);
    return `${after} attempts recorded, wrong password ${ok}, correct password ${good}`;
  });

  // ---- CSRF -------------------------------------------------------------
  section("2. Cross-site request forgery");

  await step("a cross-site POST to an authenticated API is rejected", async () => {
    const res = await page.evaluate(async (base) => {
      // Origin is set by the browser and cannot be spoofed from script, so this
      // is exercised through the request context with an explicit foreign one.
      const r = await fetch(`${base}/api/account/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketingEmails: true }),
        credentials: "same-origin",
      });
      return r.status;
    }, BASE);
    // Same-origin from the page is allowed; the foreign-origin case is below.
    const foreign = await page.request.post(`${BASE}/api/account/preferences`, {
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      data: { marketingEmails: true },
    });
    assert(foreign.status() === 403,
      `a cross-origin POST was answered ${foreign.status()}, not 403 (same-origin answered ${res})`);
    return "403 for a foreign Origin";
  });

  await step("every cookie-authenticated API prefix is CSRF-guarded", async () => {
    const probes = [
      "/api/account/preferences", "/api/auth/session", "/api/admin/auth/login",
      "/api/membership/cancel", "/api/partner/referral-code",
    ];
    const bad = [];
    for (const path of probes) {
      const res = await page.request.post(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        data: {},
      });
      if (res.status() !== 403) bad.push(`${path} -> ${res.status()}`);
    }
    assert(!bad.length, `not CSRF-guarded: ${bad.join(", ")}`);
    return `${probes.length} prefixes all 403`;
  });

  // ---- Injection --------------------------------------------------------
  section("3. Script injected through a profile field");

  await step("a name containing a script tag is not executed when rendered back", async () => {
    const email = `xss.${stamp}@example.test`;
    const payload = `<img src=x onerror="window.__xss=1">`;
    await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', $2, '{"role":"customer"}', now(), now())
       on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data`,
      [email, JSON.stringify({ full_name: payload, role: "customer" })],
    );

    const victim = await browser.newContext();
    const v = await victim.newPage();
    let dialogged = false;
    v.on("dialog", async (d) => { dialogged = true; await d.dismiss(); });
    await passAgeGate(v);
    await signIn(v, email, "HarnessPass123!");
    await v.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await v.waitForTimeout(2500);

    const executed = await v.evaluate(() => Boolean(window.__xss));
    const renderedLiterally = await v.evaluate(
      (p) => document.body.innerHTML.includes(p),
      payload,
    );
    const shownAsText = await v.evaluate(() => document.body.innerText.includes("<img src=x"));
    await victim.close();

    assert(!executed, "script from a profile field EXECUTED on the account page");
    assert(!dialogged, "a dialog was raised from injected profile content");
    assert(!renderedLiterally, "the payload was written into the DOM as live markup");
    return shownAsText ? "escaped and shown as text" : "not executed, not injected";
  });

  // ---- Ambassador lifecycle --------------------------------------------
  section("4. Ambassador lifecycle");

  const AMB = "qa.ambassador@example.test";
  const APPLICANT = "qa.applicant@example.test";
  const PW = "HarnessPass123!";

  await step("an approved ambassador reaches their own portal", async () => {
    const amb = await browser.newContext();
    const a = await amb.newPage();
    await passAgeGate(a);
    await signIn(a, AMB, PW);
    assert(await sessionCookie(amb), "the ambassador could not sign in");
    await a.goto(`${BASE}/account/ambassador`, { waitUntil: "domcontentloaded" });
    await a.waitForTimeout(3000);
    const url = a.url();
    const text = await a.evaluate(() => document.body.innerText);
    await amb.close();
    assert(!/\/account\/login/.test(url), "the approved ambassador was bounced to the login form");
    assert(/QAAMB/.test(text), "the portal does not show this ambassador's own referral code");
    return "portal reachable, own code shown";
  });

  await step("an ambassador sees their own rate, not somebody else's", async () => {
    const amb = await browser.newContext();
    const a = await amb.newPage();
    await passAgeGate(a);
    await signIn(a, AMB, PW);
    const summary = await a.evaluate(async () => {
      const r = await fetch("/api/partner/summary", { credentials: "same-origin" });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    await amb.close();
    assert(summary.status === 200, `/api/partner/summary answered ${summary.status}`);
    const blob = JSON.stringify(summary.body);
    assert(blob.includes("QAAMB"), "the summary does not carry this ambassador's own code");
    assert(!blob.includes("QAPEND"), "the summary leaked the pending applicant's code");
    return "own code only";
  });

  await step("a pending applicant cannot reach the ambassador portal", async () => {
    const app = await browser.newContext();
    const a = await app.newPage();
    await passAgeGate(a);
    await signIn(a, APPLICANT, PW);
    assert(await sessionCookie(app), "the applicant could not sign in at all");
    await a.goto(`${BASE}/account/ambassador`, { waitUntil: "domcontentloaded" });
    await a.waitForTimeout(3000);
    const text = await a.evaluate(() => document.body.innerText);
    await app.close();
    // Either bounced, or shown a pending state — but never the live portal with
    // a payable code and earnings.
    assert(!/QAPEND/.test(text) || /pending|review|not yet/i.test(text),
      "a pending applicant was shown a live ambassador portal");
    return "no live portal for a pending applicant";
  });

  await step("an ambassador cannot read another ambassador's record by id", async () => {
    const other = (await q(
      "select id from partners where email <> $1 limit 1", [AMB],
    )).rows[0];
    if (!other) return SKIP("no second partner record exists to probe");
    const amb = await browser.newContext();
    const a = await amb.newPage();
    await passAgeGate(a);
    await signIn(a, AMB, PW);
    // PATCH, not GET: this route exports PATCH and DELETE only, so a GET
    // answers 405 before any guard runs and proves nothing about authorization.
    const res = await a.evaluate(async (id) => {
      const r = await fetch(`/api/admin/partners/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_status", status: "approved" }),
        credentials: "same-origin",
      });
      return r.status;
    }, other.id);
    await amb.close();
    assert([401, 403, 404].includes(res), `an ambassador reached another partner's admin record: ${res}`);

    // And the change must not have landed.
    const after = (await q("select status from partners where id = $1", [other.id])).rows[0];
    assert(after, "the probed partner row vanished");
    return `refused with ${res}; target still ${after.status}`;
  });

  // ---- Cookie hardening -------------------------------------------------
  section("5. Cookie and token hygiene");

  await step("the session cookie is httpOnly and SameSite=Lax", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await passAgeGate(p);
    await signIn(p, AMB, PW);
    const cookie = (await ctx.cookies()).find((c) => c.name === "vl_session_token");
    assert(cookie, "no session cookie to inspect");
    const visibleToScript = await p.evaluate(() => document.cookie.includes("vl_session_token"));
    await ctx.close();
    assert(cookie.httpOnly, "the session cookie is not httpOnly");
    assert(String(cookie.sameSite).toLowerCase() === "lax", `SameSite is ${cookie.sameSite}`);
    assert(!visibleToScript, "the session cookie is readable from document.cookie");
    return "httpOnly, SameSite=Lax, invisible to script";
  });

  await step("no auth token is written into the harness log", async () => {
    if (!HARNESS_LOG || !existsSync(HARNESS_LOG)) return SKIP("no harness log to inspect");
    const text = readFileSync(HARNESS_LOG, "utf8");
    // A JWT has three dot-separated base64url segments and starts with the
    // standard header. A token in a log is a token an attacker can spend.
    const jwts = text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g) ?? [];
    assert(!jwts.length, `${jwts.length} JWT-shaped strings were logged, e.g. ${jwts[0]?.slice(0, 40)}...`);
    const hashed = text.match(/harness-hashed-[0-9a-f-]{36}/g) ?? [];
    return `no JWTs logged${hashed.length ? ` (${hashed.length} harness confirmation tokens, which are fixture data)` : ""}`;
  });

  await browser.close();

  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  console.log(`\n${results.length} steps: ${results.length - failed.length - skipped.length} passed, `
    + `${failed.length} failed, ${skipped.length} skipped.`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f.section} :: ${f.name}\n      ${f.detail}`);
  }
  if (skipped.length) {
    console.log("\nSkipped — these are NOT verified:");
    for (const sk of skipped) console.log(`  ${sk.section} :: ${sk.name}\n      ${sk.detail}`);
  }
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
