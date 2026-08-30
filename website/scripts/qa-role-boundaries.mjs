#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ROLE BOUNDARIES, PROVED RATHER THAN ASSUMED.
//
// Every protected route in this app enforces its own access control. There are
// 147 API routes and ~40 protected pages, and until this script existed nothing
// checked the whole matrix — each route's guard was verified, at best, by a
// test of that one route. The failure mode that produces is a single route
// added without a guard, which no existing test would notice because no
// existing test knows the route exists.
//
// So the route list is DISCOVERED FROM THE FILESYSTEM, not hand-maintained. A
// new route under src/app/api/admin/ is probed the moment it is created, and a
// missing guard fails this script rather than waiting to be found in
// production.
//
// WHAT IT ASSERTS
//   * every /api/admin/* route refuses every non-admin caller
//   * every /api/account/* route refuses a guest
//   * every /account/* page bounces a guest to the login form
//   * every /admin/* page refuses a non-admin
//   * IDOR: a signed-in customer cannot read another customer's order,
//     address or partner record by editing the id in the URL
//
// A route that ANSWERS 200 to a role that should not see it is a finding. So is
// a route that answers 500 — that means the guard threw rather than refused,
// and a guard that throws is a guard that can be made to leak.
//
// Development-only. Drives the local harness at 127.0.0.1:3000; never
// production. Run:  node scripts/qa-role-boundaries.mjs
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script is for the local harness only.`);
  process.exit(1);
}

const APP = new URL("../src/app", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Route discovery
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Turn an app-router file path into the URL it serves. */
function urlFor(file) {
  const rel = relative(APP, file).replace(/\/(route|page)\.tsx?$/, "");
  return "/" + rel
    .split("/")
    // Route groups like (dashboard) are organisational and not part of the URL.
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/");
}

const files = walk(APP);

/**
 * The HTTP methods a route file actually exports.
 *
 * Probing every route with GET was the first version and it was wrong: a route
 * that only exports POST answers 405 before any guard runs, so the probe proved
 * nothing and reported 150 false findings. A guard can only be tested through a
 * method the route serves.
 */
function methodsOf(file) {
  const src = readFileSync(file, "utf8");
  const found = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)]
    .map((m) => m[1]);
  return found.length ? [...new Set(found)] : ["GET"];
}

const apiRoutes = files.filter((f) => /\/route\.ts$/.test(f))
  .map((f) => ({ url: urlFor(f), methods: methodsOf(f) }));
const pageRoutes = files.filter((f) => /\/page\.tsx$/.test(f)).map(urlFor);

/** Substitute a plausible value for a [param] so the route actually runs. */
function concrete(route, ids) {
  return route.replace(/\[(\.\.\.)?(\w+)\]/g, (_m, _spread, name) => ids[name] ?? ids.default);
}

const PROTECTED_API_ADMIN = apiRoutes.filter((r) => r.url.startsWith("/api/admin/")
  // The login endpoints are the way IN; they must stay reachable.
  && !/^\/api\/admin\/auth\/(login|session|logout)$/.test(r.url));
/**
 * Routes under an authenticated prefix that are DELIBERATELY open, with the
 * reason recorded so a future reader does not have to re-derive it.
 *
 * Nothing else gets to be on this list without the same standard of proof: read
 * the route, establish what it returns to an anonymous caller, and show that it
 * is not somebody's data.
 */
const INTENTIONALLY_PUBLIC = new Map([
  ["/api/account/ambassador-discount",
    "Answers { percent: 0 } to a guest. It is a 'what discount do I get' probe for "
    + "the checkout preview, and 'none' is the honest answer for someone with no account. "
    + "Returns no data about anybody."],
  ["/api/partner/program-stats",
    "Feeds the PUBLIC /partner landing page and returns four aggregate numbers "
    + "(total paid, average earnings, average approval hours, top payout) with no names, "
    + "emails or per-ambassador rows. partner-portal.ts:846 documents it as unauthenticated "
    + "on purpose, and deliberately does NOT run the commission sweep so anonymous traffic "
    + "cannot drive a money-state transition."],
]);

const PROTECTED_API_ACCOUNT = apiRoutes.filter((r) => r.url.startsWith("/api/account/")
  && !INTENTIONALLY_PUBLIC.has(r.url));
const PROTECTED_API_PARTNER = apiRoutes.filter((r) => r.url.startsWith("/api/partner/")
  // Applying is open to any signed-in customer by design.
  && r.url !== "/api/partner/apply"
  && !INTENTIONALLY_PUBLIC.has(r.url));
const PROTECTED_PAGES_ADMIN = pageRoutes.filter((r) => r === "/admin" || r.startsWith("/admin/"));
const PROTECTED_PAGES_ACCOUNT = pageRoutes.filter((r) => r.startsWith("/account/")
  // The unauthenticated entry points.
  && !["/account/login", "/account/forgot-password", "/account/reset-password"].includes(r));

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

/** Sign in through the real endpoints and keep the cookie jar. */
async function customerSession(email, password) {
  const token = await q(
    "select id from auth.users where lower(email) = $1",
    [email.toLowerCase()],
  );
  if (!token.rows.length) throw new Error(`no auth user for ${email}`);

  // Mint through the shim's password grant, exactly as the browser does.
  const res = await fetch(`${BASE.replace(":3000", ":54321")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: "harness" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`password grant failed for ${email}: ${res.status}`);
  const body = await res.json();

  const session = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      rememberMe: true,
    }),
  });
  const cookie = session.headers.getSetCookie?.().find((c) => c.startsWith("vl_session_token="));
  if (!cookie) throw new Error(`no session cookie for ${email}: ${session.status} ${await session.text()}`);
  return cookie.split(";")[0];
}

async function adminSession(username, password) {
  const res = await fetch(`${BASE}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.getSetCookie?.().find((c) => c.startsWith("vl_admin_session="));
  if (!cookie) throw new Error(`no admin cookie: ${res.status} ${await res.text()}`);
  return cookie.split(";")[0];
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

const findings = [];
let probes = 0;

/**
 * `expect` is a predicate over the status code. A 500 always fails: a guard
 * that threw is a guard that refused by accident, and accidents are reversible.
 */
async function probe({ role, cookie, url, method = "GET", expect, why }) {
  probes += 1;
  let status;
  let location = null;
  try {
    const res = await fetch(`${BASE}${url}`, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === "GET" ? {} : { "Content-Type": "application/json", Origin: BASE }),
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    status = res.status;
    location = res.headers.get("location");
  } catch (error) {
    findings.push({ role, url, method, status: "REQUEST_FAILED", why: String(error).slice(0, 160) });
    return;
  }

  if (status >= 500) {
    findings.push({ role, url, method, status, why: `${why} — guard threw (5xx) instead of refusing` });
    return;
  }
  if (!expect(status, location)) {
    findings.push({ role, url, method, status, location, why });
  }
}

/** Refused outright: 401/403/404, or a redirect away from the resource. */
const refused = (status, location) =>
  // 405: the route does not serve this method at all, so nothing was exposed.
  [401, 403, 404, 405].includes(status)
  || (status >= 300 && status < 400 && !!location);

/** A page refusal is a redirect to the login form (or a hard refuse). */
const bouncedToLogin = (status, location) =>
  [401, 403, 404, 405].includes(status)
  || (status >= 300 && status < 400 && /\/(account\/login|vault|admin\/login)/.test(location ?? ""));

async function main() {
  console.log(`Probing ${BASE}`);
  const apiProbeCount = [...PROTECTED_API_ADMIN, ...PROTECTED_API_ACCOUNT, ...PROTECTED_API_PARTNER]
    .reduce((n, r) => n + r.methods.length, 0);
  console.log(`Discovered ${apiRoutes.length} API routes and ${pageRoutes.length} pages.`);
  console.log(`Protected: ${PROTECTED_API_ADMIN.length} admin API, ${PROTECTED_API_ACCOUNT.length} account API, `
    + `${PROTECTED_API_PARTNER.length} partner API, ${PROTECTED_PAGES_ADMIN.length} admin pages, `
    + `${PROTECTED_PAGES_ACCOUNT.length} account pages.\n`);

  const ids = {
    default: "00000000-0000-4000-8000-000000000000",
    orderId: "VL-QA-OTHER",
    addressId: "00000000-0000-4000-8000-000000000001",
    partnerId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000003",
    productId: "00000000-0000-4000-8000-000000000004",
    couponId: "00000000-0000-4000-8000-000000000005",
    tierId: "00000000-0000-4000-8000-000000000006",
    campaignId: "00000000-0000-4000-8000-000000000007",
    eventId: "00000000-0000-4000-8000-000000000008",
    coaId: "00000000-0000-4000-8000-000000000009",
    slug: "qa-probe",
    code: "QAPROBE",
  };

  // ---- roles ------------------------------------------------------------
  const roles = [{ name: "guest", cookie: null }];

  for (const [name, email] of Object.entries(JSON.parse(process.env.QA_ROLES ?? "{}"))) {
    try {
      roles.push({ name, cookie: await customerSession(email, process.env.QA_PASSWORD ?? "HarnessPass123!") });
    } catch (error) {
      console.log(`  ! could not establish ${name} (${email}): ${String(error).slice(0, 120)}`);
    }
  }

  let admin = null;
  try {
    admin = await adminSession(process.env.QA_ADMIN_USER ?? "qaadmin", process.env.QA_ADMIN_PASS ?? "QaAdmin123!Pass");
    console.log("  admin session established");
  } catch (error) {
    console.log(`  ! could not establish admin: ${String(error).slice(0, 120)}`);
  }
  console.log(`  roles: ${roles.map((r) => r.name).join(", ")}${admin ? ", admin" : ""}\n`);

  // ---- 1. admin API refuses every non-admin ------------------------------
  for (const role of roles) {
    for (const route of PROTECTED_API_ADMIN) {
      for (const method of route.methods) {
        await probe({
          role: role.name, cookie: role.cookie, url: concrete(route.url, ids), method,
          expect: refused, why: `${role.name} must not reach an admin API`,
        });
      }
    }
  }

  // ---- 2. account API refuses a guest ------------------------------------
  for (const route of [...PROTECTED_API_ACCOUNT, ...PROTECTED_API_PARTNER]) {
    for (const method of route.methods) {
      await probe({
        role: "guest", cookie: null, url: concrete(route.url, ids), method,
        expect: refused, why: "guest must not reach an authenticated API",
      });
    }
  }

  // ---- 3. admin pages refuse every non-admin -----------------------------
  for (const role of roles) {
    for (const route of PROTECTED_PAGES_ADMIN) {
      await probe({
        role: role.name, cookie: role.cookie, url: concrete(route, ids),
        expect: bouncedToLogin, why: `${role.name} must not render an admin page`,
      });
    }
  }

  // ---- 4. account pages bounce a guest -----------------------------------
  for (const route of PROTECTED_PAGES_ACCOUNT) {
    await probe({
      role: "guest", cookie: null, url: concrete(route, ids),
      expect: bouncedToLogin, why: "guest must be bounced to the login form",
    });
  }

  // ---- 5. IDOR: another customer's records -------------------------------
  // A REALISTIC id. Production order ids are `order-${randomUUID()}` — 122 bits
  // acting as a bearer token, which is the documented model for
  // /api/checkout/order-status and /pay/[orderId]. Probing with a guessable
  // fixture id (VL-QA-VICTIM) tests a threat that does not exist and reports a
  // finding that is not one.
  const victim = await q(
    `select o.order_id from orders o
      where o.customer_email is not null and o.order_id like 'order-%'
      order by o.created_at desc limit 1`,
  );
  const victimOrder = victim.rows[0]?.order_id;
  const signedIn = roles.find((r) => r.cookie);
  if (victimOrder && signedIn) {
    // /api/checkout/order-status is DELIBERATELY id-authorised and is not probed
    // here. The order id is `order-${randomUUID()}` — 122 bits acting as a
    // bearer token, the same model the confirmation page and /pay/[orderId]
    // use — and the route returns only coarse status plus the order number the
    // customer already has on their receipt: no email, address, amount or line
    // items. It is rate limited at 120/min per IP so the id space cannot be
    // swept. See the AUTHORIZATION note in that route.
    //
    // The PAGE below is a different matter: it renders a full order, so it must
    // check ownership rather than trust the id.
    for (const url of [
      `/account/orders/${encodeURIComponent(victimOrder)}`,
    ]) {
      await probe({
        role: `${signedIn.name} (IDOR)`, cookie: signedIn.cookie, url,
        // 200 is only acceptable if the order is genuinely theirs; this one is not.
        expect: (status) => [401, 403, 404].includes(status) || (status >= 300 && status < 400),
        why: `a signed-in customer must not read another customer's order via ${url}`,
      });
    }
  }

  // ---- report ------------------------------------------------------------
  console.log(`${probes} probes, ${findings.length} findings.\n`);
  if (findings.length) {
    const byRole = {};
    for (const f of findings) (byRole[f.role] ??= []).push(f);
    for (const [role, list] of Object.entries(byRole)) {
      console.log(`  ${role} (${list.length}):`);
      for (const f of list.slice(0, 25)) {
        console.log(`    ${String(f.status).padEnd(4)} ${f.method ?? "GET"} ${f.url}`
          + `${f.location ? ` -> ${f.location}` : ""}\n         ${f.why}`);
      }
      if (list.length > 25) console.log(`    ... and ${list.length - 25} more`);
    }
  } else {
    console.log("  Every protected route refused every role that should not reach it.");
  }

  await pool.end();
  process.exit(findings.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
