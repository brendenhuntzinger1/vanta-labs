import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK M / M-02 — the reconciliation read must SOFTEN on a missing optional
// column, not die on it.
//
// getReconciliationFlags carries a deliberate degradation, and says why:
//
//   "Reconciliation reporting an error is worse than reconciliation reporting
//    slightly softer results, and this is the screen an operator opens when
//    they already suspect something is wrong."
//
// It degraded on `shipping_protection_fee` alone. `handling_fee` was later added
// to the reconciliation formula by a parallel session as a SECOND optional term
// — it is the fifth term of the charged total — but not to the fallback. An
// environment with one column and not the other therefore threw, which is the
// exact opposite of the promise above, and it surfaced only when two branches
// were merged and a database-backed suite ran for the first time.
//
// These tests drive the real getReconciliationFlags against a fake row source
// that rejects a named column the way PostgREST does.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  /** Columns this fake pretends the `orders` table does not have. */
  missing: new Set<string>(),
  /** Every select string the reader asked for, in order. */
  asked: [] as string[],
  /** When set, EVERY read fails with this — a permission error, a dead link. */
  hardError: null as null | { code: string; message: string },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  const ORDER = {
    order_id: "VL-1",
    customer_email: "buyer@example.test",
    subtotal: 100,
    shipping_amount: 15,
    discount_amount: 0,
    handling_fee: 0,
    tax_amount: 0,
    card_processing_fee: 0,
    store_credit_redeemed_cents: 0,
    points_redeemed: 0,
    amount_paid: 115,
    refund_amount: 0,
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    shipping_protection_fee: 0,
  };

  const from = () => {
    let selected = "";
    let head = false;
    const b: Record<string, unknown> = {
      select(columns?: string, options?: { head?: boolean }) {
        selected = String(columns ?? "");
        head = Boolean(options?.head);
        if (!head) state.asked.push(selected);
        return b;
      },
      order: () => b,
      range: () => {
        if (state.hardError) return Promise.resolve({ data: null, error: state.hardError });
        const absent = [...state.missing].find((c) => selected.includes(c));
        if (absent) {
          return Promise.resolve({
            data: null,
            error: { code: "42703", message: `column orders.${absent} does not exist` },
          });
        }
        // One page, then the pager's end-probe gets nothing.
        return Promise.resolve({ data: state.asked.length > 0 ? [ORDER] : [], error: null });
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: [], error: null, count: 1 })),
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

const { getReconciliationFlags } = await import("@/lib/admin-reconciliation");

beforeEach(() => {
  state.missing = new Set();
  state.asked = [];
  state.hardError = null;
});

describe("optional reconciliation columns", () => {
  it("asks for both optional columns when the schema has them", async () => {
    await getReconciliationFlags();

    expect(state.asked[0]).toContain("shipping_protection_fee");
    expect(state.asked[0]).toContain("handling_fee");
  });

  it("softens when shipping_protection_fee is absent", async () => {
    state.missing = new Set(["shipping_protection_fee"]);

    await expect(getReconciliationFlags()).resolves.toBeInstanceOf(Array);

    const last = state.asked.at(-1)!;
    expect(last).not.toContain("shipping_protection_fee");
    // handling_fee was NOT the missing one and must not be dropped with it.
    expect(last).toContain("handling_fee");
  });

  /**
   * THE REGRESSION. Before this fix the fallback named only
   * shipping_protection_fee, so a missing handling_fee threw and the whole
   * reconciliation screen went down.
   */
  it("softens when handling_fee is absent", async () => {
    state.missing = new Set(["handling_fee"]);

    await expect(getReconciliationFlags()).resolves.toBeInstanceOf(Array);

    const last = state.asked.at(-1)!;
    expect(last).not.toContain("handling_fee");
    expect(last).toContain("shipping_protection_fee");
  });

  it("softens when BOTH are absent", async () => {
    state.missing = new Set(["handling_fee", "shipping_protection_fee"]);

    await expect(getReconciliationFlags()).resolves.toBeInstanceOf(Array);

    const last = state.asked.at(-1)!;
    expect(last).not.toContain("handling_fee");
    expect(last).not.toContain("shipping_protection_fee");
    expect(last).toContain("amount_paid");
  });

  /**
   * NEGATIVE CONTROL. Softening is only for a missing OPTIONAL column. A real
   * failure — a permission error, a dead connection, a core column gone — must
   * still surface, or the screen quietly reports "nothing wrong" when it could
   * not look.
   */
  it("does not retry, or soften, on an error that is not a schema gap", async () => {
    // A permission failure or a dead connection is not a missing column. If it
    // were treated as one the screen would drop real terms of the total and
    // report softer results for a read that never succeeded — and it would burn
    // three round trips discovering that.
    state.hardError = { code: "42501", message: "permission denied for table orders" };

    await expect(getReconciliationFlags()).rejects.toThrow(/permission denied/);
    expect(state.asked).toHaveLength(1);
  });

  it("still throws when a CORE column is the one missing", async () => {
    state.missing = new Set(["amount_paid"]);

    await expect(getReconciliationFlags()).rejects.toThrow(/amount_paid/);
  });
});
