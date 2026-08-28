import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Phase 11, bucket 9. One file, six defects, each with the test that would have
// caught it.
//
// The shared Supabase fake below is the reason they can live together: every
// one of these bugs is about WHICH QUERIES GET ISSUED — how many pages, with
// which sort key, against which table — and none of them is visible from a
// return value alone. So the fake records the query objects and each test
// asserts on those, rather than on a number that happened to come out right.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");
const source = (relative: string) => readFileSync(join(SRC, relative), "utf8");

vi.mock("server-only", () => ({}));

type Query = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  columns: string;
  payload: Record<string, unknown> | null;
  filters: Array<{ op: string; column: string; value: unknown }>;
  orders: string[];
  range: [number, number] | null;
  limit: number | null;
};

/** Every query the code under test issued, in order. */
let issued: Query[] = [];
/** Answers a query. Reset per describe block. */
let answer: (query: Query) => { data: unknown[] | null; error: unknown } = () => ({ data: [], error: null });

function newQuery(table: string): Query {
  return { table, op: "select", columns: "", payload: null, filters: [], orders: [], range: null, limit: null };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain(query: Query): any {
  const self: any = {
    select(columns?: string) {
      query.columns = String(columns ?? "");
      return self;
    },
    insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
      query.op = "insert";
      query.payload = Array.isArray(payload) ? { __rows: payload } : payload;
      return self;
    },
    update(payload: Record<string, unknown>) {
      query.op = "update";
      query.payload = payload;
      return self;
    },
    delete() {
      query.op = "delete";
      return self;
    },
    order(column: string) {
      query.orders.push(column);
      return self;
    },
    range(from: number, to: number) {
      query.range = [from, to];
      return self;
    },
    limit(count: number) {
      query.limit = count;
      return self;
    },
    async maybeSingle() {
      const result = answer(query);
      return { data: (result.data ?? [])[0] ?? null, error: result.error };
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve(answer(query)).then(onFulfilled, onRejected);
    },
  };
  for (const op of ["eq", "in", "gte", "lte", "ilike", "is", "not", "or", "match", "contains"]) {
    self[op] = (column: string, value: unknown) => {
      query.filters.push({ op, column, value });
      return self;
    };
  }
  return self;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const query = newQuery(table);
      issued.push(query);
      return chain(query);
    },
  },
}));

/**
 * A PostgREST that caps every response at `cap` rows — the failure mode
 * supabase-page.ts exists for.
 *
 * `max-rows` is a project setting, and the pagers this bucket replaced assumed
 * it was 1000 and stopped on the first short page. Set the cap BELOW their page
 * size and that assumption reads an arbitrarily large table as one page,
 * silently, as a perfectly valid response.
 */
function pageOf<T>(rows: T[], query: Query, cap: number): T[] {
  const [from, to] = query.range ?? [0, rows.length - 1];
  return rows.slice(from, Math.min(to + 1, from + cap));
}

beforeEach(() => {
  issued = [];
  answer = () => ({ data: [], error: null });
  vi.clearAllMocks();
  vi.resetModules();
});

// ===========================================================================
// E-07 — the communications panel could not see the one table that records a
// successful send, so a delivered confirmation read as "no failure recorded".
// ===========================================================================
describe("E-07 — a confirmation the provider accepted reads as SENT, not as an absence of failure", () => {
  const paid = {
    orderNumber: "VL-1042",
    paymentStatus: "paid",
    fulfillmentStatus: "delivered",
    shippedAt: "2026-08-08T10:00:00Z",
    deliveredAt: "2026-08-09T10:00:00Z",
    pendingEmails: [],
  };

  const rowFor = async (input: Record<string, unknown>, key: string) => {
    const { deriveOrderCommunications } = await import("@/lib/order-communications");
    return deriveOrderCommunications(input as never).find((row) => row.key === key)!;
  };

  it("upgrades the confirmation to SENT off a positive order_email_log row", async () => {
    const row = await rowFor(
      {
        ...paid,
        emailLog: [
          { kind: "order_confirmation", status: "sent", provider: "resend", provider_message_id: "msg-9001" },
        ],
      },
      "confirmation",
    );
    expect(row.state).toBe("sent");
    // The provider's own id is the join between our record and theirs; without
    // it a "sent" row is only our word for it, so it is put in front of the owner.
    expect(row.detail).toContain("msg-9001");
    expect(row.detail).toContain("resend");
    expect(row.retryable).toBe(false);
  });

  it("claims nothing for shipping or delivery, which have no success record at all", async () => {
    // sendOrderEmailOnce is only ever called with kind 'order_confirmation'.
    // A SENT badge on the other two rows would be an unbacked claim.
    const input = {
      ...paid,
      emailLog: [{ kind: "order_confirmation", status: "sent", provider: "resend", provider_message_id: "m" }],
    };
    expect((await rowFor(input, "shipping")).state).toBe("no_failure_recorded");
    expect((await rowFor(input, "delivery")).state).toBe("no_failure_recorded");
  });

  it("does not treat an in-flight or failed log row as proof of anything", async () => {
    for (const status of ["sending", "failed"]) {
      const row = await rowFor(
        { ...paid, emailLog: [{ kind: "order_confirmation", status, provider: "resend" }] },
        "confirmation",
      );
      expect(row.state, status).toBe("no_failure_recorded");
    }
  });

  it("keeps the old answer exactly when the log is absent or unreadable", async () => {
    // The log can only ever make an answer STRONGER, so losing it costs
    // certainty and never accuracy — it must not become CANNOT DETERMINE.
    expect((await rowFor(paid, "confirmation")).state).toBe("no_failure_recorded");
    expect((await rowFor({ ...paid, emailLog: null }, "confirmation")).state).toBe("no_failure_recorded");
  });

  it("still lets a recorded FAILURE win over a stale 'sent' log row", async () => {
    const row = await rowFor(
      {
        ...paid,
        pendingEmails: [
          { id: "1", subject: "Order Confirmed - VL-1042", status: "failed", attempts: 5, last_error: "bounced" },
        ],
        emailLog: [{ kind: "order_confirmation", status: "sent", provider: "resend" }],
      },
      "confirmation",
    );
    expect(row.state).toBe("failed");
  });

  it("the route actually reads order_email_log, and a failed read costs only the upgrade", () => {
    const route = source("app/api/admin/orders/[orderId]/communications/route.ts");
    expect(route).toContain('.from("order_email_log")');
    expect(route).toContain("provider_message_id");
    // Same null-means-unread discipline as the pending_emails read beside it.
    expect(route).toContain("if (!error) emailLog =");
  });

  it("the panel no longer tells the owner that nothing records a successful send", () => {
    const panel = source("components/admin-order-communications.tsx");
    expect(panel).not.toContain("Nothing records a successful send");
    expect(panel).toContain('sent: "SENT"');
  });
});

// ===========================================================================
// F-A-9 / M-12 — the CSV export hand-rolled the pager supabase-page.ts deleted,
// and stated a revenue identity that only holds on one side of a setting.
// ===========================================================================
describe("F-A-9 — the orders export reads every order, not just the first page", () => {
  const ORDERS = Array.from({ length: 2500 }, (_, index) => ({
    order_id: `order-${String(index).padStart(4, "0")}`,
    customer_email: "buyer@example.test",
    customer_name: "Buyer",
    amount_paid: 100,
    payment_status: "paid",
    fulfillment_status: "delivered",
    tracking_number: "",
    referral_code: "",
    coupon_code: "",
    refund_amount: 0,
    created_at: "2026-08-01T00:00:00Z",
  }));

  beforeEach(() => {
    vi.doMock("@/lib/admin-auth", () => ({
      verifyAdminSessionFromRequest: async () => ({ username: "owner", role: "super_admin" }),
    }));
    vi.doMock("@/lib/admin-profit", () => ({ getOrderProfitMap: async () => new Map() }));
    // The cap is 500 — BELOW the 1000-row page the deleted pager asked for, which
    // is the exact configuration its docblock says reads a whole table as one
    // page. Not hypothetical: `max-rows` is a project setting this code cannot see.
    answer = (query) => ({ data: pageOf(ORDERS, query, 500), error: null });
  });

  const runExport = async () => {
    const { GET } = await import("@/app/api/admin/orders/export/route");
    const response = await GET(new Request("https://vanta.test/api/admin/orders/export"));
    return (await response.text()).trim().split("\n");
  };

  it("exports all 2,500 orders when every page comes back short", async () => {
    const lines = await runExport();
    // 1 header + 2500 rows. The old loop stopped on the first short page and
    // produced 501 lines, as a perfectly well-formed CSV.
    expect(lines).toHaveLength(2501);
  });

  it("pages with a unique tiebreak so a shared created_at cannot repeat or skip a row", async () => {
    await runExport();
    const orderReads = issued.filter((query) => query.table === "orders" && query.op === "select");
    expect(orderReads.length).toBeGreaterThan(1);
    for (const read of orderReads) expect(read.orders).toEqual(["created_at", "order_id"]);
  });

  it("advances by the rows it actually received, never by a fixed stride", async () => {
    await runExport();
    const ranges = issued
      .filter((query) => query.table === "orders" && query.range)
      .map((query) => query.range![0]);
    // 0, 500, 1000, … — the received-row stride. A fixed stride would have been
    // 0, 1000, 2000 and would have skipped half the table behind the cap.
    expect(ranges.slice(0, 3)).toEqual([0, 500, 1000]);
  });

  it("says so in the file when an export is clipped, instead of looking complete", async () => {
    const { readAllRowsBounded } = await import("@/lib/supabase-page");
    const { rows, truncated } = await readAllRowsBounded<unknown>(
      (from, to) => Promise.resolve({ data: ORDERS.slice(from, to + 1), error: null }),
      { maxRows: 100 },
    );
    expect(rows).toHaveLength(100);
    expect(truncated).toBe(true);
    expect(source("app/api/admin/orders/export/route.ts")).toContain("TRUNCATED:");
  });
});

describe("M-12 — the export says which side of the sales-tax setting each row was priced on", () => {
  beforeEach(() => {
    vi.doMock("@/lib/admin-auth", () => ({
      verifyAdminSessionFromRequest: async () => ({ username: "owner", role: "super_admin" }),
    }));
    vi.doMock("@/lib/admin-profit", () => ({
      getOrderProfitMap: async () =>
        new Map([
          [
            "order-1",
            {
              grossRevenue: 100, merchandiseRevenue: 90, additionalRevenue: 0, creditRedeemed: 0,
              cogs: 30, shippingCharged: 10, shippingCost: 6, shippingProfit: 4, processingFee: 3,
              commission: 0, taxCollected: 7,
              // The coded default: admin-control.ts ships countSalesTaxAsProfit
              // false "BY OWNER'S DECISION", which is the branch that breaks the
              // identity the header comment used to state unconditionally.
              taxCountedAsProfit: false,
              profit: 61, marginPercent: 61, profitStatus: "estimated",
            },
          ],
        ]),
    }));
    answer = (query) =>
      query.table === "orders"
        ? {
            data: pageOf(
              [{ order_id: "order-1", customer_email: "b@example.test", customer_name: "B", amount_paid: 100, payment_status: "paid", fulfillment_status: "delivered", tracking_number: "", referral_code: "", coupon_code: "", refund_amount: 0, created_at: "2026-08-01T00:00:00Z" }],
              query,
              1000,
            ),
            error: null,
          }
        : { data: [], error: null };
  });

  it("exports tax_counted_as_profit per row, so the decomposition is self-describing", async () => {
    const { GET } = await import("@/app/api/admin/orders/export/route");
    const csv = (await (await GET(new Request("https://vanta.test/x"))).text()).trim().split("\n");
    const columns = csv[0].split(",");
    const index = columns.indexOf("tax_counted_as_profit");
    expect(index).toBeGreaterThan(-1);
    expect(csv[1].split(",")[index]).toBe("false");
  });

  it("the identity in the header states the condition rather than asserting it always holds", () => {
    const route = source("app/api/admin/orders/export/route.ts");
    // gross_revenue only includes sales_tax_collected when the store counts tax
    // as profit; order-profit.ts adds that term behind `countTaxAsProfit`.
    expect(route).toMatch(/ONLY when the store counts sales/);
  });
});

// ===========================================================================
// F-A-14 — cart-recovery rates were ratios over one silently truncated page.
// ===========================================================================
describe("F-A-14 — cart recovery rates are computed over the whole table", () => {
  const CARTS = Array.from({ length: 2500 }, (_, index) => ({
    id: `cart-${index}`,
    status: index < 500 ? "recovered" : "active",
    cart_value_cents: 1000,
    first_seen_at: "2026-08-01T00:00:00Z",
    recovered_order_id: null,
  }));
  // Every email on the first page was opened and none after it. A capped read
  // therefore reports a 100% open rate for a table whose real rate is 20%.
  const EMAILS = Array.from({ length: 2500 }, (_, index) => ({
    id: `email-${index}`,
    sent_at: "2026-08-01T00:00:00Z",
    opened_at: index < 500 ? "2026-08-01T01:00:00Z" : null,
    clicked_at: null,
    coupon_id: null,
  }));

  beforeEach(() => {
    answer = (query) => {
      if (query.table === "abandoned_carts") return { data: pageOf(CARTS, query, 500), error: null };
      if (query.table === "abandoned_cart_emails") return { data: pageOf(EMAILS, query, 500), error: null };
      return { data: [], error: null };
    };
  });

  it("counts every abandoned cart, not the first page of them", async () => {
    const { getCartRecoveryStats } = await import("@/lib/admin-cart-recovery");
    const stats = await getCartRecoveryStats();
    expect(stats.totalAbandoned).toBe(2500);
    expect(stats.totalRecovered).toBe(500);
    expect(stats.recoveryPercent).toBe(20);
  });

  it("reports the real open rate rather than the first page's", async () => {
    const { getCartRecoveryStats } = await import("@/lib/admin-cart-recovery");
    const stats = await getCartRecoveryStats();
    // Truncated at 500 this read 100. The figure is rendered as the store's
    // email open rate, which is what the owner uses to decide whether recovery
    // emails are worth running.
    expect(stats.openRatePercent).toBe(20);
  });

  it("sums potential lost revenue over every active cart", async () => {
    const { getCartRecoveryStats } = await import("@/lib/admin-cart-recovery");
    const stats = await getCartRecoveryStats();
    expect(stats.potentialLostRevenueCents).toBe(2000 * 1000);
  });

  it("pages the trend too — a date range is not a row cap", async () => {
    const { getCartRecoveryTrend } = await import("@/lib/admin-cart-recovery");
    const trend = await getCartRecoveryTrend(30);
    expect(trend.reduce((sum, point) => sum + point.abandoned, 0)).toBe(2500);
  });

  it("pages on a unique key, so a shared first_seen_at cannot repeat or skip a cart", async () => {
    const { getCartRecoveryStats } = await import("@/lib/admin-cart-recovery");
    await getCartRecoveryStats();
    const cartReads = issued.filter((query) => query.table === "abandoned_carts");
    expect(cartReads.length).toBeGreaterThan(1);
    for (const read of cartReads) expect(read.orders).toEqual(["id"]);
  });
});

// ===========================================================================
// INV-04 — a replacement decremented real stock and left no receipt, so
// cancelling it took the release branch and the units never came back.
// ===========================================================================
describe("INV-04 — a replacement records that its stock actually left the shelf", () => {
  const ORIGINAL_ID = "order-original-0001";
  const ORIGINAL_ROW = {
    order_id: ORIGINAL_ID,
    order_number: "VL-ORIG0001",
    payment_status: "paid",
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    shipping_address: "1 Test Street",
    city: "Testville",
    postal_code: "00000",
    country: "US",
    currency: "USD",
    order_items: [{ id: 1, product_id: "prod-1", product_name: "BPC-157 10mg", quantity: 2, unit_cost_cents: 1000 }],
  };

  let decrementResult = { attempted: 1, failed: 0, errors: [] as string[] };

  beforeEach(() => {
    decrementResult = { attempted: 1, failed: 0, errors: [] };
    vi.doMock("@/lib/inventory-fulfillment", () => ({
      decrementInventoryForOrder: vi.fn(async () => decrementResult),
    }));
    vi.doMock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => undefined) }));
    answer = (query) => {
      if (query.table === "orders" && query.op === "select") {
        const wanted = query.filters.find((filter) => filter.column === "order_id")?.value;
        return { data: wanted === ORIGINAL_ID ? [ORIGINAL_ROW] : [], error: null };
      }
      return { data: [], error: null };
    };
  });

  const create = async () => {
    const { createReplacementOrder } = await import("@/lib/admin-replacements");
    return createReplacementOrder({ originalOrderId: ORIGINAL_ID, reason: "damaged", requestId: "req-1" });
  };

  const latchWrites = () =>
    issued.filter(
      (query) =>
        query.table === "orders" &&
        query.op === "update" &&
        Object.prototype.hasOwnProperty.call(query.payload ?? {}, "inventory_committed_at"),
    );

  it("stamps inventory_committed_at once the decrement has run", async () => {
    await create();
    // order-cancellation-inventory.ts reads exactly this column to decide
    // between restocking and releasing. Without it a cancelled replacement took
    // the release branch — a no-op, because a replacement never held a
    // reservation — and the units were lost from the count.
    expect(latchWrites()).toHaveLength(1);
    expect(latchWrites()[0].payload!.inventory_committed_at).toEqual(expect.any(String));
  });

  it("leaves it NULL when only some lines decremented", async () => {
    // Restocking returns EVERY line, so a receipt over a partial would invent
    // units for the lines that never moved. Under-restock is recoverable;
    // over-restock oversells.
    decrementResult = { attempted: 3, failed: 1, errors: ["rpc failed"] };
    await create();
    expect(latchWrites()).toHaveLength(0);
  });

  it("never writes the latch as part of the insert, which happens before the stock moves", async () => {
    await create();
    const inserts = issued.filter((query) => query.table === "orders" && query.op === "insert");
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) {
      expect(Object.keys(insert.payload ?? {})).not.toContain("inventory_committed_at");
    }
  });
});

// ===========================================================================
// SQL-09 / SQL-10 — deploy-run-once.sql declared two column defaults that
// disagreed with the file that was supposed to own them, and it runs first.
// ===========================================================================
describe("SQL-09 / SQL-10 — the schema's column defaults agree with the code that reads them", () => {
  const deploy = source("lib/sql/deploy-run-once.sql");

  it("admin_credentials.role defaults to the least-privileged role, in both declarations", () => {
    // admin-rbac-refunds.sql calls 'staff' "the default"; deploy-run-once.sql
    // said 'super_admin' and is the file on every documented path, so every
    // real database took the privileged one.
    expect(deploy).not.toMatch(/role text not null default 'super_admin'/);
    expect(deploy.match(/role text not null default 'staff'/g)).toHaveLength(2);
    expect(source("lib/sql/admin-rbac-refunds.sql")).toContain("role text not null default 'staff'");
  });

  it("customer_memberships.intro_status defaults to a value the type union contains", () => {
    // membership.ts types introStatus as
    // "not_applicable" | "active" | "converted" | "failed" and coalesces only
    // NULL, so a stored 'none' passed through un-normalised.
    expect(deploy).not.toMatch(/intro_status text not null default 'none'/);
    expect(deploy.match(/intro_status text not null default 'not_applicable'/g)).toHaveLength(2);
    expect(source("lib/membership.ts")).not.toMatch(/introStatus:[^;]*"none"/);
  });

  it("carries the ALTER that makes an already-built database converge", () => {
    // `add column if not exists` is a no-op where the column exists, so it can
    // never correct a default those databases were built with.
    expect(deploy).toContain("alter column role set default 'staff'");
    expect(deploy).toContain("alter column intro_status set default 'not_applicable'");
  });
});

// ===========================================================================
// F-TAX-09 — four documents still described a flat, merchandise-only tax model
// that the code replaced with per-state rates that can include shipping.
// ===========================================================================
describe("F-TAX-09 — the tax documentation describes the tax code that shipped", () => {
  const doc = (name: string) => readFileSync(join(process.cwd(), name), "utf8");

  it("no document still claims tax is charged on merchandise only", () => {
    for (const name of ["LAUNCH_CHECKLIST.md", "FINAL_QA_REPORT.md", "AUDIT-PHASE1-SOURCE-OF-TRUTH.md"]) {
      expect(doc(name), name).not.toContain("tax on merchandise only");
    }
    // sales-tax.ts adds shipping to the taxable base wherever the destination
    // state taxes delivery charges, which is most of the table.
    const salesTax = source("lib/sales-tax.ts");
    expect(salesTax).toContain("rule.shippingTaxable ? shipping : 0");
    expect((salesTax.match(/shippingTaxable: true/g) ?? []).length).toBeGreaterThan(0);
  });

  it("COMPLIANCE.md no longer offers a single flat rate that the code cannot apply", () => {
    // "the flat model is gone" — sales-tax.ts, on calculateTaxAmount.
    expect(doc("COMPLIANCE.md")).not.toContain("a single flat rate is supported today");
    expect(doc("COMPLIANCE.md")).toContain("US_STATE_TAX_TABLE");
    // The nexus question is the one that still genuinely needs an answer.
    expect(doc("COMPLIANCE.md")).toContain("where you have nexus");
  });
});
