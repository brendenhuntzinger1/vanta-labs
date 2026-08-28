import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { suiteDatabaseUrl } from "@/lib/test-support/suite-database";

// ---------------------------------------------------------------------------
// TWO WAYS THE TWO TABLES DECIDE DIFFERENT THINGS ABOUT THE SAME PERSON.
//
// 1. updatePartnerStatus checks existence on `partners` only, then updates both
//    tables with `.eq("id", ...)`. A PostgREST update that matches zero rows is
//    NOT an error, so approving someone with no `ambassadors` row returns 200,
//    sends the approval email, and writes an audit row naming a table it never
//    touched. Their referral code still resolves to nothing at checkout.
//
// 2. Accrual and payout are gated by DIFFERENT tables' status columns:
//    autoApproveEligibleCommissions filters on `ambassadors.status`, while
//    markCommissionsPaid filters on `partners.status`. Either direction of
//    drift half-breaks the pipeline.
//
// Real Postgres, because (1) is entirely a fact about what a zero-row UPDATE
// returns, and a fake that reports "updated" regardless cannot show it.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;

const ID = "11111111-1111-1111-1111-111111111111";
const ADMIN_UID = "99999999-9999-9999-9999-999999999999";

const FIXTURE_DDL = `
create extension if not exists pgcrypto;
drop table if exists public.admin_audit_logs cascade;
drop table if exists public.notification_queue cascade;
drop table if exists public.partner_payouts cascade;
drop table if exists public.payouts cascade;
drop table if exists public.commissions cascade;
drop table if exists public.referral_orders cascade;
drop table if exists public.orders cascade;
drop table if exists public.ambassadors cascade;
drop table if exists public.partners cascade;

create table public.partners (
  id uuid primary key, auth_user_id uuid unique, name text not null, email text,
  referral_code text not null unique, status text not null default 'pending',
  commission_percent numeric not null default 10,
  commission_percent_locked boolean not null default false,
  customer_discount_percent numeric,
  payout_method text not null default 'cash', payout_handle text,
  approved_at timestamptz, disabled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ambassadors (
  id uuid primary key, auth_user_id uuid, name text not null, email text not null unique,
  referral_code text not null unique, status text not null default 'pending',
  commission_percent numeric not null default 10.00,
  commission_percent_locked boolean not null default false,
  customer_discount_percent numeric,
  approved_at timestamptz, disabled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.orders (
  id uuid primary key default gen_random_uuid(), order_id text not null unique,
  payment_status text, created_at timestamptz not null default now()
);
create table public.referral_orders (
  id uuid primary key default gen_random_uuid(), order_id text not null unique,
  ambassador_id uuid not null references public.ambassadors(id), referral_code text not null,
  original_subtotal numeric not null, customer_discount numeric not null,
  amount_paid numeric not null, commission_amount numeric not null,
  payment_status text not null default 'paid', payout_status text not null default 'unpaid',
  commission_percent numeric not null default 0,
  fraud_flag boolean not null default false, ineligible_reason text,
  approved_for_payout_at timestamptz, commission_paid_at timestamptz, payout_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id), order_id text not null unique,
  commission_amount numeric not null default 0, status text not null default 'pending',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.partner_payouts (
  id uuid primary key default gen_random_uuid(), ambassador_id uuid not null,
  amount numeric not null, note text, processed_by uuid,
  payout_method text, payout_handle text, created_at timestamptz not null default now()
);
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  amount numeric not null, note text, processed_by uuid,
  payout_method text, payout_handle text, created_at timestamptz not null default now()
);
create table public.notification_queue (
  id uuid primary key default gen_random_uuid(), kind text, recipient text,
  payload jsonb, status text, sent_at timestamptz
);
create table public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text,
  target_table text, target_id uuid, metadata jsonb, created_at timestamptz not null default now()
);
`;

let pool: Pool | null = null;
type Filter = { op: "eq" | "neq" | "in" | "is" | "isnot" | "lte" | "gte"; col: string; val: unknown };

// PostgREST answers at most `db-max-rows` per request, silently.
const DB_MAX_ROWS = 1000;

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private cols = "*";
  private returning = false;
  private singleMode: "none" | "maybe" | "one" = "none";
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  constructor(private table: string, private mode: "select" | "update" | "insert",
              private payload?: Record<string, unknown>) {}
  select(cols?: string) {
    if (this.mode === "select") this.cols = cols ?? "*";
    else { this.returning = true; this.cols = cols ?? "*"; }
    return this;
  }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ op: "neq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ op: "in", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  not(col: string, op: string, val: unknown) {
    if (op !== "is") throw new Error(`double does not model .not(${op})`);
    this.filters.push({ op: "isnot", col, val });
    return this;
  }
  lte(col: string, val: unknown) { this.filters.push({ op: "lte", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this.run(); }
  single() { this.singleMode = "one"; return this.run(); }
  then<R1, R2>(ok?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
               err?: ((r: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return this.run().then(ok, err);
  }
  private where(values: unknown[]) {
    const parts = this.filters.map((f) => {
      if (f.op === "is") return `${f.col} is ${f.val === null ? "null" : "not null"}`;
      if (f.op === "isnot") return `${f.col} is not ${f.val === null ? "null" : String(f.val)}`;
      values.push(f.val);
      if (f.op === "eq") return `${f.col} = $${values.length}`;
      if (f.op === "neq") return `${f.col} <> $${values.length}`;
      if (f.op === "lte") return `${f.col} <= $${values.length}`;
      if (f.op === "gte") return `${f.col} >= $${values.length}`;
      return `${f.col} = any($${values.length})`;
    });
    return parts.length ? ` where ${parts.join(" and ")}` : "";
  }

  /** ORDER BY plus the LIMIT/OFFSET PostgREST derives from Range, capped. */
  private tail() {
    let sql = "";
    if (this.orderBy.length) {
      sql += ` order by ${this.orderBy.map((o) => `${o.col} ${o.asc ? "asc" : "desc"}`).join(", ")}`;
    }
    const offset = this.rangeFrom ?? 0;
    const asked = this.rangeTo === null ? Number.POSITIVE_INFINITY : this.rangeTo - offset + 1;
    const limit = Math.max(0, Math.min(asked, DB_MAX_ROWS));
    if (Number.isFinite(limit)) sql += ` limit ${limit}`;
    if (offset > 0) sql += ` offset ${offset}`;
    return sql;
  }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    const values: unknown[] = [];
    let sql: string;
    if (this.mode === "select") {
      sql = `select ${this.cols} from public.${this.table}${this.where(values)}${this.tail()}`;
    } else if (this.mode === "update") {
      const sets = Object.entries(this.payload ?? {}).map(([k, v]) => {
        values.push(v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
        return `${k} = $${values.length}`;
      });
      sql = `update public.${this.table} set ${sets.join(", ")}${this.where(values)}`;
      if (this.returning) sql += ` returning ${this.cols}`;
    } else {
      const entries = Object.entries(this.payload ?? {});
      entries.forEach(([, v]) => values.push(
        v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));
      sql = `insert into public.${this.table} (${entries.map(([k]) => k).join(",")}) values (${entries.map((_, i) => `$${i + 1}`).join(",")})`;
      sql += ` returning ${this.returning ? this.cols : "id"}`;
    }
    try {
      const res = await pool!.query(sql, values);
      if (this.singleMode !== "none") return { data: res.rows[0] ?? null, error: null };
      if (this.mode === "update" && !this.returning) return { data: null, error: null };
      return { data: res.rows, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }
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
    minimumQualifyingOrder: 100, minimumPayoutThreshold: 50, commissionHoldDays: 14,
  }),
  getAmbassadorMarketingResources: async () => [],
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols?: string) => new Query(table, "select").select(cols),
      update: (p: Record<string, unknown>) => new Query(table, "update", p),
      insert: (p: Record<string, unknown>) => new Query(table, "insert", p),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

const { updatePartnerStatus, autoApproveEligibleCommissions, markCommissionsPaid } =
  await import("@/lib/partner-portal");

async function seedPartner(status = "pending") {
  await pool!.query(
    `insert into public.partners (id,name,email,referral_code,status,commission_percent)
     values ($1,'Elijah','elijah@example.test','ELIJAH',$2,15)`, [ID, status]);
}
async function seedAmbassador(status = "pending") {
  await pool!.query(
    `insert into public.ambassadors (id,name,email,referral_code,status,commission_percent)
     values ($1,'Elijah','elijah@example.test','ELIJAH',$2,15)`, [ID, status]);
}
async function seedCommission(orderId: string, amount: number, status = "pending") {
  await pool!.query(`insert into public.orders (order_id,payment_status) values ($1,'paid')`, [orderId]);
  await pool!.query(
    `insert into public.referral_orders (order_id,ambassador_id,referral_code,original_subtotal,
       customer_discount,amount_paid,commission_amount,payment_status,commission_percent,created_at)
     values ($1,$2,'ELIJAH',400,0,400,$3,$4,15, now() - interval '30 days')`,
    [orderId, ID, amount, status]);
  await pool!.query(
    `insert into public.commissions (partner_id,order_id,commission_amount,status)
     values ($1,$2,$3,$4)`, [ID, orderId, amount, status]);
}

const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "\n[partner-status-integrity] SKIPPED: set VANTA_TEST_DATABASE_URL to a throwaway " +
    "Postgres to run the status-integrity proofs.\n");
}

describeDb("status decisions across the two ambassador tables", () => {
  beforeEach(async () => {
    if (!pool) pool = new Pool({ connectionString: await suiteDatabaseUrl(DATABASE_URL!, "status_integrity"), max: 6 });
    await pool.query(FIXTURE_DDL);
  });
  afterAll(async () => { if (pool) { await pool.end(); pool = null; } });

  describe("approving someone whose ambassadors row is missing", () => {
    beforeEach(async () => { await seedPartner("pending"); });

    it("does not report success for a write that touched nothing", async () => {
      // Existence is checked on `partners` alone; the ambassadors update then
      // matches zero rows, which PostgREST does not treat as an error.
      await expect(updatePartnerStatus({
        partnerId: ID, status: "approved", actorUserId: ADMIN_UID, actorUsername: "owner",
      })).rejects.toThrow();
    });

    it("does not leave an audit row claiming it updated ambassadors", async () => {
      await updatePartnerStatus({
        partnerId: ID, status: "approved", actorUserId: ADMIN_UID, actorUsername: "owner",
      }).catch(() => undefined);

      const logs = await pool!.query(
        "select 1 from public.admin_audit_logs where target_table='ambassadors'");
      expect(logs.rowCount).toBe(0);
    });
  });

  it("still approves normally when both rows exist", async () => {
    await seedPartner("pending");
    await seedAmbassador("pending");

    await updatePartnerStatus({
      partnerId: ID, status: "approved", actorUserId: ADMIN_UID, actorUsername: "owner",
    });

    const rows = await pool!.query(
      `select (select status from public.partners where id=$1) as p,
              (select status from public.ambassadors where id=$1) as a`, [ID]);
    expect(rows.rows[0]).toEqual({ p: "approved", a: "approved" });
  });

  // -------------------------------------------------------------------------
  // Accrual reads `ambassadors`; payout release reads `partners`.
  // -------------------------------------------------------------------------

  describe("when the two tables disagree about whether someone is approved", () => {
    it("does not accrue toward a payout that can never be released", async () => {
      // ambassadors approved, partners disabled: the sweep approves the
      // commission for payout, and the payout gate then refuses it forever.
      await seedPartner("disabled");
      await seedAmbassador("approved");
      await seedCommission("VL-HOLD", 60);

      await autoApproveEligibleCommissions();

      const status = (await pool!.query(
        "select payment_status from public.referral_orders where order_id='VL-HOLD'")).rows[0].payment_status;

      await expect(markCommissionsPaid({
        partnerId: ID, actorUserId: ADMIN_UID, amount: 60, confirmedTransferred: true,
      })).rejects.toThrow(/not currently approved/);

      // Money sitting in approved_for_payout that nothing can ever release is
      // the state this asymmetry produces.
      expect(status).not.toBe("approved_for_payout");
    });

    it("does not offer a payout for someone the money table says is disabled", async () => {
      // The mirror image: partners approved, ambassadors disabled. Accrual is
      // blocked, but the payout gate reads partners and lets the release run.
      await seedPartner("approved");
      await seedAmbassador("disabled");
      await seedCommission("VL-REL", 60, "approved_for_payout");
      await pool!.query(
        "update public.referral_orders set approved_for_payout_at=now() where order_id='VL-REL'");

      await expect(markCommissionsPaid({
        partnerId: ID, actorUserId: ADMIN_UID, amount: 60, confirmedTransferred: true,
      })).rejects.toThrow();
    });

    it("still releases a payout when both tables agree", async () => {
      await seedPartner("approved");
      await seedAmbassador("approved");
      await seedCommission("VL-OK", 60, "approved_for_payout");
      await pool!.query(
        "update public.referral_orders set approved_for_payout_at=now() where order_id='VL-OK'");

      const result = await markCommissionsPaid({
        partnerId: ID, actorUserId: ADMIN_UID, amount: 60, confirmedTransferred: true,
      });

      expect(result.amount).toBe(60);
      expect(result.orderCount).toBe(1);
    });
  });
});
