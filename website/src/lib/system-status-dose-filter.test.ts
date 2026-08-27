import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE LAUNCH SCREEN MUST JUDGE WHAT A CUSTOMER CAN ACTUALLY BUY.
//
// Stock, COGS and margin are all resolved from a product's DOSES when it sells
// by dose. The storefront only ever lists doses with is_enabled = true
// (catalog.ts), but this read did not filter, so a RETIRED dose still counted
// as sellable. A single disabled 2 mg dose left behind with its price and cost
// swapped turned "Published products can be sold at a profit" into a
// launch-blocking error and told the operator checkout was refusing carts that
// in fact go through — the status screen lying in the opposite direction from
// the bug it was built to catch.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: { products: Row[]; product_doses: Row[] } = { products: [], product_doses: [] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-provider", () => ({
  isCheckoutOpen: () => true,
  isMockPaymentMode: () => false,
}));
vi.mock("@/lib/email/settings", () => ({ getEmailAdminSettings: async () => ({ ready: true }) }));
vi.mock("@/lib/shippo/config", () => ({
  getShippoStatus: () => ({ configured: true, mode: "live" }),
}));
vi.mock("@/lib/admin-control", () => ({
  getSalesTaxSettings: async () => ({ nexusStates: ["FL"] }),
}));

vi.mock("@/lib/supabase-server", () => {
  function builder(name: string) {
    const rows = (db as Record<string, Row[]>)[name] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    let take: number | null = null;

    function settle() {
      let out = rows.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row }));
      if (take != null) out = out.slice(0, take);
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select() { return b; },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return b; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return b; },
      in(col: string, values: unknown[]) { filters.push((row) => values.includes(row[col])); return b; },
      gte() { return b; },
      order() { return b; },
      limit(n: number) { take = n; return b; },
      async maybeSingle() { return { data: settle().data[0] ?? null, error: null }; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return b;
  }
  return { supabaseAdmin: { from: (name: string) => builder(name) } };
});

const { getSystemStatus } = await import("@/lib/system-status");

/** One published product that sells by dose, priced well above its cost. */
function seed() {
  db.products = [{
    id: "prod-1",
    name: "Test Peptide",
    slug: "test-peptide",
    is_published: true,
    is_archived: false,
    price_cents: 0,
    sale_price_cents: null,
    product_cost_cents: null,
    track_inventory: true,
    inventory_quantity: 10,
  }];
  db.product_doses = [{
    product_id: "prod-1",
    is_enabled: true,
    track_inventory: true,
    inventory_quantity: 10,
    price_cents: 9900,
    sale_price_cents: null,
    product_cost_cents: 3000,
  }];
}

const check = (statuses: Array<{ key: string; level: string; detail: string; blocksLaunch: boolean }>, key: string) =>
  statuses.find((row) => row.key === key)!;

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("a retired dose left in the table", () => {
  it("does not report the product as unsellable", async () => {
    // Priced below cost, but is_enabled = false: nobody can put it in a cart.
    db.product_doses.push({
      product_id: "prod-1",
      is_enabled: false,
      track_inventory: false,
      inventory_quantity: 0,
      price_cents: 1000,
      sale_price_cents: null,
      product_cost_cents: 1400,
    });

    const statuses = await getSystemStatus();

    const margin = check(statuses, "product_sellable_margin");
    expect(margin.level).toBe("ok");
    expect(margin.blocksLaunch).toBe(true);
  });

  it("does not report the product as missing a unit cost", async () => {
    db.product_doses.push({
      product_id: "prod-1",
      is_enabled: false,
      track_inventory: false,
      inventory_quantity: 0,
      price_cents: 5000,
      sale_price_cents: null,
      product_cost_cents: null,
    });

    const statuses = await getSystemStatus();

    expect(check(statuses, "product_cogs").level).toBe("ok");
  });

  it("cannot vouch for oversell protection the customer never gets", async () => {
    // The stock check flags a product only when NOTHING buyable from it is
    // protected. A retired dose that still carries stock therefore VOUCHED for
    // a product whose only live dose can oversell — the same omission reading
    // the other way round.
    db.product_doses = [
      {
        product_id: "prod-1",
        is_enabled: true,
        track_inventory: false,
        inventory_quantity: 0,
        price_cents: 9900,
        sale_price_cents: null,
        product_cost_cents: 3000,
      },
      {
        product_id: "prod-1",
        is_enabled: false,
        track_inventory: true,
        inventory_quantity: 25,
        price_cents: 9900,
        sale_price_cents: null,
        product_cost_cents: 3000,
      },
    ];

    const statuses = await getSystemStatus();

    const stock = check(statuses, "product_inventory_data");
    expect(stock.level).toBe("warn");
    expect(stock.detail).toContain("Test Peptide");
  });
});

describe("an ENABLED dose priced below its cost", () => {
  // The positive control: the check the filter must not switch off. This is a
  // dose a customer can genuinely buy, and checkout really does refuse it.
  it("still blocks launch", async () => {
    db.product_doses.push({
      product_id: "prod-1",
      is_enabled: true,
      track_inventory: true,
      inventory_quantity: 5,
      price_cents: 1000,
      sale_price_cents: null,
      product_cost_cents: 1400,
    });

    const statuses = await getSystemStatus();

    const margin = check(statuses, "product_sellable_margin");
    expect(margin.level).toBe("error");
    expect(margin.detail).toContain("Test Peptide");
  });
});
