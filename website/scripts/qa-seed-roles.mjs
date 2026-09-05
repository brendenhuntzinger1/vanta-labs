#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SEED THE ROLES THE ROLE-BOUNDARY HARNESS IS SUPPOSED TO PROBE.
//
// qa-role-boundaries.mjs builds its role list from QA_ROLES:
//
//     const roles = [{ name: "guest", cookie: null }];
//     for (const [name, email] of Object.entries(JSON.parse(process.env.QA_ROLES ?? "{}")))
//
// Nothing in this repository sets QA_ROLES — not package.json, not any script,
// not the docs. So the loop body has never run, `roles` has never contained
// anything but a signed-out guest, and the run still ends with:
//
//     166 probes, 0 findings.
//     Every protected route refused every role that should not reach it.
//
// ...and exits 0. That sentence is the evidence behind this repo's role
// isolation claims, and the only thing it has ever established is that a
// signed-out visitor is refused. Nothing was known about whether a verified
// customer can read another customer's orders, whether an applicant can reach
// the approved ambassador's portal, or whether a customer can reach admin.
//
// The same is true of the fixtures the abuse harness signs in as
// (qa.ambassador@example.test, qa.applicant@example.test): nothing creates
// them, so those sections cannot pass from a clean harness database either.
//
// This script creates one account per role, prints the QA_ROLES value that
// names them, and is idempotent. Harness only — it refuses to run against
// anything but a local database, and the passwords are the shim's clear-text
// ones, which is why that shim documents itself as not a security boundary.
//
//   node scripts/qa-seed-roles.mjs
//   export QA_ROLES="$(node scripts/qa-seed-roles.mjs --print-only)"
// ---------------------------------------------------------------------------

import { randomBytes, scryptSync } from "node:crypto";

import pg from "pg";

const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";

// A seeder that can reach production is a seeder that will one day be pointed
// at it. Loopback only, and never the production project's host.
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  console.error(`refusing to seed a non-local database: ${DB.replace(/\/\/[^@]*@/, "//***@")}`);
  process.exit(1);
}

const PASSWORD = process.env.QA_PASSWORD ?? "HarnessPass123!";
const ADMIN_USER = process.env.QA_ADMIN_USER ?? "qaadmin";
const ADMIN_PASS = process.env.QA_ADMIN_PASS ?? "QaAdmin123!Pass";

/**
 * One account per role the audit brief names. `confirmed` is what separates an
 * unverified customer from a verified one, and it is REAL here — the gotrue
 * shim reports email_confirmed_at verbatim rather than assuming it.
 */
const ROLES = [
  { name: "unverified", email: "qa.unverified@example.test", confirmed: false },
  { name: "verified", email: "qa.verified@example.test", confirmed: true },
  { name: "member", email: "qa.member@example.test", confirmed: true, member: true },
  { name: "applicant", email: "qa.applicant@example.test", confirmed: true, partner: { status: "pending", code: "QAAPPLY" } },
  { name: "ambassador", email: "qa.ambassador@example.test", confirmed: true, partner: { status: "approved", code: "QAAMB" } },
  // A SECOND customer with data of their own, so cross-account isolation has
  // something to actually cross. Probing one account against itself proves
  // nothing.
  { name: "other", email: "qa.other@example.test", confirmed: true },
];

/** The scheme src/lib/admin-auth.ts verifies with: scryptSync(password, salt, 64), hex. */
function adminHash(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

const client = new pg.Client({ connectionString: DB });
await client.connect();

const printOnly = process.argv.includes("--print-only");
const log = printOnly ? () => {} : (...a) => console.log(...a);

try {
  const ids = {};

  for (const role of ROLES) {
    const { rows } = await client.query(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data,
                               email_confirmed_at, created_at)
       values ($1, $2, $3, '{"role":"customer"}'::jsonb, $4, now())
       on conflict (email) do update
         set encrypted_password = excluded.encrypted_password,
             raw_user_meta_data = excluded.raw_user_meta_data,
             email_confirmed_at = excluded.email_confirmed_at
       returning id`,
      [
        role.email,
        PASSWORD,
        JSON.stringify({ full_name: `QA ${role.name}`, role: "customer" }),
        role.confirmed ? new Date().toISOString() : null,
      ],
    );
    ids[role.name] = rows[0].id;
    log(`  ${role.name.padEnd(11)} ${role.email}  ${role.confirmed ? "confirmed" : "UNCONFIRMED"}`);

    if (role.partner) {
      const approvedAt = role.partner.status === "approved" ? new Date().toISOString() : null;
      const { rows: partnerRows } = await client.query(
        `insert into partners (auth_user_id, name, email, referral_code, status, approved_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (referral_code) do update
           set auth_user_id = excluded.auth_user_id,
               email = excluded.email,
               status = excluded.status,
               approved_at = excluded.approved_at
         returning id`,
        [ids[role.name], `QA ${role.name}`, role.email, role.partner.code, role.partner.status, approvedAt],
      );
      // BOTH ROWS, SHARED ID — the shape production always has. The apply RPC
      // (create_partner_application) and the admin invite write partners AND
      // ambassadors in one transaction, and the referral-code service, checkout
      // and commission accrual all read `ambassadors`. Seeding partners alone
      // manufactured a state production cannot be in, and the audit reported
      // it as "approved ambassador cannot change their code" (AA-3).
      await client.query(
        `insert into ambassadors (id, auth_user_id, name, email, referral_code, status, approved_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update
           set auth_user_id = excluded.auth_user_id,
               email = excluded.email,
               referral_code = excluded.referral_code,
               status = excluded.status,
               approved_at = excluded.approved_at`,
        [partnerRows[0].id, ids[role.name], `QA ${role.name}`, role.email, role.partner.code, role.partner.status, approvedAt],
      );
      log(`              partner ${role.partner.code} (${role.partner.status})`);
    }

    if (role.member) {
      // Tier is whatever the harness has; membership_tiers is seeded by
      // setup-local-harness.sh. Skip rather than fail if it is empty — the
      // member role still exists as a confirmed customer.
      const tier = await client.query("select id from membership_tiers order by created_at limit 1");
      if (tier.rows[0]) {
        await client.query(
          `insert into customer_memberships (user_id, tier_id, status, started_at, renews_at, next_billing_at)
           values ($1, $2, 'active', now(), now() + interval '30 days', now() + interval '30 days')
           on conflict do nothing`,
          [ids[role.name], tier.rows[0].id],
        );
        log(`              membership active`);
      } else {
        log(`              NO membership_tiers row — member role is a plain customer`);
      }
    }
  }

  const { salt, hash } = adminHash(ADMIN_PASS);
  await client.query(
    `insert into admin_credentials (username, password_salt, password_hash, role, is_active)
     values ($1, $2, $3, 'super_admin', true)
     on conflict (username) do update
       set password_salt = excluded.password_salt,
           password_hash = excluded.password_hash,
           role = excluded.role,
           is_active = true`,
    [ADMIN_USER, salt, hash],
  );
  log(`  admin       ${ADMIN_USER} (super_admin)`);

  const qaRoles = Object.fromEntries(ROLES.map((r) => [r.name, r.email]));
  if (printOnly) {
    process.stdout.write(JSON.stringify(qaRoles));
  } else {
    log("");
    log("Run the boundary harness against these with:");
    log(`  QA_ROLES='${JSON.stringify(qaRoles)}' npm run qa:roles`);
  }
} finally {
  await client.end();
}
