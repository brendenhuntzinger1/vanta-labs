import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A TRANSIENT AUTH REJECTION MUST NOT COST A WHOLE SWEEP TICK.
//
// Production evidence (2026-08-27): the Supabase edge rejects roughly 0.1% of
// this app's REST calls with a 401 whose body reads "JWT issued at future".
// Over 24h that was 36 rejections spread across nine different tables and RPCs
// -- admin_control_current, coupons, orders, pending_emails, products and
// expire_stale_reservations among them. The same RPC returned 200 at 10:31,
// 11:01 and 11:30 and 401 at 09:01 and 12:00.
//
// Nothing in the app retried any of it. One blip lost a whole half-hourly tick,
// and `expire_stale_reservations` was simply the only caller loud enough to say
// so -- everything else does `.catch(() => default)` and degrades in silence.
//
// A 401 is refused AT THE EDGE: the statement never reached Postgres. That is
// what makes retrying safe here regardless of whether the RPC is idempotent,
// and it is why the classifier below is deliberately narrow. An error that
// might have EXECUTED -- a statement timeout above all -- must never be
// retried, and a real misconfiguration must alert immediately rather than be
// masked by a retry that cannot help.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  /** Queued replies, consumed one per rpc() call. */
  replies: [] as Array<{ data: number | null; error: { message: string } | null }>,
  calls: 0,
  alerts: [] as Array<{ type: string; context: Record<string, unknown> }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (a: { type: string; context: Record<string, unknown> }) => {
    store.alerts.push({ type: a.type, context: a.context });
  },
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: async () => {
      store.calls += 1;
      return store.replies.shift() ?? { data: 0, error: null };
    },
  },
}));

const {
  expireStaleReservations,
  isTransientAuthRejection,
  __resetInventoryAlertThrottle,
} = await import("@/lib/inventory-reservation");

const JWT_REJECTION = { message: "JWT issued at future" };

beforeEach(() => {
  store.replies = [];
  store.calls = 0;
  store.alerts = [];
  __resetInventoryAlertThrottle();
});

describe("isTransientAuthRejection", () => {
  it("recognises the rejection production actually returns", () => {
    expect(isTransientAuthRejection({ message: "JWT issued at future" })).toBe(true);
  });

  it("recognises an expired token", () => {
    expect(isTransientAuthRejection({ message: "JWT expired" })).toBe(true);
  });

  it("refuses to retry a statement timeout", () => {
    // The statement may have RUN. Re-issuing it is not a free retry, it is a
    // second execution, and this module moves stock.
    expect(isTransientAuthRejection({ message: "canceling statement due to statement timeout" })).toBe(false);
  });

  it("refuses to retry a missing grant", () => {
    // A real, permanent misconfiguration. Retrying only delays the alert that
    // tells the operator to fix the grant.
    expect(isTransientAuthRejection({ message: "permission denied for function expire_stale_reservations" })).toBe(false);
  });

  it("refuses to retry a bad key", () => {
    expect(isTransientAuthRejection({ message: "Invalid API key" })).toBe(false);
  });
});

describe("expireStaleReservations under a transient rejection", () => {
  it("retries once and returns the real count, raising nothing", async () => {
    store.replies = [
      { data: null, error: JWT_REJECTION },
      { data: 4, error: null },
    ];

    expect(await expireStaleReservations()).toBe(4);
    expect(store.calls).toBe(2);
    // The whole point: a blip that recovered is not an incident.
    expect(store.alerts).toHaveLength(0);
  });

  it("gives up after ONE retry and alerts, rather than hammering the edge", async () => {
    store.replies = [
      { data: null, error: JWT_REJECTION },
      { data: null, error: JWT_REJECTION },
    ];

    expect(await expireStaleReservations()).toBe(0);
    expect(store.calls).toBe(2);
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0].type).toBe("inventory_rpc_failed");
  });

  it("does not retry an error that may have executed", async () => {
    store.replies = [
      { data: null, error: { message: "canceling statement due to statement timeout" } },
      { data: 9, error: null },
    ];

    expect(await expireStaleReservations()).toBe(0);
    expect(store.calls).toBe(1);
    expect(store.alerts).toHaveLength(1);
  });

  it("still does not retry a healthy call", async () => {
    store.replies = [{ data: 2, error: null }];

    expect(await expireStaleReservations()).toBe(2);
    expect(store.calls).toBe(1);
  });
});
