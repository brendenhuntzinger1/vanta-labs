import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE ORDER RECOVERS ONE CART.
//
// markAbandonedCartsRecovered updated EVERY active cart for an address and
// stamped them all with the same order id. Two different facts were being
// written by one statement:
//
//   "stop mailing this cart"      — true of ALL their open carts. Correct.
//   "this order recovered this"   — true of AT MOST ONE.
//
// Production, 2026-09-09: one $76.04 order was credited to FOUR carts claiming
// $582.90 between them, and a second $73.84 order to two more. Nine carts read
// as recovered where five orders existed. Every recovery figure the dashboard
// reports — count and value — was overstated, and a recovery rate computed
// from it is roughly double the truth.
//
// The reminders must still stop for every cart, or a customer who has just
// bought keeps getting "you left something behind" for carts they abandoned
// weeks ago. So the close stays broad and only the CREDIT narrows.
// ---------------------------------------------------------------------------

type CartRow = {
  id: string;
  email: string;
  status: string;
  restored_at: string | null;
  last_updated_at: string;
  recovered_order_id: string | null;
};

const store = vi.hoisted(() => ({ carts: [] as CartRow[] }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  // A tiny stand-in for the query builder: collects .eq() filters, applies the
  // update to matching rows on await. Enough to observe WHICH rows a statement
  // touches and what it writes, which is the whole question here.
  function makeBuilder() {
    const filters: Array<[string, unknown]> = [];
    let updatePatch: Record<string, unknown> | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let selectCols: string | null = null;

    const matches = (row: CartRow) =>
      filters.every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value);

    const builder: Record<string, unknown> = {
      update(patch: Record<string, unknown>) { updatePatch = patch; return builder; },
      select(cols?: string) { selectCols = cols ?? "*"; return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      in(column: string, values: unknown[]) {
        filters.push([column, "__in__"]);
        // Represent `in` by rewriting the last filter into a predicate check.
        filters.pop();
        (builder as { _inFilter?: [string, unknown[]] })._inFilter = [column, values];
        return builder;
      },
      is(column: string, value: unknown) { filters.push([column, value]); return builder; },
      order(column: string, opts?: { ascending?: boolean }) {
        orderCol = column; orderAsc = opts?.ascending !== false; return builder;
      },
      limit() { return builder; },
      then(resolve: (r: unknown) => unknown) {
        const inFilter = (builder as { _inFilter?: [string, unknown[]] })._inFilter;
        let rows = store.carts.filter((row) => matches(row)
          && (!inFilter || inFilter[1].includes((row as unknown as Record<string, unknown>)[inFilter[0]])));

        if (orderCol) {
          rows = [...rows].sort((a, b) => {
            const left = String((a as unknown as Record<string, unknown>)[orderCol!] ?? "");
            const right = String((b as unknown as Record<string, unknown>)[orderCol!] ?? "");
            return orderAsc ? left.localeCompare(right) : right.localeCompare(left);
          });
        }

        if (updatePatch) {
          for (const row of rows) Object.assign(row, updatePatch);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (selectCols) return Promise.resolve({ data: rows, error: null }).then(resolve);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  }

  return { supabaseAdmin: { from: () => makeBuilder() } };
});

const { markAbandonedCartsRecovered } = await import("@/lib/cart-recovery");

function cart(over: Partial<CartRow> & { id: string }): CartRow {
  return {
    email: "buyer@x.test",
    status: "active",
    restored_at: null,
    last_updated_at: "2026-09-01T00:00:00.000Z",
    recovered_order_id: null,
    ...over,
  };
}

const ORDER = "order-abc";

beforeEach(() => { store.carts = []; });

describe("exactly one cart is credited", () => {
  it("credits a single cart when the customer has several open", async () => {
    store.carts = [
      cart({ id: "old", last_updated_at: "2026-07-21T00:00:00.000Z" }),
      cart({ id: "older", last_updated_at: "2026-07-22T00:00:00.000Z" }),
      cart({ id: "newest", last_updated_at: "2026-07-29T00:00:00.000Z" }),
    ];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    const credited = store.carts.filter((row) => row.recovered_order_id === ORDER);
    expect(credited).toHaveLength(1);
    expect(credited[0]?.id).toBe("newest");
  });

  it("still closes every other cart, so no reminder can follow a purchase", async () => {
    store.carts = [
      cart({ id: "a", last_updated_at: "2026-07-21T00:00:00.000Z" }),
      cart({ id: "b", last_updated_at: "2026-07-29T00:00:00.000Z" }),
    ];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    expect(store.carts.filter((row) => row.status === "active")).toHaveLength(0);
  });

  it("marks the uncredited carts superseded, not recovered", async () => {
    store.carts = [
      cart({ id: "a", last_updated_at: "2026-07-21T00:00:00.000Z" }),
      cart({ id: "b", last_updated_at: "2026-07-29T00:00:00.000Z" }),
    ];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    const uncredited = store.carts.find((row) => row.id === "a");
    expect(uncredited?.status).toBe("superseded");
    // The order id must be absent, or the dashboard sums its value again.
    expect(uncredited?.recovered_order_id).toBeNull();
  });

  // THE STRONGEST SIGNAL WINS. A restored cart is one the shopper demonstrably
  // came back through — the recovery link worked. That beats recency, which is
  // only a guess about which cart the purchase completed.
  it("prefers a cart the shopper actually restored over the most recent one", async () => {
    store.carts = [
      cart({ id: "restored", last_updated_at: "2026-07-21T00:00:00.000Z", restored_at: "2026-07-21T10:00:00.000Z" }),
      cart({ id: "newer", last_updated_at: "2026-07-29T00:00:00.000Z" }),
    ];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    expect(store.carts.find((row) => row.id === "restored")?.recovered_order_id).toBe(ORDER);
    expect(store.carts.find((row) => row.id === "newer")?.recovered_order_id).toBeNull();
  });

  it("credits the single cart when there is only one", async () => {
    store.carts = [cart({ id: "only" })];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    expect(store.carts[0].status).toBe("recovered");
    expect(store.carts[0].recovered_order_id).toBe(ORDER);
  });

  it("does nothing at all when the customer has no open cart", async () => {
    store.carts = [cart({ id: "done", status: "recovered", recovered_order_id: "order-earlier" })];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    // An already-recovered cart keeps its own order: a later purchase does not
    // re-credit a cart some earlier order already recovered.
    expect(store.carts[0].recovered_order_id).toBe("order-earlier");
  });

  // The existing EMAIL-03 rule, which must survive the change.
  it("leaves every cart alone when the order is not a product purchase", async () => {
    store.carts = [cart({ id: "a" }), cart({ id: "b" })];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "membership" });

    expect(store.carts.every((row) => row.status === "active")).toBe(true);
    expect(store.carts.every((row) => row.recovered_order_id === null)).toBe(true);
  });

  it("does not touch another customer's carts", async () => {
    store.carts = [cart({ id: "mine" }), cart({ id: "theirs", email: "someone@else.test" })];

    await markAbandonedCartsRecovered("buyer@x.test", ORDER, { order_type: "product" });

    expect(store.carts.find((row) => row.id === "theirs")?.status).toBe("active");
  });
});
