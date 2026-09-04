import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CRON-03 / CRON-06: THREE JOBS WHOSE COST GREW WITH THE TABLE.
//
// The scheduled sweep is capped at 60 seconds. Three of its jobs read their
// whole window with no limit and then awaited PER ROW — a card charge, an
// email, an insert each:
//
//   • runMembershipBillingSweep   every due membership, in five steps
//   • runAbandonedCartSweep       every active cart in a 96-hour window
//   • grantMonthlyStoreCreditSweep every active member, every tick, for ever
//
// So the tick's cost was a function of how well the business was doing, on a
// budget that is fixed. Past some number of members the sweep stopped
// finishing — and, until the watchdog was added, stopped finishing silently.
//
// BOUNDING IS THE EASY HALF. The hard half is bounding without creating
// starvation, and a bare `.limit()` would have created it: the rows that sort
// first are the ones already dealt with, so the budget would be spent proving
// that, tick after tick, while the rows behind them were never reached. Every
// assertion below is really about draining.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: { customer_memberships: Row[]; store_credit_ledger: Row[]; abandoned_carts: Row[]; abandoned_cart_emails: Row[] } = {
  customer_memberships: [], store_credit_ledger: [], abandoned_carts: [], abandoned_cart_emails: [],
};

const mocks = vi.hoisted(() => ({
  grantMonthlyStoreCredit: vi.fn(async (_userId: string, _cents: number) => true),
  isMarketingSuppressed: vi.fn(async () => false),
  sendMarketingEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/marketing", () => ({
  isMarketingSuppressed: mocks.isMarketingSuppressed,
  sendMarketingEmail: mocks.sendMarketingEmail,
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/billing-provider", () => ({
  getBillingProvider: () => ({ chargeCard: vi.fn(async () => ({ success: true, providerChargeId: "ch_1" })) }),
}));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(), cancelVeyraMembership: vi.fn(),
  skipVeyraMembershipCycle: vi.fn(), updateVeyraMembershipCard: vi.fn(),
}));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({}), isCheckoutOpen: () => true }));
vi.mock("@/lib/store-credit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store-credit")>();
  return { ...actual, grantMonthlyStoreCredit: mocks.grantMonthlyStoreCredit, reconcileMonthlyStoreCredit: vi.fn() };
});
vi.mock("@/lib/admin-control", () => ({
  getCartRecoveryControlConfig: async () => ({
    t30mEnabled: true, t12hEnabled: true, t24hEnabled: true, t72hEnabled: true,
    discountPercent: 10, couponExpirationHours: 48,
  }),
  getBusinessSettings: async () => ({ supportEmail: "" }),
}));

// PostgREST-shaped over four tables, honouring the filters, the ordering and
// .range() — so a paging or ordering mistake fails here and not in production.
vi.mock("@/lib/supabase-server", () => {
  function builder(table: string) {
    const rows = (db as unknown as Record<string, Row[]>)[table] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    const sorts: Array<{ col: string; asc: boolean }> = [];
    let take: number | null = null;

    const hits = () => {
      const out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      out.sort((a, b2) => {
        for (const { col, asc } of sorts) {
          const cmp = String(a[col] ?? "").localeCompare(String(b2[col] ?? ""));
          if (cmp !== 0) return asc ? cmp : -cmp;
        }
        return 0;
      });
      return take === null ? out : out.slice(0, take);
    };

    const b: Record<string, unknown> = {
      select() { return b; },
      insert(row: Row) {
        // Models idx_abandoned_cart_emails_cart_stage: the unique index is what
        // makes a stage exactly-once, so the double has to enforce it.
        if (table === "abandoned_cart_emails") {
          const clash = rows.some(
            (r) => r.abandoned_cart_id === row.abandoned_cart_id && r.stage === row.stage,
          );
          const settled = clash
            ? { data: null, error: { code: "23505", message: "duplicate key" } }
            : (() => {
                const created = { id: `ace-${rows.length + 1}`, ...row };
                rows.push(created);
                return { data: { id: created.id }, error: null };
              })();
          return {
            select: () => ({ single: async () => settled, maybeSingle: async () => settled }),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: settled.error }).then(resolve),
          };
        }
        rows.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
      update(payload: Row) {
        const u: Record<string, unknown> = {
          eq(c: string, v: unknown) {
            for (const row of rows) if (row[c] === v) Object.assign(row, payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
        return u;
      },
      delete() {
        return {
          eq(c: string, v: unknown) {
            const keep = rows.filter((r) => r[c] !== v);
            rows.length = 0;
            rows.push(...keep);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c: string, op: string, v: unknown) {
        if (op !== "is") throw new Error("unsupported not");
        filters.push((r) => (r[c] ?? null) !== v);
        return b;
      },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
      gt(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      or(clauses: string) {
        filters.push((r) => clauses.split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join(".");
          if (o === "gte") return String(r[c] ?? "") >= v;
          if (o === "lte") return String(r[c] ?? "") <= v;
          if (o === "is" && v === "null") return r[c] === null || r[c] === undefined;
          if (o === "eq") return String(r[c]) === v;
          return false;
        }));
        return b;
      },
      lte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") <= String(v)); return b; },
      order(c: string, o?: { ascending?: boolean }) { sorts.push({ col: c, asc: o?.ascending !== false }); return b; },
      limit(n: number) { take = n; return b; },
      range(from: number, to: number) {
        return Promise.resolve({ data: hits().slice(from, to + 1), error: null });
      },
      maybeSingle() { return Promise.resolve({ data: hits()[0] ?? null, error: null }); },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ data: hits(), error: null }).then(resolve);
      },
    };
    return b;
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});

const { grantMonthlyStoreCreditSweep } = await import("@/lib/membership-billing");
const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");
const { currentPeriodMonth } = await import("@/lib/store-credit");

function seedMembers(count: number) {
  db.customer_memberships = Array.from({ length: count }, (_unused, i) => ({
    user_id: `user-${String(i).padStart(5, "0")}`,
    status: "active",
    next_billing_at: "2026-09-27T00:00:00.000Z",
    membership_tiers: { slug: "core", monthly_store_credit_cents: 7500 },
  }));
}

function seedCarts(count: number, ageHours: number) {
  db.abandoned_carts = Array.from({ length: count }, (_unused, i) => ({
    id: `cart-${String(i).padStart(5, "0")}`,
    email: `shopper${i}@example.test`,
    customer_name: "Shopper",
    items: [{ productId: "p1", name: "Item", quantity: 1, priceCents: 5000 }],
    cart_value_cents: 5000,
    status: "active",
    first_seen_at: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
  }));
}

/** Every stage claimed for a cart — what a fully-worked cart looks like. */
function claimEveryStage(cartId: string) {
  for (const stage of ["t30m", "t12h", "t24h", "t72h"]) {
    db.abandoned_cart_emails.push({ id: `${cartId}-${stage}`, abandoned_cart_id: cartId, stage, coupon_id: null });
  }
}

beforeEach(() => {
  db.customer_memberships = [];
  db.store_credit_ledger = [];
  db.abandoned_carts = [];
  db.abandoned_cart_emails = [];
  vi.clearAllMocks();
});

describe("the monthly store-credit sweep", () => {
  it("no longer attempts a write for every member on every tick", async () => {
    seedMembers(2_000);

    await grantMonthlyStoreCreditSweep();

    // Was 2,000 inserts per tick, half-hourly, for the whole month. The
    // membership base is not a per-tick cost any more.
    expect(mocks.grantMonthlyStoreCredit.mock.calls.length).toBeLessThan(2_000);
    expect(mocks.grantMonthlyStoreCredit).toHaveBeenCalled();
  });

  it("spends the budget on members who have NOT been granted, not on proving that the first ones have", async () => {
    // The starvation trap a bare .limit() would have walked into: the members
    // who sort first are exactly the ones already granted, so a limit alone
    // would have burned every tick on them and never reached user-01999.
    seedMembers(2_000);
    const period = currentPeriodMonth();
    for (let i = 0; i < 1_999; i += 1) {
      db.store_credit_ledger.push({
        user_id: `user-${String(i).padStart(5, "0")}`,
        reason: "membership_monthly_grant",
        period_month: period,
      });
    }

    await grantMonthlyStoreCreditSweep();

    expect(mocks.grantMonthlyStoreCredit).toHaveBeenCalledTimes(1);
    expect(mocks.grantMonthlyStoreCredit).toHaveBeenCalledWith("user-01999", 7500);
  });

  it("drains: repeated ticks reach everyone rather than looping on the same members", async () => {
    seedMembers(500);
    const period = currentPeriodMonth();
    // Model the unique index: a granted member gains a ledger row.
    mocks.grantMonthlyStoreCredit.mockImplementation(async (userId: string) => {
      db.store_credit_ledger.push({ user_id: userId, reason: "membership_monthly_grant", period_month: period });
      return true;
    });

    for (let tick = 0; tick < 5; tick += 1) await grantMonthlyStoreCreditSweep();

    expect(db.store_credit_ledger).toHaveLength(500);
    // Every member granted exactly once — no member paid for twice, none missed.
    expect(new Set(db.store_credit_ledger.map((r) => r.user_id)).size).toBe(500);
  });

  it("does nothing at all once the month is fully granted", async () => {
    seedMembers(300);
    const period = currentPeriodMonth();
    for (const member of db.customer_memberships) {
      db.store_credit_ledger.push({ user_id: member.user_id, reason: "membership_monthly_grant", period_month: period });
    }

    await grantMonthlyStoreCreditSweep();

    expect(mocks.grantMonthlyStoreCredit).not.toHaveBeenCalled();
  });

  it("still refuses comped memberships and free tiers", async () => {
    // Bounding must not quietly change WHO is eligible.
    db.customer_memberships = [
      { user_id: "comped", status: "active", next_billing_at: null, membership_tiers: { slug: "core", monthly_store_credit_cents: 7500 } },
      { user_id: "free", status: "active", next_billing_at: "2026-09-27T00:00:00.000Z", membership_tiers: { slug: "free", monthly_store_credit_cents: 0 } },
      { user_id: "paying", status: "active", next_billing_at: "2026-09-27T00:00:00.000Z", membership_tiers: { slug: "core", monthly_store_credit_cents: 7500 } },
    ];

    await grantMonthlyStoreCreditSweep();

    expect(mocks.grantMonthlyStoreCredit).toHaveBeenCalledTimes(1);
    expect(mocks.grantMonthlyStoreCredit).toHaveBeenCalledWith("paying", 7500);
  });
});

describe("the abandoned-cart sweep", () => {
  it("does not touch every active cart in the window", async () => {
    seedCarts(1_000, 2);

    const result = await runAbandonedCartSweep();

    expect(result.eligible).toBeLessThan(1_000);
    expect(mocks.isMarketingSuppressed.mock.calls.length).toBe(result.eligible);
  });

  it("spends nothing on carts whose due stages are all already sent", async () => {
    // 400 fully-worked carts sort FIRST (they are the oldest). A bare limit
    // would have spent the entire tick on them and never reached the cart with
    // an email actually due.
    seedCarts(401, 13);
    for (let i = 0; i < 400; i += 1) claimEveryStage(`cart-${String(i).padStart(5, "0")}`);

    const result = await runAbandonedCartSweep();

    expect(result.eligible).toBe(1);
    expect(mocks.isMarketingSuppressed).toHaveBeenCalledTimes(1);
    expect(mocks.isMarketingSuppressed).toHaveBeenCalledWith("shopper400@example.test");
  });

  it("ignores a cart that is too young for any stage", async () => {
    seedCarts(10, 0);

    const result = await runAbandonedCartSweep();

    expect(result.eligible).toBe(0);
    expect(mocks.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it("still sends for a cart that has a due stage outstanding", async () => {
    seedCarts(1, 2);

    const result = await runAbandonedCartSweep();

    expect(result.eligible).toBe(1);
    expect(result.t30mSent).toBe(1);
  });
});
