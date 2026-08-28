import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE WORK BOARD MUST NOT UNDER-REPORT WHAT IS WAITING.
//
// Three separate ways the fulfilment counts and the exception queue could be
// quietly wrong, all of which render as a calm board with nothing to do:
//
//   ADM-02 / ADM-04  getBucketCounts() selected five columns and none of them
//                    was a CLOCK. carrier_never_scanned and transit_stalled are
//                    the only two exceptions that are measured in time rather
//                    than read off a status, so with label_purchased_at,
//                    shipped_at and updated_at unselected they could never fire
//                    in the count. The rules existed; the count was blind to
//                    them. A parcel the carrier never collected was counted as
//                    "Awaiting Carrier" — a normal, unactionable state — on the
//                    nav badge and the dashboard headline.
//
//   F-A-3 / F-A-4    getBucketCounts() carried no .range() and no .limit(), and
//                    that is NOT the same as being unbounded: PostgREST caps
//                    every response at `db-max-rows` and does it silently. Past
//                    the cap the whole board was computed from the first page.
//
//   ADM-03           getExceptionOrders() read `.order("paid_at", asc).limit(2000)`
//                    and filtered in memory. The scan window therefore sat on
//                    the OLDEST orders in the store — overwhelmingly long-closed
//                    ones — so once the store outgrew the window, an exception
//                    raised today could never appear on the board at all.
//
// The fake below models the two things that make these defects real and that no
// hand-written per-query stub has ever modelled: PostgREST PROJECTS the columns
// you asked for (an unselected column is genuinely absent, not merely unread),
// and it CAPS every response at db-max-rows regardless of what was requested.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** PostgREST's `db-max-rows`. Deliberately smaller than the data below. */
const DB_MAX_ROWS = 1000;

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

function makeClient(rows: Row[]) {
  return {
    from() {
      const filters: Array<(row: Row) => boolean> = [];
      let columns: string[] = [];
      let sortColumn: string | null = null;
      let ascending = true;
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      let limitCount: number | null = null;

      const run = () => {
        let out = rows.filter((row) => filters.every((f) => f(row)));
        if (sortColumn) {
          const column = sortColumn;
          const dir = ascending ? 1 : -1;
          out = [...out].sort((a, b) => dir * String(a[column] ?? "").localeCompare(String(b[column] ?? "")));
        }
        if (limitCount != null) out = out.slice(0, limitCount);
        if (rangeFrom != null) out = out.slice(rangeFrom, rangeTo == null ? undefined : rangeTo + 1);
        // The silent server-side ceiling. Applied last, exactly as PostgREST
        // applies it: the caller asked for more and is handed less, with no
        // error and no flag.
        out = out.slice(0, DB_MAX_ROWS);
        // Projection. A column that was not selected is NOT on the row.
        const projected = out.map((row) => {
          const copy: Row = {};
          for (const column of columns) copy[column] = row[column];
          return copy;
        });
        return { data: projected, error: null };
      };

      const builder: Record<string, unknown> = {
        select(spec: string) {
          columns = String(spec).split(",").map((part) => part.trim()).filter(Boolean);
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => String(row[column] ?? "") === String(value));
          return builder;
        },
        neq(column: string, value: unknown) {
          filters.push((row) => String(row[column] ?? "") !== String(value));
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.map(String).includes(String(row[column] ?? "")));
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push((row) => (value === null ? row[column] == null : row[column] === value));
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          if (op === "is" && (value === null || value === "null")) {
            filters.push((row) => row[column] != null);
          }
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          sortColumn = column;
          ascending = opts?.ascending !== false;
          return builder;
        },
        limit(count: number) { limitCount = count; return builder; },
        range(from: number, to: number) { rangeFrom = from; rangeTo = to; return builder; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    return makeClient(state.rows);
  },
}));

const { getBucketCounts, getExceptionOrders } = await import("@/lib/fulfillment-queues");

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

/** A minimally complete order row. Every column the queue selects exists. */
function order(overrides: Partial<Row> & { order_id: string }): Row {
  return {
    order_number: overrides.order_id,
    customer_name: "Test Buyer",
    customer_email: "buyer@example.com",
    city: "Austin",
    state: "TX",
    country: "US",
    payment_status: "paid",
    fulfillment_status: "paid",
    order_type: "product",
    shippo_sync_status: null,
    shippo_sync_error: null,
    tracking_number: null,
    shipping_carrier: null,
    label_url: null,
    shippo_transaction_id: null,
    label_purchase_claimed_at: null,
    label_voided_at: null,
    paid_at: new Date(NOW - 5 * HOUR).toISOString(),
    created_at: new Date(NOW - 5 * HOUR).toISOString(),
    label_purchased_at: null,
    shipped_at: null,
    updated_at: null,
    priority: false,
    ...overrides,
  };
}

function countOf(counts: Array<{ id: string; count: number }>, id: string) {
  return counts.find((bucket) => bucket.id === id)?.count ?? 0;
}

beforeEach(() => {
  state.rows = [];
});

describe("getBucketCounts — the counts an operator acts on", () => {
  it("counts a label the carrier never scanned as an exception, not as Awaiting Carrier", async () => {
    // ADM-02 / ADM-04. Postage bought two days ago and never scanned. The rule
    // for this exists in fulfillment-buckets.ts and fires everywhere the clock
    // column is READ — so the count is the one place it must not be skipped.
    state.rows = [
      order({
        order_id: "STALE-1",
        fulfillment_status: "label_purchased",
        label_purchased_at: new Date(NOW - 48 * HOUR).toISOString(),
      }),
    ];

    const board = await getBucketCounts();

    expect(countOf(board.counts, "exceptions")).toBe(1);
    expect(countOf(board.counts, "awaiting_carrier")).toBe(0);
  });

  it("counts a parcel that stopped moving as an exception, not as In Transit", async () => {
    state.rows = [
      order({
        order_id: "STALLED-1",
        fulfillment_status: "in_transit",
        updated_at: new Date(NOW - 20 * 24 * HOUR).toISOString(),
      }),
    ];

    const board = await getBucketCounts();

    expect(countOf(board.counts, "exceptions")).toBe(1);
    expect(countOf(board.counts, "in_transit")).toBe(0);
  });

  it("still counts a freshly labelled parcel as Awaiting Carrier", async () => {
    state.rows = [
      order({
        order_id: "FRESH-1",
        fulfillment_status: "label_purchased",
        label_purchased_at: new Date(NOW - 2 * HOUR).toISOString(),
      }),
    ];

    const board = await getBucketCounts();

    expect(countOf(board.counts, "awaiting_carrier")).toBe(1);
    expect(countOf(board.counts, "exceptions")).toBe(0);
  });

  it("counts every order past db-max-rows instead of the first page of them", async () => {
    // F-A-3 / F-A-4. 1,500 orders waiting to ship, a server that hands back
    // 1,000 per response and says nothing about it.
    state.rows = Array.from({ length: 1_500 }, (_, index) =>
      order({ order_id: `READY-${String(index).padStart(5, "0")}` }));

    const board = await getBucketCounts();

    expect(countOf(board.counts, "ready")).toBe(1_500);
    expect(board.truncated).toBe(false);
  });
});

describe("getExceptionOrders — what needs a human", () => {
  it("finds an exception raised today behind a long history of closed orders", async () => {
    // ADM-03. The scan window used to be the 2,000 OLDEST orders, which past
    // that size is entirely long-closed history: an exception raised today sat
    // outside it and appeared on no screen.
    const old = Array.from({ length: 1_400 }, (_, index) =>
      order({
        order_id: `OLD-${String(index).padStart(5, "0")}`,
        fulfillment_status: "delivered",
        paid_at: new Date(NOW - (5_000 - index) * HOUR).toISOString(),
        created_at: new Date(NOW - (5_000 - index) * HOUR).toISOString(),
      }));
    const today = order({
      order_id: "TODAY-1",
      shippo_sync_status: "error",
      shippo_sync_error: "Ship-from address is not valid",
      paid_at: new Date(NOW - HOUR).toISOString(),
      created_at: new Date(NOW - HOUR).toISOString(),
    });
    state.rows = [...old, today];

    const result = await getExceptionOrders({ limit: 50 });

    expect(result.orders.map((o) => o.orderId)).toContain("TODAY-1");
    expect(result.truncated).toBe(false);
  });

  it("returns exceptions oldest-paid first, the order they are worked", async () => {
    state.rows = [
      order({
        order_id: "NEWER",
        payment_status: "awaiting_verification",
        paid_at: new Date(NOW - 2 * HOUR).toISOString(),
        created_at: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      order({
        order_id: "OLDER",
        payment_status: "awaiting_verification",
        paid_at: new Date(NOW - 200 * HOUR).toISOString(),
        created_at: new Date(NOW - 200 * HOUR).toISOString(),
      }),
    ];

    const result = await getExceptionOrders({ limit: 50 });

    expect(result.orders.map((o) => o.orderId)).toEqual(["OLDER", "NEWER"]);
  });
});
