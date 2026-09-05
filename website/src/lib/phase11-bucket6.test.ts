import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 6 — regressions for the defects fixed in this pass.
//
// Behavioural where the behaviour is reachable from a unit test (INV-03 and the
// tracking-ledger count below both are). Source-level where it is not: the
// remaining items are a route handler's default, an admin panel's wording and
// two alert-throttle arguments, none of which have a seam that can be driven
// from here without standing up most of Next. handoff-invariants.test.ts sets
// the precedent for asserting on the source in exactly that situation — the
// point is that the assertion fails if someone puts the defect back, not that
// it exercises a call path.
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/inventory-ledger", () => ({ recordInventoryTransaction: vi.fn(async () => {}) }));
vi.mock("@/lib/inventory-fulfillment", () => ({
  readQuantityAfter: vi.fn(async () => ({ after: 5, productId: "p1" })),
  planInventoryAdjustments: vi.fn(() => []),
}));

/**
 * A supabase-js stand-in that answers per (table, status) filter pair.
 *
 * Both reads under test are `.select(...).eq("order_id", x).eq("status", s)`
 * awaited directly, so the builder has to be thenable at the end of the chain
 * rather than expose a terminal method.
 */
const tableAnswers = vi.hoisted(() => new Map<string, { data?: unknown[]; count?: number; error?: unknown }>());
const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase-server", () => {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) =>
        resolve(tableAnswers.get(`${table}:${String(filters.status ?? "")}`) ?? { data: [], count: 0, error: null }),
    };
    return chain;
  };
  return { supabaseAdmin: { from: (table: string) => builder(table), rpc: (...args: unknown[]) => rpc(...args) } };
});

async function inventoryModule() {
  return import("@/lib/inventory-reservation");
}

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  tableAnswers.clear();
});

// ---------------------------------------------------------------------------
// INV-03
// ---------------------------------------------------------------------------
describe("INV-03 — a lost RPC answer is not the same as an RPC that never ran", () => {
  const HOLD = { slug: "bac-water", variant_id: null, quantity: 2 };

  it("does NOT report degraded when the holds are already finalized", async () => {
    // The committed-then-errored case: Postgres finalized the holds, the client
    // never saw the answer. Reporting degraded here makes payment-webhook.ts run
    // the legacy decrement on top, taking every unit off the shelf twice.
    tableAnswers.set("inventory_reservations:active", { data: [HOLD], error: null });
    tableAnswers.set("inventory_reservations:finalized", { count: 1, error: null });
    rpc.mockResolvedValue({ data: null, error: { message: "socket hang up" } });

    const { finalizeInventoryForOrder } = await inventoryModule();
    const result = await finalizeInventoryForOrder("order-1");

    expect(result.degraded).toBe(false);
    expect(result.finalized).toBe(1);
    // Named lines let the caller decrement only what genuinely never moved.
    expect(result.finalizedLines).toEqual([{ slug: "bac-water", variantId: null, quantity: 2 }]);
  });

  it("does NOT report degraded when the RPC throws but the holds are finalized", async () => {
    tableAnswers.set("inventory_reservations:active", { data: [HOLD], error: null });
    tableAnswers.set("inventory_reservations:finalized", { count: 1, error: null });
    rpc.mockRejectedValue(new Error("connection reset"));

    const { finalizeInventoryForOrder } = await inventoryModule();

    expect(await finalizeInventoryForOrder("order-1")).toMatchObject({ degraded: false, finalized: 1 });
  });

  it("STILL reports degraded when nothing was finalized", async () => {
    // A genuinely unavailable RPC must keep triggering the caller's fallback.
    tableAnswers.set("inventory_reservations:active", { data: [HOLD], error: null });
    tableAnswers.set("inventory_reservations:finalized", { count: 0, error: null });
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });

    const { finalizeInventoryForOrder } = await inventoryModule();

    expect(await finalizeInventoryForOrder("order-1")).toMatchObject({ degraded: true, finalized: 0 });
  });

  it("STILL reports degraded when the probe itself fails", async () => {
    // The probe answering 0 on its own failure is what keeps this safe: an
    // unreadable probe must never be why a needed fallback is suppressed.
    tableAnswers.set("inventory_reservations:active", { data: [HOLD], error: null });
    tableAnswers.set("inventory_reservations:finalized", { count: null as unknown as number, error: { message: "boom" } });
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });

    const { finalizeInventoryForOrder } = await inventoryModule();

    expect(await finalizeInventoryForOrder("order-1")).toMatchObject({ degraded: true, finalized: 0 });
  });
});

// ---------------------------------------------------------------------------
// F-A-16
// ---------------------------------------------------------------------------
describe("F-A-16 — the ad purchase ledger reports its real size", () => {
  it("counts rows instead of measuring a capped page", async () => {
    // The old read was `.select("delivered").limit(1000)` reporting data.length,
    // so past 1000 events the board froze at 1000 forever.
    vi.doMock("@/lib/ads/tiktok-events-api", () => ({ credentialStatus: () => ({ missing: [] }), PIXEL_ID: "pixel" }));
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        from: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              return chain;
            },
            then: (resolve: (value: unknown) => unknown) =>
              resolve({ count: filters.delivered === true ? 4100 : 7321, error: null }),
          };
          return chain;
        },
      },
    }));

    const { collectServerHealth } = await import("@/lib/ads/tracking-health-server");
    const health = await collectServerHealth();

    expect(health.purchaseLedger).toEqual({ available: true, total: 7321, delivered: 4100 });
  });

  it("still reports unavailable when the table is missing", async () => {
    vi.doMock("@/lib/ads/tiktok-events-api", () => ({ credentialStatus: () => ({ missing: [] }), PIXEL_ID: "pixel" }));
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        from: () => {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            then: (resolve: (value: unknown) => unknown) =>
              resolve({ count: null, error: { message: "relation does not exist" } }),
          };
          return chain;
        },
      },
    }));

    const { collectServerHealth } = await import("@/lib/ads/tracking-health-server");

    expect((await collectServerHealth()).purchaseLedger).toEqual({ available: false, total: 0, delivered: 0 });
  });
});

// ---------------------------------------------------------------------------
// Source-level invariants
// ---------------------------------------------------------------------------
describe("CFG-08 — the ambassador commission default comes from the program config", () => {
  it("the invite route resolves the default instead of hardcoding one", () => {
    const route = read("app/api/admin/partners/route.ts");
    expect(route).toContain("getReferralProgramConfig");
    expect(route).toContain("body?.commissionPercent ?? defaultCommissionPercent");
    expect(route).not.toContain("body?.commissionPercent ?? 10");
  });

  it("the invite box is seeded from the same resolved default", () => {
    const client = read("components/admin-partners-client.tsx");
    expect(client).toContain("useState(String(programDefaultCommissionPercent))");
    expect(client).not.toContain('const [inviteCommission, setInviteCommission] = useState("10")');
    // The page has to actually pass it, or the prop is inert.
    expect(read("app/admin/partners/page.tsx")).toContain(
      "programDefaultCommissionPercent={referralProgram.defaultCommissionPercent}",
    );
  });
});

describe("E-05 — the replacement panel does not claim an email it never sent", () => {
  it("the route reports the send outcome and queues a failure for retry", () => {
    const route = read("app/api/admin/orders/[orderId]/route.ts");
    // sendEmail resolves { success:false } rather than throwing, so the result
    // has to be read; the surrounding catch never sees a send failure.
    expect(route).toContain("const sent = await sendEmail({ to: replacement.customerEmail");
    expect(route).toContain("customerEmailQueued");
    expect(route).toContain("customerNotified = sent.success");
    // The discarded-result form, which is what made the catch below dead.
    expect(route).not.toMatch(/^\s+await sendEmail\(\{ to: replacement\.customerEmail/m);
  });

  it("the panel branches its wording on that outcome", () => {
    const panel = read("components/admin-order-actions.tsx");
    expect(panel).toContain("json.customerNotified");
    expect(panel).not.toContain("it's in the fulfillment queue and the customer has been emailed.");
  });
});

describe("F-09 — a webhook-created order says what it could not account for", () => {
  it("alerts when the charge exceeds subtotal + shipping - discount", () => {
    const webhook = read("lib/payment-webhook.ts");
    expect(webhook).toContain("webhook_created_order_incomplete");
    // Never guess the split: the remainder is tax + protection + card fee +
    // handling combined, and an invented number would land on a tax report.
    expect(webhook).not.toContain("tax_amount: unallocated");
  });
});

describe("F-A-16 / P2-1 — degraded monitoring paths are audible and throttled across invocations", () => {
  it("the critical-alert count logs its own failure and THROWS instead of answering 0 silently", () => {
    // ADM-05 moved this one step further: it used to log and still answer 0,
    // which the badge drew as an all-clear. Both callers run it through
    // settleRead, so the failure is thrown and carried to the pixel instead.
    const monitoring = read("lib/monitoring.ts");
    expect(monitoring).toContain("Critical-alert count read failed");
    expect(monitoring).toContain("throw new Error(`system_alerts count failed:");
    expect(monitoring).not.toContain("badge may understate");
  });

  it("both module-scope alert throttles also use the persisted window", () => {
    // A module-level timestamp spans one process. finalizeInventoryForOrder
    // fires once per payment webhook and expireStaleReservations once per cron
    // tick, so both always start from a cold Map on a fresh invocation — and
    // each critical sends the operator an email.
    expect(read("lib/inventory-reservation.ts")).toContain("dedupeWindowMs: INVENTORY_ALERT_THROTTLE_MS");
    expect(read("lib/rate-limit.ts")).toContain("dedupeWindowMs: ALERT_THROTTLE_MS");
  });
});

describe("RLS-11 / SQL-11 — SQL files no longer re-create drift, and the rollback says where it is asymmetric", () => {
  it("partner-portal-rls.sql defines the same policy names as partner-system-repair.sql", () => {
    const rls = read("lib/sql/partner-portal-rls.sql");
    for (const table of ["ambassadors", "partner_clicks", "partner_payouts"]) {
      // The duplicate pair survived two advisor migrations because re-running
      // this file put it straight back.
      expect(rls).toContain(`create policy ${table}_select_owner_or_admin on public.${table}`);
      expect(rls).toContain(`drop policy if exists ${table}_select_owner on public.${table};`);
      expect(rls).not.toContain(`create policy ${table}_select_owner on public.${table}`);
    }
  });

  it("the inventory-return-path rollback warns that the function drop is not symmetric", () => {
    const rollback = read("lib/sql/ROLLBACK-inventory-return-path.sql");
    expect(rollback).toContain("NOT SYMMETRIC OUTSIDE PRODUCTION");
    expect(rollback).toContain("deploy-run-once.sql");
  });
});
