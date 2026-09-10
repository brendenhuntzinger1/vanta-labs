import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PAID, SHIPPED, AND INVISIBLE TO THE BID OPTIMISER.
//
// A Purchase conversion is only reported when something performs a GET on
// /api/ads/purchase-event/[orderId], and the only caller is the confirmation
// page. A customer who pays and closes the tab is never reported, and nothing
// looked again.
//
// The real case these tests are written from: between 2026-09-04 and
// 2026-09-10 the store took four paid orders. Three reached TikTok with
// tiktok_code 0. VL-AC6B5634 — $159.97, paid by card, shipped, in transit —
// has no row in ad_purchase_events_sent for tiktok OR reddit. It was never
// reported, and before this job it never would have been: 18% of that week's
// revenue missing from the numbers TikTok optimises against.
//
// The cases that matter most here are the ones where the job must NOT report:
// an order already on the ledger, an order still in flight, and a sale the
// store gave back.
// ---------------------------------------------------------------------------

interface OrderRow {
  order_id: string;
  paid_at: string;
  payment_status: string;
  refunded_at: string | null;
}

const db: {
  orders: OrderRow[];
  ledger: Array<{ order_id: string; platform: string }>;
  asked: string[];
  /** What the route does when asked — the default is "it works". */
  onAsk: (orderId: string) => void;
} = { orders: [], ledger: [], asked: [], onAsk: () => {} };

let adsVerdict: { allowed: boolean; reason?: string } = { allowed: true };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/site-identity", () => ({ siteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/ads/ads-environment", () => ({
  serverAdsReportingAllowed: () => adsVerdict,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      // The filters the job applies are asserted by the rows it returns, so the
      // mock applies them for real rather than ignoring them: a job that
      // dropped `.is("refunded_at", null)` must fail a test, not pass one.
      let refundedMustBeNull = false;
      let strandedBefore = "";
      const b: Record<string, unknown> = {
        select() { return b; },
        eq() { return b; },
        is(column: string) { if (column === "refunded_at") refundedMustBeNull = true; return b; },
        gte() { return b; },
        lte(_column: string, value: string) { strandedBefore = value; return b; },
        order() { return b; },
        limit: async () => ({
          data: db.orders.filter((order) => {
            if (order.payment_status !== "paid") return false;
            if (refundedMustBeNull && order.refunded_at !== null) return false;
            if (strandedBefore && order.paid_at > strandedBefore) return false;
            return true;
          }),
          error: null,
        }),
      };
      return b;
    }
    if (table === "ad_purchase_events_sent") {
      let platform = "";
      const b: Record<string, unknown> = {
        select() { return b; },
        eq(_column: string, value: string) { platform = value; return b; },
        in: async (_column: string, ids: string[]) => ({
          data: db.ledger.filter((row) => row.platform === platform && ids.includes(row.order_id)),
          error: null,
        }),
      };
      return b;
    }
    return { select: () => ({ limit: async () => ({ data: [], error: null }) }) };
  };
  return { supabaseAdmin: { from } };
});

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

const paidOrder = (overrides: Partial<OrderRow> = {}): OrderRow => ({
  order_id: "order-ac6b5634",
  paid_at: HOUR_AGO(),
  payment_status: "paid",
  refunded_at: null,
  ...overrides,
});

const fetchImpl = async (url: string) => {
  const orderId = decodeURIComponent(String(url.split("/purchase-event/")[1] ?? ""));
  db.asked.push(orderId);
  db.onAsk(orderId);
  return { ok: true, status: 200 };
};

async function runRepair(options: Record<string, unknown> = {}) {
  const { repairMissingPurchaseReports } = await import("@/lib/ads/purchase-report-repair");
  return repairMissingPurchaseReports({ fetchImpl, ...options });
}

beforeEach(() => {
  vi.resetModules();
  db.orders = [];
  db.ledger = [];
  db.asked = [];
  // The route, working: being asked claims the TikTok row.
  db.onAsk = (orderId) => { db.ledger.push({ order_id: orderId, platform: "tiktok" }); };
  adsVerdict = { allowed: true };
});

describe("a paid order that never reached TikTok", () => {
  it("is reported — the VL-AC6B5634 case", async () => {
    db.orders = [paidOrder()];

    const result = await runRepair();

    expect(db.asked).toEqual(["order-ac6b5634"]);
    expect(result.reported).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("is still reported when Reddit got it but TikTok did not", async () => {
    // The ledger is PRIMARY KEY (order_id, platform). Asking about the order
    // alone would call this one done and leave the TikTok conversion missing
    // forever — which is exactly the shape of the orders that went astray.
    db.orders = [paidOrder()];
    db.ledger = [{ order_id: "order-ac6b5634", platform: "reddit" }];

    const result = await runRepair();

    expect(db.asked).toEqual(["order-ac6b5634"]);
    expect(result.reported).toBe(1);
  });

  it("counts a failure when asking produced no ledger row", async () => {
    // The route answers 200 for an order it declines to report and 200 again
    // when TikTok rejects the send. Counting status codes would call both a
    // success; only the ledger is evidence.
    db.orders = [paidOrder()];
    db.onAsk = () => {};

    const result = await runRepair();

    expect(result.reported).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe("orders it must leave alone", () => {
  it("does not re-report an order already on the ledger", async () => {
    db.orders = [paidOrder()];
    db.ledger = [{ order_id: "order-ac6b5634", platform: "tiktok" }];

    const result = await runRepair();

    expect(db.asked).toEqual([]);
    expect(result.scanned).toBe(0);
    expect(result.reported).toBe(0);
  });

  it("leaves an order still in flight to the confirmation page", async () => {
    // The page asks within seconds and asks again on the payment poll. Reporting
    // during that window races the browser for the claim to no purpose.
    db.orders = [paidOrder({ paid_at: new Date().toISOString() })];

    const result = await runRepair();

    expect(db.asked).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it("does not resurrect a refunded sale as a fresh conversion", async () => {
    // The confirmation page fires long before a refund can exist. This job runs
    // later and can see one, so reporting it would book revenue the store
    // already gave back.
    db.orders = [paidOrder({ refunded_at: HOUR_AGO() })];

    const result = await runRepair();

    expect(db.asked).toEqual([]);
    expect(result.scanned).toBe(0);
  });
});

describe("the environment gate", () => {
  it("refuses the whole run outside production, and says so", async () => {
    // K-16. The pixel ids fall back to the live account, so a reconciliation
    // job over real paid orders is precisely what must not run from a preview.
    adsVerdict = { allowed: false, reason: "not_production_environment" };
    db.orders = [paidOrder()];

    const result = await runRepair();

    expect(db.asked).toEqual([]);
    expect(result.refused).toBe("not_production_environment");
    expect(result.reported).toBe(0);
  });
});

describe("bounding the work", () => {
  it("defers the rest of a backlog rather than blowing the sweep budget", async () => {
    db.orders = Array.from({ length: 5 }, (_, index) =>
      paidOrder({ order_id: `order-${index}` }),
    );

    const result = await runRepair({ limit: 2 });

    expect(db.asked).toHaveLength(2);
    expect(result.scanned).toBe(5);
    expect(result.reported).toBe(2);
    expect(result.deferred).toBe(3);
  });
});
