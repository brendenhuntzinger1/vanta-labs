import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PRODUCTION_SCHEMA from "@/lib/production-schema.json";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 8.
//
// Seven small defects that share one shape: something reported success it had
// not earned. A discount granted because the eligibility check ERRORED. A
// redemption reported as recorded when the database said it recorded nothing.
// A schema snapshot that no longer described the schema. An index whose
// predicate its own caller could never satisfy. Each one is invisible from the
// outside, which is why each gets an assertion here.
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.resolve(SRC, rel), "utf8");

const schema = PRODUCTION_SCHEMA as Record<string, string[]>;

// ---------------------------------------------------------------------------
// Shared Supabase stub.
//
// coupons.ts and member-savings.ts both reach `orders` through supabaseAdmin
// and differ only in where they await: coupons ends on `.maybeSingle()`,
// member-savings awaits the builder itself after `.limit()`. One chainable
// object with both endings therefore serves both, and `state` decides what each
// ending answers.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const state = {
  welcome: { enabled: true, percent: 15, code: "WELCOME15" },
  /** Answer for a `.maybeSingle()` on `orders` — the welcome-offer guards. */
  orderLookup: { data: null as Row | null, error: null as unknown },
  /** Answer for an awaited `orders` read — lifetime savings. */
  orderScan: { data: [] as Row[], error: null as unknown },
  /** Answer for a `.maybeSingle()` on `coupons`. */
  couponRow: { data: null as Row | null, error: null as unknown },
  rpc: { data: null as unknown, error: null as unknown },
};

const rpcCalls: unknown[][] = [];

vi.mock("@/lib/admin-control", () => ({ getWelcomeOffer: async () => state.welcome }));

vi.mock("@/lib/supabase-server", () => {
  const chain = (single: () => Row, scan: () => Row) => {
    const b: Row = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      not: () => b,
      order: () => b,
      range: () => b,
      limit: () => b,
      update: () => b,
      maybeSingle: async () => single(),
      then: (ok: (v: Row) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve(scan()).then(ok, err),
    };
    return b;
  };

  return {
    supabaseAdmin: {
      from: (table: string) =>
        table === "coupons"
          ? chain(() => state.couponRow, () => state.couponRow)
          : chain(() => state.orderLookup, () => state.orderScan),
      rpc: async (...args: unknown[]) => {
        rpcCalls.push(args);
        return state.rpc;
      },
    },
  };
});

beforeEach(() => {
  state.welcome = { enabled: true, percent: 15, code: "WELCOME15" };
  state.orderLookup = { data: null, error: null };
  state.orderScan = { data: [], error: null };
  state.couponRow = { data: null, error: null };
  state.rpc = { data: null, error: null };
  rpcCalls.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// F-A-15 — a first-order check that could not RUN must not read as "eligible".
//
// Both welcome-offer guards destructured only `data`. supabase-js resolves on a
// database error rather than rejecting, so a statement timeout came back as
// `data: null`, was read as "this customer has no prior paid order", and handed
// the first-order-only discount to a returning customer — forever, on every
// order, for as long as the read kept failing.
// ---------------------------------------------------------------------------

describe("the welcome offer fails closed when its eligibility check errors", () => {
  it("refuses the discount when the prior-paid-order read fails", async () => {
    state.orderLookup = { data: null, error: { code: "57014", message: "statement timeout" } };

    const { validateCoupon } = await import("@/lib/coupons");

    await expect(validateCoupon("WELCOME15", 200, "returning@example.com")).rejects.toThrow(
      /couldn't verify this welcome offer/i,
    );
  });

  it("still grants it when the check runs and finds no prior order", async () => {
    // The negative control. Without this, an implementation that simply refused
    // every welcome offer would pass the test above.
    state.orderLookup = { data: null, error: null };

    const { validateCoupon } = await import("@/lib/coupons");
    const result = await validateCoupon("WELCOME15", 200, "new@example.com");

    expect(result).not.toBeNull();
    expect(result!.discountValue).toBe(15);
    expect(result!.discountAmount).toBe(30);
  });

  it("still refuses a returning customer with the rule's own wording", async () => {
    state.orderLookup = { data: { id: "o1" }, error: null };

    const { validateCoupon } = await import("@/lib/coupons");

    await expect(validateCoupon("WELCOME15", 200, "returning@example.com")).rejects.toThrow(
      /first orders only/i,
    );
  });

  it("does not let the could-not-check error fall through to the coupon lookup", async () => {
    // The half that is easy to get wrong: the catch used to rethrow only
    // "first orders only", so any other error fell through to the normal
    // lookup. A same-named coupons row would then have been applied instead.
    state.orderLookup = { data: null, error: { message: "boom" } };
    state.couponRow = {
      data: { code: "WELCOME15", discount_type: "percent", discount_value: 50, active: true },
      error: null,
    };

    const { validateCoupon } = await import("@/lib/coupons");

    await expect(validateCoupon("WELCOME15", 200, "shopper@example.com")).rejects.toThrow(
      /couldn't verify this welcome offer/i,
    );
  });
});

// ---------------------------------------------------------------------------
// MPC-03 — redeem_coupon reports failure in its RETURN VALUE, not as an error.
// ---------------------------------------------------------------------------

describe("a coupon redemption that the database refused is reported", () => {
  it("reports failure when the RPC says nothing was incremented and a row exists", async () => {
    state.rpc = { data: { redeemed: false }, error: null };
    state.couponRow = { data: { id: "c1" }, error: null };

    const { redeemCoupon } = await import("@/lib/coupons");
    const result = await redeemCoupon("SAVE20");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not recorded as redeemed/i);
  });

  it("stays silent for the welcome offer, which has no coupons row to increment", async () => {
    // The welcome offer is a VIRTUAL coupon (coupons.ts validateCoupon), so
    // every first-time order answers redeemed:false. Treating that as a failure
    // would fire a critical alert on every new customer.
    state.rpc = { data: { redeemed: false }, error: null };
    state.couponRow = { data: null, error: null };

    const { redeemCoupon } = await import("@/lib/coupons");

    expect(await redeemCoupon("WELCOME15")).toEqual({ ok: true });
  });

  it("still reports success on a genuine redemption", async () => {
    state.rpc = { data: { redeemed: true, redemptions_count: 4 }, error: null };

    const { redeemCoupon } = await import("@/lib/coupons");

    expect(await redeemCoupon("SAVE20")).toEqual({ ok: true });
    expect(rpcCalls[0]).toEqual(["redeem_coupon", { input_code: "SAVE20" }]);
  });

  it("does not guess 'no row' when the disambiguating read itself fails", async () => {
    state.rpc = { data: { redeemed: false }, error: null };
    state.couponRow = { data: null, error: { code: "57014", message: "statement timeout" } };

    const { redeemCoupon } = await import("@/lib/coupons");
    const result = await redeemCoupon("SAVE20");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be confirmed/i);
  });

  it("treats a driver that returns no body as success, not as a refusal", async () => {
    // The e2e fake database and the local PostgREST shim both answer
    // `data: null`. Reading that as redeemed:false would turn every harness run
    // into a stream of false alerts.
    state.rpc = { data: null, error: null };

    const { redeemCoupon } = await import("@/lib/coupons");

    expect(await redeemCoupon("SAVE20")).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// F-A-8 — a failed lifetime-savings read is not $0.00 of savings.
//
// The dashboard's contract still forces a number, so this asserts the least the
// module can do: leave a record. Rendering the unknown belongs to the caller,
// src/app/account/(dashboard)/page.tsx.
// ---------------------------------------------------------------------------

describe("a lifetime-savings read that failed leaves a trace", () => {
  it("logs before reporting zero", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    state.orderScan = { data: [], error: { code: "57014", message: "statement timeout" } };

    const { getLifetimeSavings } = await import("@/lib/member-savings");
    const savings = await getLifetimeSavings("user-1");

    expect(savings.total).toBe(0);
    expect(logged).toHaveBeenCalled();
  });

  it("logs nothing on a successful read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    state.orderScan = {
      data: [{ payment_status: "paid", discount_amount: 12, store_credit_redeemed_cents: 500, points_redeemed: 0 }],
      error: null,
    };

    const { getLifetimeSavings } = await import("@/lib/member-savings");
    const savings = await getLifetimeSavings("user-1");

    expect(savings.discounts).toBe(12);
    expect(logged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DB-03 — the snapshot has to describe the schema the code depends on.
//
// supabase-schema-parity.test.ts cannot see this select: the columns are held in
// a `tiers` array and passed as an identifier, and its scanner only reads string
// literals inside `.select(...)`. So the two storefront columns were applied to
// production, read by the application, and absent from the snapshot, with every
// existing guard green.
// ---------------------------------------------------------------------------

describe("the production snapshot covers the coupon columns the storefront reads", () => {
  it("lists every column of the widest storefront-offers tier", () => {
    const source = read("lib/storefront-offers.ts");
    const tiers = /const tiers = \[\s*"([^"]+)"/.exec(source);

    expect(tiers, "the tier list in storefront-offers.ts moved").not.toBeNull();

    const wanted = tiers![1].split(",").map((column) => column.trim());
    expect(wanted.length).toBeGreaterThan(5);
    expect(wanted.filter((column) => !schema.coupons.includes(column))).toEqual([]);
  });

  it("names the two columns coupon-storefront-fields.sql added", () => {
    expect(schema.coupons).toContain("storefront_headline");
    expect(schema.coupons).toContain("storefront_priority");
  });
});

// ---------------------------------------------------------------------------
// F9 — a partial index and the query it was built for, kept in step.
//
// The index was declared `where payment_status = 'paid'`; getBucketCounts has
// always asked for `in ('paid','awaiting_verification')`. An IN over two values
// does not imply the equality, so Postgres could never use the index for the
// query it exists to serve, and nothing in the repo compared the two.
// ---------------------------------------------------------------------------

describe("the fulfillment counts index matches the query that uses it", () => {
  const sql = read("lib/sql/fulfillment-batches.sql");
  const queries = read("lib/fulfillment-queues.ts");

  /** The payment_status set in the index's WHERE clause. */
  function indexStatuses(): string[] {
    const create = /create index concurrently if not exists idx_orders_fulfillment_counts([\s\S]*?);/
      .exec(sql);
    expect(create, "idx_orders_fulfillment_counts was renamed or removed").not.toBeNull();
    const list = /payment_status in \(([^)]*)\)/.exec(create![1]);
    expect(list, "the index predicate is no longer an IN list").not.toBeNull();
    return list![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  }

  it("asks for exactly the statuses the caller filters on", () => {
    const callerSets = [...queries.matchAll(/\.in\("payment_status", \[([^\]]*)\]\)/g)].map((m) =>
      m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).sort(),
    );

    expect(callerSets.length).toBeGreaterThan(0);
    for (const set of callerSets) {
      expect(set).toEqual(indexStatuses());
    }
  });

  it("leads with payment_status, so an IN over it can be walked", () => {
    expect(sql).toContain("on public.orders (payment_status, fulfillment_status)");
  });

  it("drops the old definition first, because `if not exists` matches on name only", () => {
    const drop = sql.indexOf("drop index concurrently if exists idx_orders_fulfillment_counts");
    const create = sql.indexOf("create index concurrently if not exists idx_orders_fulfillment_counts");
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(create);
  });

  it("no longer claims an index-only scan it cannot deliver", () => {
    // Nine columns selected, one indexed: every matching row needs a heap fetch.
    const counts = /bucket counts, all buckets[^\n]*\n([^\n]*)/.exec(sql);
    expect(counts![1]).not.toMatch(/index-only scan/);
  });
});

// ---------------------------------------------------------------------------
// SQL-06 — two `orders` indexes declared twice under two names each.
// ---------------------------------------------------------------------------

describe("the duplicate-index sweep covers both orders pairs", () => {
  const sweep = read("lib/sql/supabase-advisor-remaining-fixes.sql");

  it("drops the duplicate names, and only if an exact twin exists", () => {
    expect(sweep).toContain("drop_index_if_exact_duplicate('public.orders_customer_email_idx')");
    expect(sweep).toContain("drop_index_if_exact_duplicate('public.idx_orders_bulk_tier')");
  });

  it("keeps the twins the base schema creates", () => {
    // Dropping BOTH names would leave the column unindexed. The helper cannot do
    // that on its own — it is a no-op unless a duplicate survives — but a sweep
    // listing both names would be a mistake no test currently catches.
    expect(sweep).not.toContain("drop_index_if_exact_duplicate('public.idx_orders_customer_email')");
    expect(sweep).not.toContain("drop_index_if_exact_duplicate('public.idx_orders_bulk_discount_tier')");
    expect(read("lib/sql/deploy-run-once.sql")).toContain("idx_orders_customer_email");
    expect(read("lib/sql/deploy-run-once.sql")).toContain("idx_orders_bulk_discount_tier");
  });
});

// ---------------------------------------------------------------------------
// VL-SQL-02 — a file that would silently regress a fixed customer-facing defect.
//
// referral-rpc-minimise.sql and referral-code-customer-discount.sql both define
// validate_referral_code. The second is what production has; running the first
// would REMOVE customer_discount_percent and re-open "a 15% ambassador's
// customers were offered 10%".
// ---------------------------------------------------------------------------

describe("the superseded validate_referral_code definition says so", () => {
  it("carries a do-not-run banner naming the file that replaced it", () => {
    const superseded = read("lib/sql/referral-rpc-minimise.sql");
    expect(superseded.slice(0, 800)).toMatch(/SUPERSEDED — DO NOT RUN/);
    expect(superseded.slice(0, 800)).toContain("referral-code-customer-discount.sql");
  });

  it("and the canonical definition still returns the column the cart reads", () => {
    expect(read("lib/sql/referral-code-customer-discount.sql")).toContain(
      "'customer_discount_percent', a.customer_discount_percent",
    );
    expect(read("lib/referral-client.ts")).toContain("data.customer_discount_percent");
  });
});

// ---------------------------------------------------------------------------
// VL-SQL-03 (pre-apply half) — the ad spend view must not outrank its own RLS.
//
// ads-system.sql is not applied to production; applying it is an owner decision.
// This is the defect to fix BEFORE it is: a view without security_invoker runs
// as its owner, and a table's owner is exempt from that table's RLS, so the
// deny-by-default posture on ad_performance_daily would not have survived one
// view over it.
// ---------------------------------------------------------------------------

describe("the derived ad-performance view keeps the caller's rights", () => {
  const ads = read("lib/sql/ads-system.sql");

  it("is created with security_invoker", () => {
    expect(ads).toMatch(
      /create or replace view public\.ad_performance_derived\s*\n?\s*with \(security_invoker = true\)/,
    );
  });

  it("and is revoked from the browser roles as well", () => {
    expect(ads).toContain("revoke all on public.ad_performance_derived from anon, authenticated;");
  });

  it("still enables RLS on the table underneath it", () => {
    expect(ads).toContain("'ad_performance_daily'");
    expect(ads).toContain("enable row level security");
  });
});
