import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHICH ALGORITHM ACTUALLY HOLDS THE BALANCE.
//
// The atomic claim lives in the database (tender-hold-claim.sql) and the
// pre-lock write-then-validate algorithm is kept only for an environment where
// that migration has not been applied. Getting the routing wrong is invisible:
// both answer true for an ordinary claim, and the difference only shows up as a
// double spend under concurrency, months later, in money.
//
// So this pins the routing itself. Three questions, and each has exactly one
// safe answer:
//
//   the function is there        -> use it, and honour what it says
//   the function is NOT there    -> fall back, so checkout still works
//   the function failed for any
//   OTHER reason                 -> THROW; never quietly spend on the
//                                   algorithm that cannot see the race
// ---------------------------------------------------------------------------

const rpc = vi.hoisted(() => vi.fn());
const inserted = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const table = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      order: () => b,
      range: async () => ({ data: [], error: null }),
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { select: async () => ({ data: [{ id: "row-1", created_at: new Date().toISOString() }], error: null }) };
      },
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return b;
  };
  return {
    supabaseAdmin: {
      from: () => table(),
      rpc: (...args: unknown[]) => rpc(...args),
    },
  };
});

const CLAIM = {
  orderId: "order-1",
  userId: "user-1",
  storeCreditCents: 5000,
  pointsRedeemed: 0,
};

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  inserted.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("when the atomic claim function is deployed", () => {
  it("holds the balance through it, with the caller's own spendable window", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { reserveOrderTender } = await import("@/lib/tender-reservation");

    const result = await reserveOrderTender(CLAIM);

    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("claim_store_credit_hold");
    expect(args.p_user_id).toBe("user-1");
    expect(args.p_order_id).toBe("order-1");
    expect(args.p_amount).toBe(5000);
    // Store credit is use-it-or-lose-it monthly: the boundary travels with the
    // claim so the function cannot validate against a wider window than the
    // balance the shopper was shown.
    expect(typeof args.p_window_start).toBe("string");
    expect(inserted, "the debit is written inside the function, not from here").toHaveLength(0);
  });

  it("refuses the checkout when it answers false", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const { reserveOrderTender } = await import("@/lib/tender-reservation");

    const result = await reserveOrderTender(CLAIM);

    expect(result.ok).toBe(false);
    expect(result.shortOf).toBe("store credit");
  });

  it("retries once when the call is refused at the edge before it could run", async () => {
    // Production refuses ~0.1% of this app's Supabase calls with a 401 "JWT
    // issued at future". Refused at the edge, so re-issuing cannot debit twice.
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: "JWT issued at future" } })
      .mockResolvedValueOnce({ data: true, error: null });
    const { reserveOrderTender } = await import("@/lib/tender-reservation");

    expect((await reserveOrderTender(CLAIM)).ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("passes a NULL window for points, which never expire", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { reserveOrderTender } = await import("@/lib/tender-reservation");

    await reserveOrderTender({ ...CLAIM, storeCreditCents: 0, pointsRedeemed: 300 });

    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("claim_points_hold");
    expect(args.p_window_start).toBeNull();
  });
});

describe("when the atomic claim function is NOT deployed", () => {
  it.each([
    ["Postgres says the function does not exist", { code: "42883", message: "function claim_store_credit_hold does not exist" }],
    ["Postgres says the table does not exist", { code: "42P01", message: "relation does not exist" }],
    ["PostgREST cannot find it", { code: "PGRST202", message: "Could not find the function" }],
  ])("falls back to the pre-lock algorithm when %s", async (_label, error) => {
    rpc.mockResolvedValue({ data: null, error });
    const { reserveOrderTender } = await import("@/lib/tender-reservation");

    const result = await reserveOrderTender(CLAIM);

    expect(result.ok, "an un-migrated database must not fail every checkout").toBe(true);
    expect(inserted, "so the debit is written from here instead").toHaveLength(1);
  });
});

describe("when the claim fails for any other reason", () => {
  it.each([
    ["a statement timeout", { code: "57014", message: "canceling statement due to statement timeout" }],
    ["a permission failure that happens to name the function", { code: "42501", message: "permission denied for function claim_store_credit_hold" }],
    ["an unrecognised failure", { code: "XX000", message: "something went wrong" }],
  ])("throws rather than spending on the racy path (%s)", async (_label, error) => {
    // The sibling detector in bxgy-promotions.ts also matches the function NAME
    // in the message; here that would read a permission failure as "not
    // deployed" and quietly spend a customer's balance on the algorithm the
    // whole migration exists to replace.
    rpc.mockResolvedValue({ data: null, error });
    const { reserveOrderTender } = await import("@/lib/tender-reservation");

    await expect(reserveOrderTender(CLAIM)).rejects.toBeTruthy();
    expect(inserted).toHaveLength(0);
  });
});
