import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { suiteDatabaseUrl } from "@/lib/test-support/suite-database";

// ---------------------------------------------------------------------------
// THE ADMIN INVITE DOOR — the other half of the BRUTUS defect.
//
// F-009 made the SELF-SERVICE apply path atomic and convergent, by routing it
// through the create_partner_application RPC. The ADMIN INVITE path was never
// routed through anything: createPartnerInvite still writes `partners` and then
// `ambassadors` as two independent PostgREST statements, with no transaction
// and no identity lookup.
//
// `partners` has NO unique email; `ambassadors` does. So when the invited email
// already belongs to an ambassador -- which is exactly what "the admin pre-added
// this person" means -- the first insert COMMITS and the second one violates
// ambassadors_email_key. There is no transaction to roll the first one back.
//
// What that leaves behind is the BRUTUS row: a `partners` row with a live,
// unique-claimed referral code and no `ambassadors` twin. Because
// validate_referral_code reads `ambassadors`, that code is dead at checkout --
// it looks issued and earns nothing.
//
// It also DEFEATS the F-009 repair. The orphan carries auth_user_id, so when the
// invitee later applies, both the app layer and the RPC match on auth_user_id,
// find the orphan, and return it as "already applied". Adoption never runs, and
// the person's real approved identity stays stranded in `ambassadors` forever.
//
// These tests run the REAL createPartnerInvite against a REAL Postgres carrying
// the REAL asymmetric constraints. An in-memory fake cannot prove any of it: the
// defect lives entirely in the interaction between two un-transacted statements
// and a UNIQUE constraint, and a fake that does not model that constraint
// reports success on the exact input that fails in production. That is how this
// survived a green suite -- the same way F-009 did.
//
// Requires a throwaway Postgres. Set VANTA_TEST_DATABASE_URL, e.g.
//   initdb -D /tmp/vantapg -A trust -U postgres
//   pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
//   VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npx vitest run
// Skipped (loudly) when unset, so CI without a database cannot report a false
// pass.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const SQL_DIR = join(process.cwd(), "src", "lib", "sql");

const ADMIN_UID = "99999999-9999-9999-9999-999999999999";
const PRE_ADDED_ID = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE_UID = "88888888-8888-8888-8888-888888888888";
const HER_EMAIL = "paula@example.test";

/** Mirrors production partners/ambassadors, including the asymmetric constraints. */
const FIXTURE_DDL = `
create extension if not exists pgcrypto;
drop table if exists public.admin_audit_logs cascade;
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

create table public.admin_audit_logs (
  id uuid default gen_random_uuid() primary key,
  actor_user_id uuid,
  action text,
  target_table text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz default now() not null
);
`;

let client: Client | null = null;

/** Auth users the invite path has minted, so the stub can behave like Supabase Auth. */
const authUsersByEmail = new Map<string, string>();

// ---------------------------------------------------------------------------
// A supabaseAdmin shaped like the real one but backed by REAL Postgres, so
// every insert meets the real constraints. This is the whole point: the defect
// is invisible to any fake that does not enforce ambassadors_email_key.
// ---------------------------------------------------------------------------
function realInsert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const values = keys.map((k) => {
    const v = row[k];
    // jsonb columns arrive as plain objects; everything else passes through.
    return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(",");
  return client!
    .query(`insert into public.${table} (${keys.join(",")}) values (${placeholders})`, values)
    .then(() => ({ data: null, error: null }))
    .catch((error: unknown) => ({ data: null, error }));
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/templates", () => ({
  ambassadorApplicationReceivedTemplate: () => ({ subject: "s", html: "h" }),
  ambassadorApprovedTemplate: () => ({ subject: "s", html: "h" }),
  ambassadorDeniedTemplate: () => ({ subject: "s", html: "h" }),
  ambassadorPayoutSentTemplate: () => ({ subject: "s", html: "h" }),
  newAmbassadorApplicationTemplate: () => ({ subject: "s", html: "h" }),
  ambassadorInviteTemplate: () => ({ subject: "s", html: "h" }),
  referralCodeAssignedTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "owner@example.test" }),
  getReferralProgramConfig: async () => ({
    enabled: true, commissionsPaused: false, defaultCommissionPercent: 10,
    discountPercent: 10, personalDiscountPercent: 20,
  }),
}));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: 100, minimumPayoutThreshold: 100, commissionHoldDays: 14,
  }),
  getAmbassadorMarketingResources: async () => [],
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    auth: {
      resend: async () => ({ data: {}, error: null }),
      admin: {
        // Supabase Auth refuses to re-invite an address that already has an
        // account. Modelled because it decides whether the DB half runs at all.
        inviteUserByEmail: async (email: string) => {
          if (authUsersByEmail.has(email)) {
            return { data: { user: null }, error: { message: "User already registered" } };
          }
          const id = `aaaaaaaa-0000-4000-8000-${String(authUsersByEmail.size + 1).padStart(12, "0")}`;
          authUsersByEmail.set(email, id);
          return { data: { user: { id } }, error: null };
        },
        // The invite is now minted rather than mailed by Supabase, so the app
        // can send it branded — see inviteAmbassadorUser. Same refusal for an
        // address that already has an account, because that refusal is what
        // these tests are about.
        generateLink: async ({ type, email }: { type: string; email: string }) => {
          if (type !== "invite") {
            return { data: null, error: { message: `unexpected generateLink type ${type}` } };
          }
          if (authUsersByEmail.has(email)) {
            return { data: null, error: { message: "User already registered" } };
          }
          const id = `aaaaaaaa-0000-4000-8000-${String(authUsersByEmail.size + 1).padStart(12, "0")}`;
          authUsersByEmail.set(email, id);
          return {
            data: { properties: { action_link: `https://example.test/invite/${id}` }, user: { id } },
            error: null,
          };
        },
      },
    },
    from: (table: string) => ({ insert: (row: Record<string, unknown>) => realInsert(table, row) }),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      const keys = Object.keys(params);
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      const values = keys.map((k) => {
        const v = params[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      try {
        const res = await client!.query(`select public.${fn}(${args}) as result`, values);
        return { data: res.rows[0].result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  },
}));

const { createPartnerInvite } = await import("@/lib/partner-portal");

async function loadSql(file: string) {
  await client!.query(readFileSync(join(SQL_DIR, file), "utf8"));
}

/** A partners row with no ambassadors twin — the BRUTUS shape. */
async function orphanPartners() {
  const res = await client!.query(
    `select p.id, p.email, p.referral_code, p.commission_percent
       from public.partners p
       left join public.ambassadors a on a.id = p.id
      where a.id is null`,
  );
  return res.rows;
}

async function invite(name: string, email: string, commissionPercent = 10) {
  return createPartnerInvite({
    name, email, commissionPercent,
    createdByUserId: ADMIN_UID,
    actorUsername: "owner",
    ipAddress: null,
    userAgent: null,
  });
}

const describeDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  // Not a silent skip. A skipped suite that nobody notices is how a defect
  // reaches production behind a green run.
  process.stderr.write(
    "\n[partner-invite-atomicity] SKIPPED: set VANTA_TEST_DATABASE_URL to a " +
    "throwaway Postgres to run the admin-invite atomicity proofs. These cover " +
    "the admin half of the BRUTUS defect and are NOT covered by any in-memory test.\n",
  );
}

describeDb("createPartnerInvite (real Postgres, real constraints)", () => {
  beforeEach(async () => {
    if (!client) {
      client = new Client({ connectionString: await suiteDatabaseUrl(DATABASE_URL!, "invite_atomicity") });
      await client.connect();
    }
    authUsersByEmail.clear();
    await client.query(FIXTURE_DDL);
    await loadSql("BASELINE-live-functions-2026-08-25.sql");
    await loadSql("partner-identity-convergence.sql");
    await loadSql("partner-invite-convergence.sql");
  });

  afterAll(async () => {
    if (client) { await client.end(); client = null; }
  });

  // -- The defect -----------------------------------------------------------

  describe("when the invited email already belongs to a pre-added ambassador", () => {
    beforeEach(async () => {
      // The admin pre-added her earlier: approved, with rates the admin chose,
      // and no auth account yet. This is a normal, supported operation.
      await client!.query(
        `insert into public.ambassadors
           (id, name, email, referral_code, status, commission_percent,
            customer_discount_percent, auth_user_id, created_by, invited_at)
         values ($1,'Paula Tester',$2,'PAULA','approved',17.50,12.50,null,$3, now())`,
        [PRE_ADDED_ID, HER_EMAIL, ADMIN_UID],
      );
    });

    it("leaves no orphan partners row behind", async () => {
      await invite("Paula Tester", HER_EMAIL).catch(() => undefined);

      // Before the repair: one orphan, carrying a referral code nothing honours.
      expect(await orphanPartners()).toEqual([]);
    });

    it("adopts the admin's ambassador instead of minting a second identity", async () => {
      await invite("Paula Tester", HER_EMAIL).catch(() => undefined);

      const rows = await client!.query(
        `select p.id as pid, a.id as aid
           from public.partners p
           full outer join public.ambassadors a on p.id = a.id`,
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].pid).toBe(rows.rows[0].aid);
      // The ADMIN's row survived — not a freshly minted one.
      expect(rows.rows[0].pid).toBe(PRE_ADDED_ID);
    });

    it("preserves the referral code and rates the admin configured", async () => {
      await invite("Paula Tester", HER_EMAIL, 10).catch(() => undefined);

      const a = (await client!.query("select * from public.ambassadors")).rows[0];
      // The invite form defaulted to 10%. The admin had already set 17.5% and
      // issued PAULA, which may be in circulation. Both must survive.
      expect(a.referral_code).toBe("PAULA");
      expect(Number(a.commission_percent)).toBe(17.5);
      expect(Number(a.customer_discount_percent)).toBe(12.5);
      expect(a.status).toBe("approved");
    });

    it("reports back a referral code that checkout will actually honour", async () => {
      const result = await invite("Paula Tester", HER_EMAIL).catch(() => null);
      expect(result).not.toBeNull();

      // validate_referral_code reads `ambassadors` and requires status=approved.
      // A code that lives only in `partners` is dead on arrival.
      const check = await client!.query("select public.validate_referral_code($1) as r", [
        result!.referralCode,
      ]);
      expect(check.rows[0].r.valid).toBe(true);
    });

    it("does not strand her real identity unclaimed", async () => {
      await invite("Paula Tester", HER_EMAIL).catch(() => undefined);

      const a = (await client!.query(
        "select auth_user_id from public.ambassadors where email = $1", [HER_EMAIL],
      )).rows[0];
      expect(a.auth_user_id).not.toBeNull();
    });
  });

  // -- Guard rails: behaviour the repair must NOT break ----------------------

  it("still creates both rows for a genuinely new invitee", async () => {
    const result = await invite("Fresh Face", "fresh@example.test", 12.5);

    const partners = await client!.query("select * from public.partners");
    const ambassadors = await client!.query("select * from public.ambassadors");
    expect(partners.rowCount).toBe(1);
    expect(ambassadors.rowCount).toBe(1);
    expect(partners.rows[0].id).toBe(ambassadors.rows[0].id);
    expect(partners.rows[0].id).toBe(result.partnerId);
    expect(Number(ambassadors.rows[0].commission_percent)).toBe(12.5);
    expect(ambassadors.rows[0].status).toBe("pending");
    // Invited, not yet signed up: the auth account exists and both rows point at it.
    expect(partners.rows[0].auth_user_id).toBe(ambassadors.rows[0].auth_user_id);
  });

  it("refuses to hand over an ambassador another account already claimed", async () => {
    await client!.query(
      `insert into public.ambassadors
         (id, name, email, referral_code, status, commission_percent, auth_user_id, created_by)
       values ($1,'Paula Tester',$2,'PAULA','approved',17.50,$3,$4)`,
      [PRE_ADDED_ID, HER_EMAIL, SOMEONE_ELSE_UID, ADMIN_UID],
    );

    await expect(invite("Impostor", HER_EMAIL)).rejects.toThrow();
    // And it must fail without leaving the orphan behind either.
    expect(await orphanPartners()).toEqual([]);
  });
});
