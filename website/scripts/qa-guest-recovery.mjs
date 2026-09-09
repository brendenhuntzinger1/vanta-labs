// ---------------------------------------------------------------------------
// THE GUEST CART-RECOVERY JOURNEY, DRIVEN ADVERSARIALLY.
//
// The programme's defining failure was that a guest — someone who typed an
// email into the checkout field and never made an account — clicked a recovery
// email, had the click recorded by the public tracker, and was then handed a
// sign-in page for an account they do not have. Clicks were recorded and
// conversions were structurally impossible.
//
// This script drives the whole chain against the running harness with NO
// SESSION AND NO ADMIN COOKIE — the exact condition that used to fail — and
// then attacks it. Every scenario the brief names is a numbered case below.
//
//   node scripts/qa-guest-recovery.mjs
//
// Requires the harness (setup-local-harness.sh, pgrst-shim, harness:start) and
// psql on PATH. It seeds and cleans up its OWN carts, and never touches a real
// customer's row.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const PSQL = ["-h", "/tmp", "-p", "55432", "-U", "postgres", "-d", "storefront", "-tAc"];
const SECRET = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const GRANT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

let pass = 0;
let fail = 0;
const failures = [];

function sql(query) {
  // psql prints the command tag ("INSERT 0 1") after a RETURNING row, so the
  // first line is the value and everything after it is noise.
  return execFileSync("psql", [...PSQL, query], { encoding: "utf8" }).trim().split("\n")[0].trim();
}

function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The same construction cart-recovery-grant.ts uses. Minted here so the
 *  script can forge and mutate tokens the app would never produce. */
function mintGrant(cartId, expiresAtMs = Date.now() + GRANT_TTL_MS) {
  const sig = createHmac("sha256", SECRET)
    .update(`cart_recovery_grant:v1:${cartId}:${expiresAtMs}`)
    .digest("hex")
    .slice(0, 32);
  return `v1.${cartId}.${expiresAtMs}.${sig}`;
}

async function get(path, { cookie, redirect = "manual" } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    redirect,
    headers: cookie ? { cookie } : {},
  });
  let body = null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) body = await response.json().catch(() => null);
  return { status: response.status, location: response.headers.get("location"), body, response };
}

function seedCart(label, items, valueCents, extra = {}) {
  const status = extra.status ?? "active";
  const id = sql(`
    insert into abandoned_carts (session_id, email, customer_name, items, cart_value_cents,
                                 first_seen_at, last_updated_at, status)
    values ('qa-${label}', 'qa-${label}@example.test', 'QA ${label}',
            '${JSON.stringify(items).replace(/'/g, "''")}'::jsonb, ${valueCents},
            now(), now(), '${status}')
    returning id;`);
  return id;
}

function cleanup() {
  sql("delete from abandoned_cart_emails where abandoned_cart_id in (select id from abandoned_carts where email like 'qa-%@example.test');");
  sql("delete from abandoned_carts where email like 'qa-%@example.test';");
}

async function main() {
  if (!SECRET) {
    console.error("No UNSUBSCRIBE_SECRET / SUPABASE_SERVICE_ROLE_KEY — cannot mint grants.");
    process.exit(2);
  }
  cleanup();

  const LIVE = { slug: "bpc-157-10mg", name: "SPOOFED BY THE BROWSER", quantity: 2, unitPrice: 0.01 };
  const DEAD = { slug: "discontinued-thing", name: "Discontinued Thing", quantity: 1, unitPrice: 40 };
  const RENAMED = { slug: "bacteriostatic-water", name: "Bacteriostatic Water", quantity: 1, unitPrice: 14.99 };

  const cart = seedCart("main", [LIVE, RENAMED, DEAD], 15398);
  const other = seedCart("other", [LIVE], 13800);
  const converted = seedCart("converted", [LIVE], 13800, { status: "recovered" });

  console.log("\n1. THE WALL, WITH NO GRANT — the failure this whole change exists to remove");
  const noGrant = await get(`/cart/restore?id=${cart}`);
  check("an anonymous shopper with no grant is still sent to sign-in",
    noGrant.status === 307 && String(noGrant.location).includes("/account/login"),
    `${noGrant.status} ${noGrant.location}`);
  const apiNoGrant = await get(`/api/cart/restore?id=${cart}`);
  check("and the API still refuses them", apiNoGrant.status === 401, String(apiNoGrant.status));

  console.log("\n2. A VALID GRANT — the guest gets their cart, with no account");
  const grant = mintGrant(cart);
  const valid = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(grant)}`);
  check("the restore succeeds", valid.status === 200 && valid.body?.success === true, String(valid.status));
  check("the catalogue's name is used, never the one the beacon stored",
    valid.body?.items?.some((i) => i.name === "BPC-157 10mg")
    && !JSON.stringify(valid.body?.items ?? []).includes("SPOOFED"));
  check("the renamed slug is repaired rather than left to break checkout",
    valid.body?.items?.some((i) => i.slug === "recon-water"));
  check("the dead line is dropped and the shopper is told which",
    !valid.body?.items?.some((i) => i.slug === "discontinued-thing")
    && String(valid.body?.notice ?? "").includes("Discontinued Thing"));
  check("the price comes from the catalogue, not the $0.01 the beacon posted",
    valid.body?.items?.find((i) => i.slug === "bpc-157-10mg")?.unitPrice === 69);
  const setCookie = valid.response.headers.get("set-cookie") ?? "";
  check("the token is exchanged for an httpOnly cookie",
    setCookie.includes("vl_cart_grant=") && setCookie.toLowerCase().includes("httponly"));

  console.log("\n3. THE GRANT CARRIES THE JOURNEY, AND ONLY THE JOURNEY");
  const cookie = `vl_cart_grant=${grant}`;
  for (const [path, label] of [
    ["/cart", "the cart page"],
    ["/checkout", "the checkout page"],
    ["/api/catalog/promotions", "the promotions the cart prices with"],
  ]) {
    const res = await get(path, { cookie });
    check(`${label} is reachable with a grant`, res.status !== 307 && res.status !== 401,
      String(res.status));
  }
  console.log("   and the surfaces it must NEVER open:");
  for (const [path, label] of [
    ["/account/orders", "order history"],
    ["/api/account/me", "the account API"],
    ["/products", "the gated catalogue"],
    ["/", "the storefront"],
    // A REAL admin GET route. /api/admin/orders answers 405 to a GET — its own
    // method guard — which proves nothing about admission, so asserting on it
    // was measuring the wrong thing.
    ["/api/admin/products", "the admin API"],
    ["/admin/orders", "the admin UI"],
  ]) {
    const res = await get(path, { cookie });
    check(`${label} stays shut`, res.status === 307 || res.status === 401 || res.status === 404,
      String(res.status));
    check(`${label} returns no data`, res.body === null || res.body?.success !== true);
  }

  console.log("\n4. TAMPERING");
  const forCartB = mintGrant(other);
  const crossed = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(forCartB)}`);
  check("a grant for another cart cannot open this one", crossed.status === 404, String(crossed.status));
  check("and the refusal says nothing about either cart",
    crossed.body?.error === "This cart link is no longer valid");

  const repointed = (() => { const p = mintGrant(other).split("."); p[1] = cart; return p.join("."); })();
  const repointedRes = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(repointed)}`);
  check("a grant repointed at this cart does not verify", repointedRes.status === 401,
    String(repointedRes.status));

  const flipped = (() => { const g = mintGrant(cart); return `${g.slice(0, -1)}${g.slice(-1) === "a" ? "b" : "a"}`; })();
  const flippedRes = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(flipped)}`);
  check("a flipped signature byte does not verify", flippedRes.status === 401, String(flippedRes.status));

  const expired = mintGrant(cart, Date.now() - 1000);
  const expiredRes = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(expired)}`);
  check("an expired grant does not verify", expiredRes.status === 401, String(expiredRes.status));

  const rawUuid = await get(`/api/cart/restore?id=${cart}&k=${cart}`);
  check("the bare cart UUID is not a credential", rawUuid.status === 401, String(rawUuid.status));

  console.log("\n5. THE CART ALREADY CONVERTED between the send and the click");
  const convertedRes = await get(`/api/cart/restore?id=${converted}&k=${encodeURIComponent(mintGrant(converted))}`);
  check("the items still restore", convertedRes.status === 200 && convertedRes.body?.success === true);
  check("but no recovery code is armed for a cart that is no longer active",
    convertedRes.body?.coupon === undefined);

  console.log("\n6. REPEATED CLICKS are ordinary behaviour, not an attack");
  const first = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(grant)}`);
  const second = await get(`/api/cart/restore?id=${cart}&k=${encodeURIComponent(grant)}`);
  check("the same grant answers identically every time",
    JSON.stringify(first.body?.items) === JSON.stringify(second.body?.items));

  console.log("\n7. THE FUNNEL RECORDS THE MIDDLE IT USED TO BE MISSING");
  const restoredAt = sql(`select coalesce(restored_at::text,'') from abandoned_carts where id='${cart}';`);
  check("restored_at is stamped once a buyable cart went back", restoredAt.length > 0);
  const notRestored = sql(`select coalesce(restored_at::text,'') from abandoned_carts where id='${other}';`);
  check("and is NOT stamped for a cart nobody restored", notRestored.length === 0);

  cleanup();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); cleanup(); process.exit(1); });
