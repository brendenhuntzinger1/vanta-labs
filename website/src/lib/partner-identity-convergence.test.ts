import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { suiteDatabaseUrl } from "@/lib/test-support/suite-database";

// ---------------------------------------------------------------------------
// IDENTITY CONVERGENCE — the half of the BRUTUS defect that was never fixed.
//
// The original incident: PAUL existed in `ambassadors` (added by the admin, no
// auth account). The same person later signed up as BRUTUS and applied.
// createPartnerApplication matched on auth_user_id, found nothing, and minted a
// second identity. The partners insert committed, the ambassadors insert hit
// ambassadors_email_key, and the system was left inconsistent.
//
// The repair made both inserts one transaction, so there is no orphan any more.
// It did NOT make the system RECOGNISE that the pre-added ambassador is this
// person. So the application now fails cleanly instead of corrupting -- and the
// applicant can never apply at all, however many times they retry.
//
// These tests run the REAL plpgsql from src/lib/sql against a real Postgres.
// A fake in-memory RPC cannot prove this: the defect lives in the interaction
// between the function body and a UNIQUE constraint, and a fake that does not
// model the constraint reports success on the exact input that fails in
// production. That is how this survived a green suite.
//
// Requires a throwaway Postgres. Set VANTA_TEST_DATABASE_URL, e.g.
//   initdb -D /tmp/vantapg -A trust -U postgres
//   pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
//   VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npx vitest run
// Skipped (loudly) when unset, so CI without a database does not report a false
// pass -- see the guard below.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const SQL_DIR = join(process.cwd(), "src", "lib", "sql");

/** Mirrors production partners/ambassadors, including the asymmetric constraints. */
const FIXTURE_DDL = `
create extension if not exists pgcrypto;
drop table if exists public.ambassadors cascade;
drop table if exists public.partners cascade;
drop table if exists public.referral_orders cascade;

create table public.partners (
  id uuid default gen_random_uuid() not null,
  auth_user_id uuid,
  name text not null,
  email text,
  referral_code text not null,
  status text default 'pending'::text not null,
  commission_percent numeric default 10 not null,
  invited_at timestamptz, approved_at timestamptz, disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  commission_percent_locked boolean default false not null,
  first_name text, last_name text, phone text, social text,
  follower_count integer, preferred_referral_code text,
  payout_method text default 'cash'::text not null,
  payout_handle text, payout_updated_at timestamptz,
  customer_discount_percent numeric,
  constraint partners_pkey primary key (id),
  constraint partners_auth_user_id_key unique (auth_user_id),
  constraint partners_referral_code_key unique (referral_code)
);

-- Only so the baseline file's affiliate_balances() will compile. Not exercised here.
create table public.referral_orders (
  id uuid default gen_random_uuid() primary key,
  ambassador_id uuid,
  commission_amount numeric,
  payment_status text,
  approved_for_payout_at timestamptz
);

create table public.ambassadors (
  id uuid default gen_random_uuid() not null,
  name text not null,
  email text not null,
  referral_code text not null,
  commission_percent numeric default 10.00 not null,
  status text default 'pending'::text not null,
  created_at timestamptz default now() not null,
  auth_user_id uuid,
  invited_at timestamptz, approved_at timestamptz, disabled_at timestamptz,
  created_by uuid,
  updated_at timestamptz default now() not null,
  commission_percent_locked boolean default false not null,
  first_name text, last_name text, phone text, social text,
  follower_count integer, preferred_referral_code text,
  payout_method text default 'cash'::text not null,
  payout_handle text, payout_updated_at timestamptz,
  customer_discount_percent numeric,
  constraint ambassadors_pkey primary key (id),
  constraint ambassadors_email_key unique (email),
  constraint ambassadors_referral_code_key unique (referral_code)
);
`;

const ADMIN_UID = "99999999-9999-9999-9999-999999999999";
const PRE_ADDED_ID = "11111111-1111-1111-1111-111111111111";
const HER_AUTH_UID = "22222222-2222-2222-2222-222222222222";
const NEW_PARTNER_ID = "33333333-3333-3333-3333-333333333333";
const HER_EMAIL = "paula@example.test";

let client: Client | null = null;

async function loadSql(file: string) {
  await client!.query(readFileSync(join(SQL_DIR, file), "utf8"));
}

/** The site's apply path: match by auth_user_id, then call the RPC. */
async function applyThroughSite(partnerId: string, referralCode: string) {
  const pre = await client!.query(
    "select id, status, referral_code from public.partners where auth_user_id = $1",
    [HER_AUTH_UID],
  );
  if (pre.rowCount) return { viaAppLayer: true, row: pre.rows[0] };

  const res = await client!.query(
    "select public.create_partner_application($1,$2,$3,$4,$5,$6,$7) as result",
    [partnerId, HER_AUTH_UID, "Paula Tester", HER_EMAIL, referralCode, 15.0,
     JSON.stringify({ first_name: "Paula", last_name: "Tester", phone: "555-0100" })],
  );
  return { viaAppLayer: false, result: res.rows[0].result };
}

const describeDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  // Not a silent skip. A skipped suite that nobody notices is how a defect
  // reaches production behind a green run.
  process.stderr.write(
    "\n[partner-identity-convergence] SKIPPED: set VANTA_TEST_DATABASE_URL to a " +
    "throwaway Postgres to run the identity-convergence proofs. These cover " +
    "audit finding F-009 and are NOT covered by any in-memory test.\n",
  );
}

describeDb("partner identity convergence (real plpgsql)", () => {
  beforeEach(async () => {
    if (!client) {
      client = new Client({ connectionString: await suiteDatabaseUrl(DATABASE_URL!, "identity_convergence") });
      await client.connect();
    }
    await client.query(FIXTURE_DDL);
    await loadSql("BASELINE-live-functions-2026-08-25.sql");
    await loadSql("partner-identity-convergence.sql");

    // The admin pre-adds an ambassador: email known, no auth account yet, and a
    // deliberately non-default commission the admin chose.
    await client.query(
      `insert into public.ambassadors
         (id, name, email, referral_code, status, commission_percent, customer_discount_percent,
          auth_user_id, created_by, invited_at)
       values ($1,'Paula Tester',$2,'PAULA','pending',15.00,12.50,null,$3, now())`,
      [PRE_ADDED_ID, HER_EMAIL, ADMIN_UID],
    );
  });

  afterAll(async () => {
    if (client) { await client.end(); client = null; }
  });

  it("lets a pre-added ambassador complete an application instead of dead-ending", async () => {
    const outcome = await applyThroughSite(NEW_PARTNER_ID, "PAULA2");
    expect(outcome.viaAppLayer).toBe(false);

    // Before the repair this threw 23505 on ambassadors_email_key and the whole
    // application rolled back.
    const partners = await client!.query("select * from public.partners");
    const ambassadors = await client!.query("select * from public.ambassadors");

    expect(ambassadors.rowCount).toBe(1);
    expect(partners.rowCount).toBe(1);
    expect(partners.rows[0].auth_user_id).toBe(HER_AUTH_UID);
    expect(ambassadors.rows[0].auth_user_id).toBe(HER_AUTH_UID);
  });

  it("adopts the pre-added identity rather than minting a second one", async () => {
    await applyThroughSite(NEW_PARTNER_ID, "PAULA2");

    const rows = await client!.query(
      "select p.id as pid, a.id as aid from public.partners p full outer join public.ambassadors a on p.id = a.id",
    );
    expect(rows.rowCount).toBe(1);
    // Same id in both tables -- the invariant every one of the 7 live partners holds.
    expect(rows.rows[0].pid).toBe(rows.rows[0].aid);
    // And it is the ADMIN's row that was adopted, not a freshly minted id.
    expect(rows.rows[0].pid).toBe(PRE_ADDED_ID);
  });

  it("preserves the rates and referral code the admin configured", async () => {
    await applyThroughSite(NEW_PARTNER_ID, "PAULA2");

    const a = (await client!.query("select * from public.ambassadors")).rows[0];
    const p = (await client!.query("select * from public.partners")).rows[0];

    // The applicant asked for PAULA2. The admin had already issued PAULA, which
    // may be in circulation. The issued code wins.
    expect(a.referral_code).toBe("PAULA");
    expect(p.referral_code).toBe("PAULA");
    // 15% was the admin's choice, not the 10% program default.
    expect(Number(a.commission_percent)).toBe(15);
    expect(Number(p.commission_percent)).toBe(15);
    expect(Number(a.customer_discount_percent)).toBe(12.5);
  });

  it("fills in the applicant's own details on the adopted row", async () => {
    await applyThroughSite(NEW_PARTNER_ID, "PAULA2");
    const a = (await client!.query("select * from public.ambassadors")).rows[0];
    expect(a.first_name).toBe("Paula");
    expect(a.phone).toBe("555-0100");
  });

  it("is idempotent: re-applying returns the same identity and creates nothing", async () => {
    await applyThroughSite(NEW_PARTNER_ID, "PAULA2");
    const second = await applyThroughSite("44444444-4444-4444-4444-444444444444", "PAULA3");

    // Second time the app layer short-circuits: she now has a partners row.
    expect(second.viaAppLayer).toBe(true);
    expect(second.row.id).toBe(PRE_ADDED_ID);

    expect((await client!.query("select * from public.partners")).rowCount).toBe(1);
    expect((await client!.query("select * from public.ambassadors")).rowCount).toBe(1);
  });

  it("does NOT hand over an identity that another account already claimed", async () => {
    // Someone else's auth account already owns this ambassador row.
    await client!.query(
      "update public.ambassadors set auth_user_id = $1 where id = $2",
      ["88888888-8888-8888-8888-888888888888", PRE_ADDED_ID],
    );

    await expect(applyThroughSite(NEW_PARTNER_ID, "PAULA2")).rejects.toThrow();

    // And nothing was created for the impostor.
    expect((await client!.query("select * from public.partners")).rowCount).toBe(0);
    const a = (await client!.query("select * from public.ambassadors")).rows[0];
    expect(a.auth_user_id).toBe("88888888-8888-8888-8888-888888888888");
  });

  it("still creates a brand-new identity when nothing was pre-added", async () => {
    await client!.query("delete from public.ambassadors");

    const outcome = await applyThroughSite(NEW_PARTNER_ID, "PAULA2");
    expect(outcome.result.created).toBe(true);

    const p = (await client!.query("select * from public.partners")).rows[0];
    const a = (await client!.query("select * from public.ambassadors")).rows[0];
    expect(p.id).toBe(NEW_PARTNER_ID);
    expect(a.id).toBe(NEW_PARTNER_ID);
    expect(p.referral_code).toBe("PAULA2");
    // A fresh applicant gets the rate the caller passed, not the admin's 15.
    expect(Number(a.commission_percent)).toBe(15);
  });
});
