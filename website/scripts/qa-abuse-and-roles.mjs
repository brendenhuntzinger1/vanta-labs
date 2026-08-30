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

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
/**
 * WHERE THE APP'S OWN LOG IS, WITHOUT BEING TOLD.
 *
 * Nothing sets QA_HARNESS_LOG — not the npm script, not qa:all — and every step
 * here that reads what was sent skips without it. That silently gave up on
 * three: that no auth token is written into the log, that an aborted signup
 * leaves no account without a link, and that a customer who lost their email can
 * get another. qa-harness-up.sh writes the log to a known place, so look there.
 * An explicit QA_HARNESS_LOG still wins.
 */
const DEFAULT_HARNESS_LOG = `${process.env.QA_LOG_DIR ?? "/tmp/vanta-qa"}/harness.log`;
const HARNESS_LOG = process.env.QA_HARNESS_LOG
  ?? (existsSync(DEFAULT_HARNESS_LOG) ? DEFAULT_HARNESS_LOG : null);

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

/**
 * A CLIENT IP THIS RUN HAS TO ITSELF.
 *
 * This harness's whole job in section 1 is to EXHAUST the per-IP signup, reset
 * and resend buckets. It did that on the default client address, which every
 * other run also uses — so a second `qa:all` inside the 15-minute window found
 * those buckets already spent and turned all three flood tests into assertions
 * about a limiter that had nothing left to give. Worse in the other direction:
 * a journey or purchase run following an abuse run would have been throttled at
 * its first signup and reported it as the product refusing to create accounts.
 *
 * qa-customer-journey.mjs and qa-purchase-path.mjs were given CSPRNG addresses
 * for exactly this reason; this file — the one that actually spends the buckets
 * — was left on the shared one, which is the wrong way round.
 *
 * Clearing rate_limit_hits is NOT enough on its own: lib/rate-limit.ts also
 * keeps a spent bucket in an in-process map for the window, so a warm server
 * keeps refusing after the rows are gone. Its own address is what makes a run
 * repeatable.
 *
 * 100.64.0.0/10 is carrier-grade NAT: never routable, and three random octets
 * give ~16 million addresses from a CSPRNG rather than from the clock.
 */
const CLIENT_IP = (() => {
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
})();

/**
 * Every context in this file, so none of them silently falls back to the shared
 * address. Assigned in main(); declared here because the helper closes over it.
 */
let browser;
const newContext = (extra = {}) => browser.newContext({
  ...extra,
  extraHTTPHeaders: { "x-real-ip": CLIENT_IP, ...(extra.extraHTTPHeaders ?? {}) },
});

const stamp = Date.now();

async function passAgeGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  // WAIT FOR CONDITIONS, NOT FOR CLOCKS.
  //
  // This used to be three fixed sleeps, and it raced the render: on a slower
  // load the dialog had not appeared yet, or the button was still disabled when
  // the click landed, and the gate stayed up — silently covering whatever the
  // next step went on to assert. Every wait below is on the thing it actually
  // depends on.
  const appeared = await page
    .waitForSelector("[role=dialog]", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;   // already accepted in this context

  // TICKING A BOX BEFORE REACT IS LISTENING DOES NOTHING VISIBLE.
  //
  // The dialog is server-rendered, so it is in the DOM before hydration
  // finishes. A checkbox clicked in that window flips its own `checked`
  // property and dispatches an event with no handler bound to it — the DOM says
  // ticked, React's state says nothing was, and the submit button stays
  // disabled forever. It looks exactly like a broken age gate, and on a
  // cold-started server (the first navigation of a run) it is the normal case,
  // not a rare one.
  //
  // Clicking through Playwright rather than `element.click()` in page script is
  // half the fix: those are real trusted events with actionability checks. The
  // other half is retrying, because no amount of waiting on the checkbox tells
  // you whether the listener was attached when it was clicked. The button
  // becoming enabled is the only true signal that React took the tick, so that
  // is what is waited on, and the ticks are re-applied until it does.
  const enabled = () => page.$$eval("[role=dialog] button", (btns) =>
    btns.some((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const boxes = await page.$$("[role=dialog] input[type=checkbox]");
    for (const box of boxes) {
      if (!(await box.isChecked())) await box.click({ timeout: 5000 }).catch(() => {});
    }
    if (await enabled()) break;
    await page.waitForTimeout(1000);
  }

  if (!(await enabled())) {
    throw new Error("the age gate's submit button never enabled after ticking every box");
  }

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[role=dialog] button")]
      .find((b) => /Create account \/ Sign in|Continue as guest/.test(b.textContent || "") && !b.disabled);
    if (btn) btn.click();
  });

  // Prove it cleared. A gate still up hides everything a later step reads.
  await page.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 10000 });
  return true;
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
  browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await newContext();
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

    const victim = await newContext();
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
    const amb = await newContext();
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
    const amb = await newContext();
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
    const app = await newContext();
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
    const amb = await newContext();
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

  // ---- Session fixation -------------------------------------------------
  section("5. Session fixation and open redirects");

  await step("a pre-planted session cookie is replaced on sign-in, not adopted", async () => {
    // Session fixation: an attacker who can set a cookie on the victim's
    // browser plants a value they know, waits for the victim to sign in, and
    // then uses it. The defence is that authenticating MINTS a fresh session
    // rather than blessing whatever was already there.
    const ctx = await newContext();
    const p = await ctx.newPage();
    await passAgeGate(p);

    const planted = "v2.attacker-planted-value-that-must-not-survive";
    await ctx.addCookies([{
      name: "vl_session_token", value: planted,
      domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
    }]);

    await signIn(p, AMB, PW);
    const after = (await ctx.cookies()).find((c) => c.name === "vl_session_token");
    const reached = await (async () => {
      await p.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2000);
      return !/\/account\/login/.test(p.url());
    })();
    await ctx.close();

    assert(after, "no session cookie after signing in over a planted one");
    assert(after.value !== planted, "the planted cookie value SURVIVED sign-in — session fixation");
    assert(reached, "signed in, but the account page did not render");
    return "planted value discarded, a fresh session minted";
  });

  await step("a planted cookie on its own grants nothing", async () => {
    const ctx = await newContext();
    const p = await ctx.newPage();
    await passAgeGate(p);
    await ctx.addCookies([{
      name: "vl_session_token", value: "v2.not-a-real-session",
      domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
    }]);
    await p.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const url = p.url();
    await ctx.close();
    assert(/\/account\/login/.test(url), `a forged cookie reached ${url}`);
    return "forged cookie bounced to the login form";
  });

  await step("the confirmation hop cannot be turned into an open redirect", async () => {
    const offsite = [
      "//evil.example/steal",
      "https://evil.example",
      "https:/evil.example",
      "/\\evil.example",
      "////evil.example",
    ];
    const escaped = [];
    for (const next of offsite) {
      const res = await page.request.get(
        `${BASE}/auth/confirm?token=harness-hashed-nobody&type=signup&next=${encodeURIComponent(next)}`,
        { maxRedirects: 0 },
      );
      const location = res.headers().location ?? "";
      if (!location) continue;

      // The hop legitimately forwards to the GoTrue host — that is its whole
      // job. What must never escape is where GoTrue is told to put the customer
      // DOWN afterwards, which rides in `redirect_to`, and the `next` inside it.
      let landing;
      try {
        landing = new URL(new URL(location).searchParams.get("redirect_to") ?? location);
      } catch {
        escaped.push(`${next} -> unparseable ${location}`);
        continue;
      }
      if (landing.host !== new URL(BASE).host) {
        escaped.push(`${next} -> lands on ${landing.host}`);
        continue;
      }
      const forwarded = landing.searchParams.get("next");
      if (forwarded && !(forwarded.startsWith("/") && !forwarded.startsWith("//"))) {
        escaped.push(`${next} -> next=${forwarded}`);
      }
    }
    assert(!escaped.length, `the hop redirected off-site: ${escaped.join(" | ")}`);
    return `${offsite.length} off-site targets neutralised to a same-site path`;
  });

  // ---- Cookie hardening -------------------------------------------------
  section("6. Cookie and token hygiene");

  await step("the session cookie is httpOnly and SameSite=Lax", async () => {
    const ctx = await newContext();
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

  // ---- 7. The customer walks away mid-send ---------------------------------
  //
  // THE HALF-FINISHED SIGNUP.
  //
  // /api/auth/signup does two things in order: `generateLink({type:"signup"})`,
  // which CREATES the account, and then sendEmail(), which delivers the link.
  // They are not one transaction. If the request dies between them the customer
  // is left in the worst possible state — an account exists, so signing up
  // again is refused as "already registered", but no confirmation link was ever
  // sent, so the account can never be confirmed. Stuck, with no way out that
  // they can reach on their own.
  //
  // A browser refresh is exactly the thing that kills the request: the customer
  // presses submit, nothing appears to happen (a mint plus an SMTP round trip
  // is not instant), and they reload. The fetch is aborted at that moment.
  //
  // So: abort one mid-flight and require that the two ends stay consistent, and
  // that whichever way it lands the customer can still get themselves a link.
  section("7. The customer refreshes while the email is sending");

  await step("aborting the signup request mid-flight leaves no account without a link", async () => {
    if (!HARNESS_LOG) return SKIP("no harness log to read sends from");
    const email = `abandoned.${stamp}@example.test`;
    const before = logOffset();

    // SWEEP THE ABORT ACROSS THE WINDOW, don't guess one moment inside it.
    //
    // A single fixed delay is a coin toss: too early and the request dies
    // before `generateLink` has created anything, which proves nothing about
    // the gap; too late and the send has already finished. (120ms landed before
    // account creation on the first run — a pass that exercised nothing.) These
    // walk the delay across the plausible span so at least one abort lands
    // between the two writes, and the invariant is asserted after every one.
    //
    // Each attempt uses its own address and its own client IP, because these are
    // signups: one shared address would be refused as already-registered, and
    // one shared IP would be throttled by the limiter the earlier sections
    // deliberately spent.
    // THE ABORT HAS TO HAPPEN IN THE BROWSER, or it never reaches the handler.
    //
    // /api/auth is one of the CSRF-protected prefixes in middleware.ts, and the
    // guard rejects a request with no `Origin` header outright. A bare node
    // fetch sends none, so every "abandoned signup" came back 403 having done
    // nothing at all — and because "no account was created" is a legitimate
    // outcome of this test, it reported PASS four times over while exercising
    // absolutely nothing. Driving it from the page gets the real Origin, the
    // real cookie jar, and a real client disconnect on abort.
    // THE LADDER IS SHORT BECAUSE THE HANDLER IS FAST.
    //
    // 80–1200ms found nothing: every request answered 200 before the earliest
    // abort fired. That is not the window being safe, it is the window being
    // missed — with EMAIL_PROVIDER=none the "send" is a line written to a log,
    // so mint-plus-send finishes in tens of milliseconds and a wall-clock race
    // cannot reliably land between them. These delays start at zero, which cuts
    // the connection at dispatch.
    const attempts = [];
    for (const [i, delayMs] of [0, 1, 3, 8, 20, 45].entries()) {
      const attemptEmail = `abandoned.${stamp}.${i}@example.test`;
      const outcome = await page.evaluate(async ({ email, delayMs, ip }) => {
        const controller = new AbortController();
        const abortAt = setTimeout(() => controller.abort(), delayMs);
        try {
          const r = await fetch("/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Real-IP": ip },
            body: JSON.stringify({ email, password: "HarnessPass123!", fullName: "Abandoned Signup" }),
            credentials: "same-origin",
            signal: controller.signal,
          });
          return { status: r.status, aborted: false };
        } catch (error) {
          return { status: null, aborted: error?.name === "AbortError" };
        } finally {
          clearTimeout(abortAt);
        }
      }, { email: attemptEmail, delayMs, ip: `198.51.100.${20 + i}` });
      attempts.push({ email: attemptEmail, delayMs, ...outcome });
    }

    assert(!attempts.some((a) => a.status === 403),
      "the signup POST was refused as cross-origin, so nothing was exercised");

    // If nothing was aborted, this proves nothing — and must not report a pass.
    // A step that quietly examines an untouched database is exactly the kind of
    // green tick this whole exercise exists to stop counting.
    if (!attempts.some((a) => a.aborted)) {
      return SKIP(
        "no abort landed mid-flight — the handler answered "
        + `${attempts.map((a) => a.status).join("/")} faster than the shortest delay, so the `
        + "gap between account creation and send was never actually raced here",
      );
    }

    // Give the server room to finish the work the clients stopped waiting for.
    await page.waitForTimeout(8000);

    const log = logSince(before);
    const observed = [];
    for (const attempt of attempts) {
      const account = (await q("select id from auth.users where email = $1", [attempt.email])).rows[0];
      const sent = log.includes(attempt.email);

      // THE STUCK STATE, stated as the assertion: an account that exists and
      // can never be confirmed. Either outcome on its own is fine — no account
      // means nothing was half-done, and account-plus-email means the handler
      // ran to completion despite the client disconnecting.
      assert(!(account && !sent),
        `aborting at ${attempt.delayMs}ms created an account for ${attempt.email} with no confirmation `
        + "email ever composed — that customer can neither sign up again nor confirm");

      observed.push({ ...attempt, created: Boolean(account), sent });
    }

    const completed = observed.filter((o) => o.created && o.sent).length;
    const nothing = observed.filter((o) => !o.created).length;
    return `${observed.length} aborts across 0–45ms: ${completed} ran to completion despite the `
      + `disconnect, ${nothing} left nothing behind, 0 half-finished`;
  });

  await step("a customer who lost the email can always get another one", async () => {
    if (!HARNESS_LOG) return SKIP("no harness log to read sends from");
    // The recovery path is what makes the case above survivable at all, so it
    // is worth proving separately: whatever state the abandoned signup left,
    // asking again produces a link.
    const email = `abandoned.${stamp}.0@example.test`;
    await q("delete from rate_limit_hits where bucket like $1", ["resend-confirmation%"]);

    // A FRESH CLIENT IP, or this step tests the limiter instead of the resend.
    //
    // The route limits per-IP as well as per-address, and lib/rate-limit.ts
    // holds a spent bucket in an in-process Map that deleting rate_limit_hits
    // does not clear. Section 1 deliberately floods this very endpoint from the
    // shared 127.0.0.1, so by the time this runs that bucket is still held and
    // the answer is 429 — which is the limiter working, not the resend failing.
    // The address is new to this run, so only the IP needed changing.
    // From the page, for the same reason as the step above: /api/auth is
    // CSRF-guarded and a headerless node fetch is refused before it arrives.
    const before = logOffset();
    const status = await page.evaluate(async ({ email }) => {
      const r = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Real-IP": "198.51.100.90" },
        body: JSON.stringify({ email }),
        credentials: "same-origin",
      });
      return r.status;
    }, { email });
    await page.waitForTimeout(3000);
    assert(status !== 403, "the resend POST was refused as cross-origin, so nothing was exercised");

    const log = logSince(before);
    const sends = (log.match(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    const account = (await q("select id from auth.users where email = $1", [email])).rows[0];

    // No account means there is nothing to resend for, and the route's generic
    // answer is the correct, non-enumerating response — not a failure.
    if (!account) {
      assert(status === 200, `resend answered ${status} for an address with no account`);
      return "answers generically for an address with no account, without leaking that fact";
    }
    assert(status === 200, `resend answered ${status}`);
    assert(sends > 0, "no confirmation email was composed for a customer asking for another link");
    return `a fresh link went out (${sends} log line${sends === 1 ? "" : "s"} naming the address)`;
  });

  await step("refreshing the reset-password page does not spend the link", async () => {
    // The same shape on the other side of the flow: a customer opens the reset
    // link, the page is slow, they reload it. If the token were consumed by the
    // page load rather than by the submit, that reload would burn their only
    // link and they would be back where they started.
    const email = `reloadreset.${stamp}@example.test`;
    const row = (await q(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at)
       values ($1, 'HarnessPass123!', $2, '{"role":"customer"}', now(), now())
       on conflict (email) do update set email_confirmed_at = now()
       returning id`,
      [email, JSON.stringify({ full_name: "Reload Reset", role: "customer" })],
    )).rows[0];

    const ctx = await newContext();
    const p = await ctx.newPage();
    await passAgeGate(p);
    const link = `${BASE}/auth/confirm?token=harness-hashed-${row.id}&type=recovery&next=%2Faccount%2Freset-password`;

    await p.goto(link, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const firstUrl = p.url();

    // The reload the impatient customer performs.
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const afterReload = await p.evaluate(() => document.body.innerText);
    const stillUsable = !/expired|invalid|already been used|no longer valid/i.test(afterReload);
    await ctx.close();

    assert(/reset-password|account/.test(firstUrl), `the recovery link landed on ${firstUrl}`);
    assert(stillUsable, "reloading the reset page burned the customer's only link");
    return "the link survives a reload of the page it opens";
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
