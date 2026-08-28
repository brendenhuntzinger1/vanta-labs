import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { suiteDatabaseUrl } from "@/lib/test-support/suite-database";

// ---------------------------------------------------------------------------
// PHASE 16 — CONCURRENCY / IDEMPOTENCY on the affiliate money path.
//
// Every affiliate money write is a sequence of separate PostgREST calls. Each
// call is its own transaction on its own connection, so "read, decide, write"
// is never atomic across the sequence -- there is a real window between the
// read and the write in which another request can change the rows underneath.
//
// This file runs the REAL functions against a REAL Postgres through a POOLED
// shim, so overlapping calls genuinely execute on separate connections and
// contend for the same rows, exactly as two web requests would. Sequential
// calls cannot show any of this.
//
// Where an interleaving needs to be deterministic rather than lucky, the shim
// exposes a gate that lets a second operation commit ON ANOTHER CONNECTION at a
// chosen point in the first one's sequence. That is not a simulation of the
// race -- it is the race, made reproducible.
//
// Requires a throwaway Postgres. Set VANTA_TEST_DATABASE_URL, e.g.
//   initdb -D /tmp/vantapg -A trust -U postgres
//   pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
//   VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npx vitest run
// Skipped (visibly, on stderr) when unset.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;

const AMB_ID = "11111111-1111-1111-1111-111111111111";
const ADMIN_UID = "99999999-9999-9999-9999-999999999999";

/** Mirrors production: FKs and NOT NULLs taken from live information_schema. */
const FIXTURE_DDL = `
create extension if not exists pgcrypto;
drop table if exists public.admin_audit_logs cascade;
drop table if exists public.payouts cascade;
drop table if exists public.partner_payouts cascade;
drop table if exists public.commissions cascade;
drop table if exists public.referral_orders cascade;
drop table if exists public.orders cascade;
drop table if exists public.ambassadors cascade;
drop table if exists public.partners cascade;

create table public.partners (
  id uuid primary key, auth_user_id uuid unique, name text not null, email text,
  referral_code text not null unique, status text not null default 'pending',
  commission_percent numeric not null default 10,
  payout_method text not null default 'cash', payout_handle text,
  customer_discount_percent numeric,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ambassadors (
  id uuid primary key, auth_user_id uuid, name text not null, email text not null unique,
  referral_code text not null unique, status text not null default 'pending',
  commission_percent numeric not null default 10.00,
  customer_discount_percent numeric,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique, payment_status text, order_type text default 'product',
  paid_side_effects_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.referral_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  ambassador_id uuid not null references public.ambassadors(id),
  referral_code text not null,
  original_subtotal numeric not null, customer_discount numeric not null,
  amount_paid numeric not null, commission_amount numeric not null,
  payment_status text not null default 'paid',
  payout_status text not null default 'unpaid',
  commission_percent numeric not null default 0,
  review_required boolean not null default false,
  fraud_flag boolean not null default false, fraud_reason text,
  ineligible_reason text, tier_name text,
  approved_for_payout_at timestamptz, commission_paid_at timestamptz, reversed_at timestamptz,
  payout_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  order_id text not null unique,
  referral_code text, commission_percent numeric not null default 0,
  commission_amount numeric not null default 0,
  status text not null default 'pending',
  fraud_flag boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- Production has NO foreign key on partner_payouts.ambassador_id (verified
-- against live information_schema). Only payouts.partner_id is FK-constrained.
create table public.partner_payouts (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null, amount numeric not null, note text,
  processed_by uuid, payout_method text, payout_handle text,
  reversed_at timestamptz, created_at timestamptz not null default now()
);
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  amount numeric not null, note text, processed_by uuid,
  payout_method text, payout_handle text,
  reversed_at timestamptz, created_at timestamptz not null default now()
);
create table public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid, action text, target_table text, target_id uuid,
  metadata jsonb, created_at timestamptz not null default now()
);
`;

let pool: Pool | null = null;

/**
 * Fires just before a statement runs, so a test can let another operation
 * commit ON ANOTHER CONNECTION at a chosen point in this one's sequence.
 */
let gate: ((table: string, mode: string) => Promise<void> | void) | null = null;

type Filter = { op: "eq" | "in" | "is" | "isnot" | "lte" | "gte"; col: string; val: unknown };

// PostgREST answers at most `db-max-rows` rows per request and says nothing
// about it. The double enforces the same cap so a read that pages correctly
// and one that does not are distinguishable here, instead of both passing.
const DB_MAX_ROWS = 1000;

// PostgREST puts `in.(...)` in the request URL. A uuid list long enough makes
// that URL a 414, which is a thrown request rather than a write. The double
// cannot produce a URL, so it records every list length instead and the scale
// test below asserts none of them could have built one.
let inFilterWidths: number[] = [];

/**
 * A PostgREST-shaped builder backed by a real connection POOL. Each terminal
 * await checks out its own connection, so concurrent callers genuinely contend
 * — which is the entire point of this file.
 */
class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private cols = "*";
  private returning = false;
  private singleMode: "none" | "maybe" = "none";
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  constructor(
    private table: string,
    private mode: "select" | "update" | "insert",
    private payload?: Record<string, unknown>,
  ) {}

  select(cols?: string) {
    if (this.mode === "select") this.cols = cols ?? "*";
    else { this.returning = true; this.cols = cols ?? "*"; }
    return this;
  }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  in(col: string, val: unknown[]) {
    inFilterWidths.push(val.length);
    this.filters.push({ op: "in", col, val });
    return this;
  }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  // PostgREST's `.not(col, "is", x)` — the only negation these callers use.
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
  then<R1, R2>(
    onOk?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onOk, onErr);
  }

  private where(values: unknown[]) {
    const parts = this.filters.map((f) => {
      if (f.op === "is") return `${f.col} is ${f.val === null ? "null" : "not null"}`;
      // `.not(col, "is", true)` in PostgREST is `col is not true`, which keeps
      // NULLs — matching the JS predicate `row.fraud_flag === true` it replaces.
      if (f.op === "isnot") return `${f.col} is not ${f.val === null ? "null" : String(f.val)}`;
      values.push(f.val);
      if (f.op === "eq") return `${f.col} = $${values.length}`;
      if (f.op === "lte") return `${f.col} <= $${values.length}`;
      if (f.op === "gte") return `${f.col} >= $${values.length}`;
      return `${f.col} = any($${values.length})`;
    });
    return parts.length ? ` where ${parts.join(" and ")}` : "";
  }

  /** ORDER BY + the LIMIT/OFFSET that PostgREST derives from Range, capped. */
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
    if (gate) await gate(this.table, this.mode);
    const values: unknown[] = [];
    let sql: string;

    if (this.mode === "select") {
      sql = `select ${this.cols} from public.${this.table}${this.where(values)}${this.tail()}`;
    } else if (this.mode === "update") {
      const sets = Object.entries(this.payload ?? {}).map(([k, v]) => {
        values.push(v);
        return `${k} = $${values.length}`;
      });
      sql = `update public.${this.table} set ${sets.join(", ")}${this.where(values)}`;
      if (this.returning) sql += ` returning ${this.cols}`;
    } else {
      const entries = Object.entries(this.payload ?? {});
      const cols = entries.map(([k]) => k);
      entries.forEach(([, v]) => values.push(
        v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v,
      ));
      sql = `insert into public.${this.table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`;
      if (this.returning) sql += ` returning ${this.cols}`;
    }

    try {
      const res = await pool!.query(sql, values);
      if (this.singleMode === "maybe") return { data: res.rows[0] ?? null, error: null };
      if (this.mode !== "select" && !this.returning) return { data: null, error: null };
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
    minimumQualifyingOrder: 100, minimumPayoutThreshold: 100, commissionHoldDays: 14,
  }),
  getAmbassadorMarketingResources: async () => [],
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols?: string) => new Query(table, "select").select(cols),
      update: (payload: Record<string, unknown>) => new Query(table, "update", payload),
      insert: (payload: Record<string, unknown>) => new Query(table, "insert", payload),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

const { autoApproveEligibleCommissions, markCommissionsPaid } = await import("@/lib/partner-portal");

async function seedAmbassador(status = "approved") {
  await pool!.query(
    `insert into public.partners (id, name, email, referral_code, status, commission_percent)
     values ($1,'Mizzy','mizzy@example.test','MIZZY',$2,15)`, [AMB_ID, status],
  );
  await pool!.query(
    `insert into public.ambassadors (id, name, email, referral_code, status, commission_percent)
     values ($1,'Mizzy','mizzy@example.test','MIZZY',$2,15)`, [AMB_ID, status],
  );
}

/** A commission that has cleared the hold period and is ready to auto-approve. */
async function seedPendingCommission(orderId: string, amount = 60) {
  await pool!.query(
    `insert into public.orders (order_id, payment_status) values ($1,'paid')`, [orderId],
  );
  await pool!.query(
    `insert into public.referral_orders
       (order_id, ambassador_id, referral_code, original_subtotal, customer_discount,
        amount_paid, commission_amount, payment_status, commission_percent, created_at)
     values ($1,$2,'MIZZY',400,0,400,$3,'pending',15, now() - interval '30 days')`,
    [orderId, AMB_ID, amount],
  );
  await pool!.query(
    `insert into public.commissions (partner_id, order_id, referral_code, commission_amount, status)
     values ($1,$2,'MIZZY',$3,'pending')`, [AMB_ID, orderId, amount],
  );
}

async function seedApprovedCommission(orderId: string, amount = 60) {
  await seedPendingCommission(orderId, amount);
  await pool!.query(
    `update public.referral_orders set payment_status='approved_for_payout', approved_for_payout_at=now()
     where order_id=$1`, [orderId],
  );
  await pool!.query(
    `update public.commissions set status='approved_for_payout' where order_id=$1`, [orderId],
  );
}

async function statusOf(orderId: string) {
  const r = await pool!.query(
    "select payment_status from public.referral_orders where order_id=$1", [orderId],
  );
  return r.rows[0]?.payment_status as string | undefined;
}

const describeDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  process.stderr.write(
    "\n[affiliate-concurrency] SKIPPED: set VANTA_TEST_DATABASE_URL to a throwaway " +
    "Postgres to run the Phase 16 concurrency proofs. These cover double payout, " +
    "the exactly-once payout claim, and the auto-approve read/write race, and are " +
    "NOT covered by any in-memory test.\n",
  );
}

describeDb("affiliate money path under concurrency (real Postgres, pooled connections)", () => {
  beforeEach(async () => {
    if (!pool) pool = new Pool({ connectionString: await suiteDatabaseUrl(DATABASE_URL!, "affiliate_concurrency"), max: 8 });
    gate = null;
    await pool.query(FIXTURE_DDL);
  });

  afterAll(async () => {
    if (pool) { await pool.end(); pool = null; }
  });

  // -------------------------------------------------------------------------
  // markCommissionsPaid — the payout claim. This one is DESIGNED for
  // concurrency (`.eq("payment_status","approved_for_payout")` on the update),
  // so these are certifications, not defect hunts.
  // -------------------------------------------------------------------------

  describe("two admins release the same payout at the same moment", () => {
    beforeEach(async () => {
      await seedAmbassador();
      await seedApprovedCommission("VL-A", 60);
      await seedApprovedCommission("VL-B", 80);
    });

    const release = () => markCommissionsPaid({
      partnerId: AMB_ID, actorUserId: ADMIN_UID, amount: 140,
      confirmedTransferred: true, actorUsername: "owner",
    });

    it("pays the ambassador exactly once", async () => {
      const [a, b] = await Promise.all([release(), release()]);

      const winners = [a, b].filter((r) => r.orderCount > 0);
      expect(winners).toHaveLength(1);
      expect(winners[0].amount).toBe(140);

      const payouts = await pool!.query("select amount from public.partner_payouts");
      expect(payouts.rowCount).toBe(1);
      expect(Number(payouts.rows[0].amount)).toBe(140);
    });

    it("leaves no commission paid twice and none unpaid", async () => {
      await Promise.all([release(), release()]);

      const rows = await pool!.query(
        "select payment_status, count(*)::int as n from public.referral_orders group by 1",
      );
      expect(rows.rows).toEqual([{ payment_status: "paid", n: 2 }]);
    });

    it("keeps the two payout ledgers in step", async () => {
      await Promise.all([release(), release()]);

      const pp = await pool!.query("select id, amount from public.partner_payouts");
      const po = await pool!.query("select id, amount from public.payouts");
      expect(pp.rowCount).toBe(1);
      expect(po.rowCount).toBe(1);
      expect(po.rows[0].id).toBe(pp.rows[0].id);
    });
  });

  // -------------------------------------------------------------------------
  // autoApproveEligibleCommissions — read, then decide, then write, with no
  // status guard on the write.
  // -------------------------------------------------------------------------

  describe("a refund lands while the sweep is deciding", () => {
    beforeEach(async () => {
      await seedAmbassador();
      await seedPendingCommission("VL-R", 60);
    });

    it("does not drag the reversed commission back into the payout queue", async () => {
      // The sweep reads the row as 'pending'. Before it writes, a refund
      // reverses that commission on ANOTHER CONNECTION and commits. The sweep's
      // update carries no status guard, so it overwrites the refund.
      gate = async (table, mode) => {
        if (table === "referral_orders" && mode === "update") {
          gate = null; // once only — the refund must not re-enter here
          await pool!.query(
            `update public.referral_orders
                set payment_status='reversed', reversed_at=now() where order_id='VL-R'`,
          );
        }
      };

      await autoApproveEligibleCommissions();

      expect(await statusOf("VL-R")).toBe("reversed");
    });

    it("does not resurrect a commission an admin has already paid out", async () => {
      // Same window, different loser: a manual payout completes mid-sweep.
      gate = async (table, mode) => {
        if (table === "referral_orders" && mode === "update") {
          gate = null;
          await pool!.query(
            `update public.referral_orders
                set payment_status='paid', commission_paid_at=now() where order_id='VL-R'`,
          );
        }
      };

      await autoApproveEligibleCommissions();

      expect(await statusOf("VL-R")).toBe("paid");
    });

    it("still approves a commission nothing else touched", async () => {
      // Guard rail: the fix must not break the ordinary path.
      await autoApproveEligibleCommissions();

      expect(await statusOf("VL-R")).toBe("approved_for_payout");
      const c = await pool!.query("select status from public.commissions where order_id='VL-R'");
      expect(c.rows[0].status).toBe("approved_for_payout");
    });

    it("leaves the two ledgers agreeing after a mid-sweep reversal", async () => {
      gate = async (table, mode) => {
        if (table === "referral_orders" && mode === "update") {
          gate = null;
          await pool!.query(
            `update public.referral_orders set payment_status='reversed', reversed_at=now()
              where order_id='VL-R'`,
          );
          await pool!.query(
            `update public.commissions set status='reversed' where order_id='VL-R'`,
          );
        }
      };

      await autoApproveEligibleCommissions();

      const ro = await statusOf("VL-R");
      const c = await pool!.query("select status from public.commissions where order_id='VL-R'");
      expect({ referral_orders: ro, commissions: c.rows[0].status })
        .toEqual({ referral_orders: "reversed", commissions: "reversed" });
    });

    it("does not overwrite a reversal that lands between the two ledger writes", async () => {
      // A tighter window: the sweep has already claimed referral_orders, and the
      // refund reverses BOTH ledgers before the sweep writes its mirror. An
      // unguarded mirror write drags `commissions` back on its own, leaving the
      // two ledgers disagreeing about the same order.
      gate = async (table, mode) => {
        if (table === "commissions" && mode === "update") {
          gate = null;
          await pool!.query(
            `update public.referral_orders set payment_status='reversed', reversed_at=now()
              where order_id='VL-R'`,
          );
          await pool!.query(
            `update public.commissions set status='reversed' where order_id='VL-R'`,
          );
        }
      };

      await autoApproveEligibleCommissions();

      const ro = await statusOf("VL-R");
      const c = await pool!.query("select status from public.commissions where order_id='VL-R'");
      expect({ referral_orders: ro, commissions: c.rows[0].status })
        .toEqual({ referral_orders: "reversed", commissions: "reversed" });
    });
  });

  // -------------------------------------------------------------------------
  // The mechanism the paid side-effects rely on. payment-webhook.ts claims
  // exactly-once with `update ... where paid_side_effects_at is null returning`.
  // Proven directly here, on genuinely concurrent connections.
  // -------------------------------------------------------------------------

  it("the paid side-effects claim is won by exactly one of many concurrent deliveries", async () => {
    await pool!.query("insert into public.orders (order_id, payment_status) values ('VL-W','paid')");

    const claim = () => pool!.query(
      `update public.orders set paid_side_effects_at = now()
        where order_id = 'VL-W' and paid_side_effects_at is null returning id`,
    );
    const results = await Promise.all(Array.from({ length: 8 }, claim));

    expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // THE SWEEP AT VOLUME.
  //
  // autoApproveEligibleCommissions is the only path by which an accrued
  // commission becomes payable, and it is a cron job — nobody watches it. Both
  // of its scale failures are silent in opposite directions:
  //
  //   * an unpaged read of `pending` stops at the server's row cap, so
  //     commissions past the cap simply never approve, with no error; and
  //   * an `in.(...)` filter built from that read goes in the request URL, so
  //     once the list is long enough the whole sweep 414s and NOTHING approves.
  //
  // 1,500 rows is deliberately just over the 1,000-row cap the double enforces:
  // enough to tell a paged read from an unpaged one, and to make every id
  // filter in the function wider than one slice.
  // -------------------------------------------------------------------------
  describe("the auto-approval sweep at volume", () => {
    const BACKLOG = 1_500;
    const ID_FILTER_SLICE = 150; // mirrors partner-portal.ts

    beforeEach(async () => {
      await seedAmbassador();
      // One multi-row insert per table — 1,500 round trips would dominate the run.
      const ids = Array.from({ length: BACKLOG }, (_, i) => `VL-B${i}`);
      await pool!.query(
        `insert into public.orders (order_id, payment_status)
         select unnest($1::text[]), 'paid'`, [ids],
      );
      await pool!.query(
        `insert into public.referral_orders
           (order_id, ambassador_id, referral_code, original_subtotal, customer_discount,
            amount_paid, commission_amount, payment_status, commission_percent, created_at)
         select unnest($1::text[]), $2, 'MIZZY', 400, 0, 400, 60, 'pending', 15,
                now() - interval '30 days'`, [ids, AMB_ID],
      );
      await pool!.query(
        `insert into public.commissions (partner_id, order_id, referral_code, commission_amount, status)
         select $1, unnest($2::text[]), 'MIZZY', 60, 'pending'`, [AMB_ID, ids],
      );
      inFilterWidths = [];
    });

    it("approves every eligible commission past the server's row cap, in both ledgers", async () => {
      await autoApproveEligibleCommissions();

      const ro = await pool!.query(
        "select count(*)::int as n from public.referral_orders where payment_status='approved_for_payout'",
      );
      const co = await pool!.query(
        "select count(*)::int as n from public.commissions where status='approved_for_payout'",
      );

      // An unpaged read sees only the first page and leaves the rest pending
      // forever; the two ledgers must also still agree with each other.
      expect({ referralOrders: ro.rows[0].n, commissions: co.rows[0].n })
        .toEqual({ referralOrders: BACKLOG, commissions: BACKLOG });
    });

    it("never builds an id filter wide enough to 414", async () => {
      await autoApproveEligibleCommissions();

      // Sanity: the sweep really did filter by id lists at this volume, so a
      // pass here cannot come from having made no `in.(...)` call at all.
      expect(inFilterWidths.length).toBeGreaterThan(BACKLOG / ID_FILTER_SLICE);
      expect(Math.max(...inFilterWidths)).toBeLessThanOrEqual(ID_FILTER_SLICE);
    });

    it("leaves a commission still inside its hold period pending", async () => {
      // The hold window moved from a JS filter into the query. It must still
      // hold: a fresh commission is not payable however large the backlog is.
      await seedPendingCommission("VL-FRESH", 60);
      await pool!.query("update public.referral_orders set created_at = now() where order_id='VL-FRESH'");

      await autoApproveEligibleCommissions();

      expect(await statusOf("VL-FRESH")).toBe("pending");
    });

    it("leaves a fraud-flagged commission pending", async () => {
      // Same move for the fraud flag — it is now excluded in the query, and
      // still must never auto-approve.
      await seedPendingCommission("VL-FRAUD", 60);
      await pool!.query("update public.referral_orders set fraud_flag = true where order_id='VL-FRAUD'");

      await autoApproveEligibleCommissions();

      expect(await statusOf("VL-FRAUD")).toBe("pending");
    });
  });
});
