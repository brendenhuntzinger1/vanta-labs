import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE POINTS REDEMPTION RATE HAS ONE HOME, AND TWO SURFACES HAD NO TEST SAYING SO.
//
// `orders.points_redeemed` stores POINTS. Every surface that shows what those
// points were worth has to convert, and each conversion is a chance to write
// `/ 100` instead of calling `pointsToDollars`. Both agree at today's rate, so
// a copy is invisible — right up until the rate changes, at which point the
// customer's invoice stops adding up to what they paid and their "you have
// saved" figure stops matching the invoice that itemises the same redemption.
//
// The money re-certification's mutation sweep found exactly this hole:
//
//   M4  invoice-totals.ts:72   pointsToDollars -> / 100   ... 0 tests red
//   M5  member-savings.ts:45   pointsToDollars -> / 100   ... 0 tests red
//
// Neither module had a unit test in the gate at all (invoice-totals is
// exercised only by admin-financial-surfaces.test.ts, which is SKIPPED without
// a throwaway Postgres). A guard whose removal turns nothing red is not
// protecting anything.
//
// The only test that can tell a call from a copy is one that runs at a rate
// which is NOT 100 — the same technique admin-reconciliation-points-rate.test.ts
// uses for the reconciliation screen.
// ---------------------------------------------------------------------------

/** A rate DIFFERENT from today's 100, to catch a copy of the number. */
const CHANGED_RATE = 200;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/points-math", () => ({
  POINTS_PER_DOLLAR_REDEMPTION: CHANGED_RATE,
  pointsToDollars: (points: number) => Math.round((points / CHANGED_RATE) * 100) / 100,
  dollarsToPoints: (dollars: number) => Math.floor(dollars * CHANGED_RATE),
  calculateEarnedPoints: () => 0,
}));

type Row = Record<string, unknown>;

const state = { orders: [] as Row[], readError: null as unknown };

/**
 * PostgREST's row cap, modelled. getLifetimeSavings pages its read, so this
 * double answers `.order()`/`.range()` — and it answers them HONESTLY: a page
 * is a real slice, capped the way a real server caps it. A `range()` that
 * ignored its bounds and handed back the whole array would make every paged
 * read look correct here, including a broken one.
 */
const DB_MAX_ROWS = 1000;

vi.mock("@/lib/supabase-server", () => {
  const builder = () => {
    const settleAll = () => ({ data: state.readError ? null : state.orders, error: state.readError });
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      order: () => api,
      range: (from: number, to: number) => {
        if (state.readError) return Promise.resolve({ data: null, error: state.readError });
        const want = Math.min(to - from + 1, DB_MAX_ROWS);
        return Promise.resolve({ data: state.orders.slice(from, from + want), error: null });
      },
      // CAPPED TOO, and this is not incidental. `.limit(n)` does not raise
      // db-max-rows — the server still stops at 1,000 whatever the limit asks
      // for. A double whose `limit()` returned everything would let the
      // paging test above pass against the un-paged `.limit(2000)` read it
      // exists to forbid; verified by reverting the fix and watching it go red.
      limit: () => {
        const all = settleAll();
        return Promise.resolve(all.data ? { data: all.data.slice(0, DB_MAX_ROWS), error: all.error } : all);
      },
    };
    return api;
  };
  return { supabaseAdmin: { from: () => builder() } };
});

beforeEach(() => {
  state.orders = [];
  state.readError = null;
});

describe("the customer's invoice values points through the shared rate", () => {
  /**
   * 300 points is $1.50 at the changed rate, and $3.00 to anything carrying a
   * copy of today's 100. The order is priced so the lines reconcile ONLY at the
   * correct valuation:
   *   100 subtotal + 10 shipping + 8 tax − 5.00 store credit − 1.50 points
   *   = $111.50 paid.
   */
  const ORDER = {
    subtotal: 100,
    discountAmount: 0,
    shippingAmount: 10,
    handlingFee: 0,
    taxAmount: 8,
    cardProcessingFee: 0,
    shippingProtectionFee: 0,
    storeCreditRedeemedCents: 500,
    pointsRedeemed: 300,
    amountPaid: 111.5,
    refundAmount: 0,
  };

  it("shows the points line at the shared rate, not a copy of 100", async () => {
    const { buildInvoiceTotals } = await import("@/lib/invoice-totals");
    const { lines } = buildInvoiceTotals(ORDER);
    const points = lines.find((line) => line.label === "Points redeemed");
    expect(points?.amount).toBe(-1.5);
  });

  it("and therefore the lines still ADD UP TO WHAT WAS PAID", async () => {
    // The property this module exists to guarantee. A `/ 100` copy values the
    // 300 points at $3.00, the lines then undershoot the total by $1.50, and
    // the residual escape hatch prints an unexplained "Other charges $1.50" on
    // a document the customer forwards to their accountant.
    const { buildInvoiceTotals } = await import("@/lib/invoice-totals");
    const { lines, totalPaid } = buildInvoiceTotals(ORDER);
    const sum = Math.round(lines.reduce((acc, line) => acc + line.amount, 0) * 100) / 100;
    expect(sum).toBe(totalPaid);
    expect(lines.map((line) => line.label)).not.toContain("Other charges");
    expect(lines.map((line) => line.label)).not.toContain("Other adjustments");
  });

  it("still prints a genuine residual, so the reconciliation is not being faked", async () => {
    // A guard on the guard: if the lines could never fail to add up, the
    // assertion above would prove nothing.
    const { buildInvoiceTotals } = await import("@/lib/invoice-totals");
    const { lines } = buildInvoiceTotals({ ...ORDER, amountPaid: 113.5 });
    expect(lines.find((line) => line.label === "Other charges")?.amount).toBe(2);
  });
});

describe("lifetime savings values points through the shared rate", () => {
  it("counts 300 points as $1.50, not $3.00", async () => {
    state.orders = [{
      payment_status: "paid",
      discount_amount: 12,
      store_credit_redeemed_cents: 500,
      points_redeemed: 300,
    }];

    const { getLifetimeSavings } = await import("@/lib/member-savings");
    const savings = await getLifetimeSavings("user-1");

    expect(savings.points).toBe(1.5);
    expect(savings.storeCredit).toBe(5);
    expect(savings.discounts).toBe(12);
    // The headline figure the account dashboard prints.
    expect(savings.total).toBe(18.5);
    expect(savings.paidOrders).toBe(1);
  });

  it("excludes an unpaid order from every component", async () => {
    // Otherwise the assertion above would pass on a function that simply summed
    // every row it was handed.
    state.orders = [
      { payment_status: "paid", discount_amount: 12, store_credit_redeemed_cents: 500, points_redeemed: 300 },
      { payment_status: "refunded", discount_amount: 99, store_credit_redeemed_cents: 9900, points_redeemed: 9900 },
      { payment_status: "pending_payment", discount_amount: 99, store_credit_redeemed_cents: 9900, points_redeemed: 9900 },
    ];

    const { getLifetimeSavings } = await import("@/lib/member-savings");
    const savings = await getLifetimeSavings("user-1");

    expect(savings.paidOrders).toBe(1);
    expect(savings.total).toBe(18.5);
  });

  it("reports UNAVAILABLE, not zero, when the read fails (F-A-8)", async () => {
    // The numbers stay zero — never a wrong figure — but zero on its own was
    // indistinguishable from a customer who has genuinely saved nothing, and
    // the dashboard renders its savings panel on `total > 0`. So a database
    // that would not answer looked exactly like a new customer and the
    // "Lifetime saved" tile was quietly replaced by a Free shipping advert.
    state.readError = { code: "57014", message: "canceling statement due to statement timeout" };
    const { getLifetimeSavings } = await import("@/lib/member-savings");
    expect(await getLifetimeSavings("user-1")).toEqual({
      available: false,
      total: 0, discounts: 0, storeCredit: 0, points: 0, paidOrders: 0,
    });
  });

  it("reads past the 1,000-row cap, so a long history is not a short answer (F-A-8)", async () => {
    // The read used to say `.limit(2000)` — a ceiling the server never honoured,
    // because PostgREST stops at db-max-rows and says nothing. The double above
    // caps at 1,000 exactly as it does, so an un-paged read comes back short
    // here and this assertion is the thing that notices.
    state.orders = Array.from({ length: 1500 }, () => ({
      payment_status: "paid",
      discount_amount: 1,
      store_credit_redeemed_cents: 0,
      points_redeemed: 0,
    }));

    const { getLifetimeSavings } = await import("@/lib/member-savings");
    const savings = await getLifetimeSavings("user-1");

    expect(savings.available).toBe(true);
    expect(savings.paidOrders).toBe(1500);
    // $1,500 of savings, not the $1,000 one page of it would have reported.
    expect(savings.total).toBe(1500);
    expect(savings.total).not.toBe(1000);
  });

  it("refuses rather than under-reports when the read hits its own ceiling", async () => {
    // MAX_CUSTOMER_ORDERS is far above any real history, but if it is ever
    // reached the honest answer is "couldn't load", not a smaller number
    // presented to the customer as their savings.
    state.orders = Array.from({ length: 20_001 }, () => ({
      payment_status: "paid",
      discount_amount: 1,
      store_credit_redeemed_cents: 0,
      points_redeemed: 0,
    }));

    const { getLifetimeSavings } = await import("@/lib/member-savings");
    const savings = await getLifetimeSavings("user-1");

    expect(savings.available).toBe(false);
    expect(savings.total).toBe(0);
  });

  it("reports available on a successful read, so a real zero is still a real zero", async () => {
    // The other half of the distinction: without this, `available: false`
    // everywhere would pass the test above and break every genuine customer.
    state.orders = [];
    const { getLifetimeSavings } = await import("@/lib/member-savings");
    expect(await getLifetimeSavings("user-1")).toEqual({
      available: true,
      total: 0, discounts: 0, storeCredit: 0, points: 0, paidOrders: 0,
    });
  });
});
