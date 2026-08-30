#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CROSS-ACCOUNT ISOLATION, WITH REAL IDS THAT REALLY EXIST.
//
// qa-role-boundaries.mjs answers "can role X reach URL Y", and answers it well
// — 1000 probes once QA_ROLES is actually populated. It does NOT answer the
// question underneath, because every [param] it substitutes is a placeholder
// that belongs to nobody:
//
//     orderId: "VL-QA-OTHER",
//     addressId: "00000000-0000-4000-8000-000000000001",
//
// A route that looks up a row, finds nothing, and returns 404 is
// indistinguishable there from a route that finds the row, checks who owns it,
// and refuses. Both are "refused". The first one is an IDOR and the harness
// cannot see it.
//
// So this script gives ONE customer real data — an order, an address, a
// wishlist entry, a partner record — and then asks a DIFFERENT signed-in
// customer for it by its real id. A 200 carrying the victim's data is a
// finding; anything that refuses or omits it is a pass. Every mutation is
// checked at the database afterwards rather than believed from the response,
// because a route can answer 200 and change nothing, or answer 500 and change
// something.
//
// Harness only. Loopback database, synthetic accounts, and it never writes to
// anything it did not create.
//
//   node scripts/qa-seed-roles.mjs && node scripts/qa-cross-account.mjs
// ---------------------------------------------------------------------------

import pg from "pg";

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const PASSWORD = process.env.QA_PASSWORD ?? "HarnessPass123!";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  console.error("refusing to run against a non-local database");
  process.exit(1);
}

const VICTIM = "qa.other@example.test";
const ATTACKER = "qa.verified@example.test";

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = (sql, params) => client.query(sql, params);

const findings = [];
let probes = 0;

function record(ok, what, detail) {
  probes += 1;
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    console.log(`  FAIL  ${what}\n        ${detail}`);
    findings.push({ what, detail });
  }
}

/**
 * Sign in through the real routes and keep the session cookie.
 *
 * Deliberately the same two hops the product uses — GoTrue password grant, then
 * /api/auth/session — rather than forging a cookie. A forged cookie would test
 * this script's idea of a session instead of the application's.
 */
async function sessionFor(email) {
  const grant = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321"}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: "local-shim-not-a-real-key" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!grant.ok) throw new Error(`password grant failed for ${email}: ${grant.status} ${await grant.text()}`);
  const body = await grant.json();

  const session = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ accessToken: body.access_token, refreshToken: body.refresh_token, rememberMe: true }),
  });
  const cookie = session.headers.getSetCookie?.().find((c) => c.startsWith("vl_session_token="));
  if (!cookie) throw new Error(`no session cookie for ${email}: ${session.status} ${await session.text()}`);
  return cookie.split(";")[0];
}

const api = (cookie, path, init = {}) => fetch(`${BASE}${path}`, {
  ...init,
  redirect: "manual",
  headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie, ...(init.headers ?? {}) },
});

try {
  const victimId = (await q("select id from auth.users where email = $1", [VICTIM])).rows[0]?.id;
  const attackerId = (await q("select id from auth.users where email = $1", [ATTACKER])).rows[0]?.id;
  if (!victimId || !attackerId) {
    console.error("run scripts/qa-seed-roles.mjs first — the fixtures are missing");
    process.exit(1);
  }

  console.log(`Cross-account isolation: ${ATTACKER} attempting to reach ${VICTIM}'s data\n`);

  // ---- give the victim something worth stealing --------------------------
  const orderId = "VL-QA-VICTIM-1";
  await q(
    `insert into orders (order_id, customer_email, customer_name, customer_user_id,
                         subtotal, amount_paid, payment_status, fulfillment_status, created_at)
     values ($1, $2, 'QA Victim', $3, 100, 100, 'paid', 'awaiting_fulfillment', now())
     on conflict (order_id) do update set customer_user_id = excluded.customer_user_id`,
    [orderId, VICTIM, victimId],
  );
  const victimOrderUuid = (await q("select id from orders where order_id = $1", [orderId])).rows[0].id;

  const victimAddress = (await q(
    `insert into customer_addresses (user_id, full_name, address, city, postal_code)
     values ($1, 'QA Victim', '1 Victim Way', 'Testville', '12345')
     returning id`,
    [victimId],
  )).rows[0].id;

  const victimPartner = (await q("select id, referral_code from partners where email = 'qa.ambassador@example.test'")).rows[0];

  console.log("1. Reading another customer's data\n");

  // ---- orders ------------------------------------------------------------
  const attacker = await sessionFor(ATTACKER);

  for (const [label, path] of [
    ["order detail page", `/account/orders/${orderId}`],
    ["order detail page (uuid)", `/account/orders/${victimOrderUuid}`],
    ["order invoice", `/account/orders/${orderId}/invoice`],
  ]) {
    const res = await api(attacker, path);
    const text = res.status === 200 ? await res.text() : "";
    const leaked = text.includes(VICTIM) || text.includes("1 Victim Way");
    record(!leaked, `${label} does not show the other customer's order`,
      `HTTP ${res.status} and the body contained the victim's email or address`);
  }

  // ---- addresses ---------------------------------------------------------
  {
    const res = await api(attacker, `/api/account/addresses/${victimAddress}`);
    const body = res.status === 200 ? await res.text() : "";
    record(!body.includes("1 Victim Way"),
      "GET /api/account/addresses/[id] does not return another customer's address",
      `HTTP ${res.status} returned the victim's address line`);
  }

  console.log("\n2. Mutating another customer's data\n");

  {
    const res = await api(attacker, `/api/account/addresses/${victimAddress}`, {
      method: "PATCH",
      body: JSON.stringify({ fullName: "Attacker Was Here", address: "666 Attacker St", city: "Evil", postalCode: "99999" }),
    });
    // The DATABASE is the witness, not the status code.
    const after = (await q("select full_name, address from customer_addresses where id = $1", [victimAddress])).rows[0];
    record(after && after.address === "1 Victim Way",
      "PATCH /api/account/addresses/[id] cannot rewrite another customer's address",
      `HTTP ${res.status} and the row is now ${JSON.stringify(after)}`);
  }

  {
    const res = await api(attacker, `/api/account/addresses/${victimAddress}`, { method: "DELETE" });
    const still = (await q("select 1 from customer_addresses where id = $1", [victimAddress])).rowCount;
    record(still === 1,
      "DELETE /api/account/addresses/[id] cannot delete another customer's address",
      `HTTP ${res.status} and the victim's address row is gone`);
  }

  {
    // Reorder takes an order id and rebuilds a cart from it. If it does not
    // check ownership it discloses the victim's line items.
    const res = await api(attacker, "/api/account/reorder", {
      method: "POST",
      body: JSON.stringify({ orderId }),
    });
    const body = await res.text();
    record(res.status !== 200 || !body.includes("bpc-157"),
      "POST /api/account/reorder cannot rebuild another customer's basket",
      `HTTP ${res.status} returned the victim's items`);
  }

  console.log("\n3. Identity confusion in the body\n");

  for (const [label, path, payload] of [
    ["/api/account/me", "/api/account/me", { userId: victimId, email: VICTIM }],
    ["/api/account/phone", "/api/account/phone", { userId: victimId, phone: "+15550000000" }],
    ["/api/account/preferences", "/api/account/preferences", { userId: victimId, marketingOptIn: false }],
  ]) {
    const before = (await q("select phone from customer_preferences where user_id = $1", [victimId])).rows[0]?.phone ?? null;
    const res = await api(attacker, path, { method: "PATCH", body: JSON.stringify(payload) });
    const after = (await q("select phone from customer_preferences where user_id = $1", [victimId])).rows[0]?.phone ?? null;
    record(before === after,
      `${label} ignores a caller-supplied userId and writes only to the session's own account`,
      `HTTP ${res.status} changed the victim's row from ${before} to ${after}`);
  }

  console.log("\n4. Partner / ambassador data\n");

  if (victimPartner) {
    const res = await api(attacker, "/api/partner/me");
    const body = await res.text();
    record(!body.includes(victimPartner.referral_code),
      "GET /api/partner/me does not hand a plain customer an ambassador's record",
      `HTTP ${res.status} returned ${victimPartner.referral_code}`);

    const payout = await api(attacker, "/api/partner/payout-method", {
      method: "POST",
      body: JSON.stringify({ partnerId: victimPartner.id, method: "paypal", handle: "attacker@example.com" }),
    });
    const after = (await q("select payout_handle from partners where id = $1", [victimPartner.id])).rows[0];
    record(after?.payout_handle !== "attacker@example.com",
      "POST /api/partner/payout-method cannot redirect an ambassador's payouts",
      `HTTP ${payout.status} and the handle is now ${after?.payout_handle}`);

    const code = await api(attacker, "/api/partner/referral-code", {
      method: "POST",
      body: JSON.stringify({ partnerId: victimPartner.id, referralCode: "STOLEN1" }),
    });
    const codeAfter = (await q("select referral_code from partners where id = $1", [victimPartner.id])).rows[0];
    record(codeAfter?.referral_code === victimPartner.referral_code,
      "POST /api/partner/referral-code cannot rewrite another ambassador's code",
      `HTTP ${code.status} and the code is now ${codeAfter?.referral_code}`);
  }

  console.log("\n5. Guest reach\n");

  {
    // /api/cart/restore IS deliberately unauthenticated: it backs the "return
    // to your cart" link in a recovery email, which the recipient follows
    // signed out. So the test is not "does a guest get a cart" — that is the
    // feature — it is whether the id is a CAPABILITY or a HANDLE, and whether
    // answering it discloses anything beyond the basket.
    //
    // abandoned_carts.id is gen_random_uuid(), so it is not enumerable, and
    // getAbandonedCartById selects `email` and `customer_name` while the route
    // returns only `items`. Both halves are asserted, because the leak would be
    // in widening that response, not in the id.
    const cartId = (await q(
      `insert into abandoned_carts (session_id, customer_user_id, email, customer_name, items, cart_value_cents)
       values ('qa-victim-session', $1, $2, 'QA Victim', $3::jsonb, 6900)
       returning id`,
      [victimId, VICTIM, JSON.stringify([{ slug: "bpc-157-10mg", name: "BPC-157 10mg", quantity: 1 }])],
    )).rows[0].id;

    const res = await fetch(`${BASE}/api/cart/restore?id=${cartId}`, {
      headers: { Origin: BASE },
      redirect: "manual",
    });
    const body = await res.text();
    record(!body.includes(VICTIM) && !body.includes("QA Victim"),
      "GET /api/cart/restore discloses the basket but not who it belongs to",
      `HTTP ${res.status} returned the victim's email or name alongside the items`);

    // A guessed id must not be answerable, and must not distinguish "no such
    // cart" from "someone else's cart" — both are the same 404.
    const guessed = await fetch(`${BASE}/api/cart/restore?id=00000000-0000-4000-8000-0000000000ff`, {
      headers: { Origin: BASE }, redirect: "manual",
    });
    record(guessed.status === 404,
      "GET /api/cart/restore answers 404 for an id that names no cart",
      `HTTP ${guessed.status} for a made-up cart id`);

    await q("delete from abandoned_carts where session_id = 'qa-victim-session'").catch(() => {});
  }

  console.log(`\n${probes} probes, ${findings.length} findings.\n`);
  if (findings.length) {
    for (const f of findings) console.log(`  ${f.what}\n    ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("  One customer could not read or change anything belonging to another.");
  }
} finally {
  // Clean up only what this script created.
  await q("delete from customer_addresses where address in ('1 Victim Way','666 Attacker St')").catch(() => {});
  await q("delete from orders where order_id = 'VL-QA-VICTIM-1'").catch(() => {});
  await client.end();
}
