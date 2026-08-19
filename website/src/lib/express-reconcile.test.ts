import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// reconcileVeyraPendingPayments is the only code that can move an order to paid
// or to payment_failed WITHOUT a processor webhook. It had no isolated test.
//
// The distinction it must never blur:
//
//   paid at the processor + webhook lost  -> settle (money moved, order owed)
//   session created + never paid          -> LEAVE ALONE (no money moved)
//
// Getting that backwards in either direction is severe: settle a never-paid
// order and the store ships for free; retire a paid one and a charged customer
// loses their order and its stock. Every branch is pinned below against a
// mocked processor, so nothing here touches a live provider.
// ---------------------------------------------------------------------------

const fetchSession = vi.fn();
const processPaymentWebhook = vi.fn(async () => ({ duplicate: false }));
const releaseInventoryForOrder = vi.fn(async () => {});
const recordSystemAlert = vi.fn(async () => {});
const orderUpdate = vi.fn();

let pendingRows: Array<{ order_id: string; payment_id: string | null; created_at: string }> = [];
/** Captured filters from the SELECT, so the query's own safety rails are asserted. */
let selectFilters: Record<string, unknown[]> = {};

function makeOrdersQuery() {
  const q: Record<string, unknown> = {};
  const chain = (key: string) => (...args: unknown[]) => {
    selectFilters[key] = args;
    return q;
  };
  q.select = chain("select");
  q.eq = chain("eq");
  q.not = chain("not");
  q.lt = chain("lt");
  q.order = chain("order");
  // Page 0 returns the rows; every later page is empty so paging terminates.
  let page = 0;
  q.range = (..._args: unknown[]) => {
    const data = page === 0 ? pendingRows : [];
    page += 1;
    return Promise.resolve({ data, error: null });
  };
  return q;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "orders") throw new Error(`unexpected table ${table}`);
      return {
        select: (...a: unknown[]) => {
          const q = makeOrdersQuery();
          return (q.select as (...x: unknown[]) => unknown)(...a);
        },
        update: (payload: unknown) => {
          const captured: Record<string, unknown> = { payload };
          const upd: Record<string, unknown> = {};
          upd.eq = (col: string, val: unknown) => {
            captured[`eq_${col}`] = val;
            // Two .eq() calls chain; the second resolves the statement.
            if (Object.keys(captured).filter((k) => k.startsWith("eq_")).length >= 2) {
              orderUpdate(captured);
              return Promise.resolve({ error: null });
            }
            return upd;
          };
          return upd;
        },
      };
    },
  },
}));

vi.mock("@/lib/env", () => ({ getRequiredEnv: () => "test-secret" }));
vi.mock("@/lib/express-checkout-service", () => ({
  veyraApiBase: () => "https://provider.invalid",
  veyraSecretKey: () => "sk_test",
}));
vi.mock("@/lib/payment-provider", () => ({ signWebhookPayload: () => "sig" }));
vi.mock("@/lib/payment-webhook", () => ({ processPaymentWebhook: (...a: unknown[]) => processPaymentWebhook(...(a as [])) }));
vi.mock("@/lib/inventory-reservation", () => ({ releaseInventoryForOrder: (...a: unknown[]) => releaseInventoryForOrder(...(a as [])) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: (...a: unknown[]) => recordSystemAlert(...(a as [])) }));

const { reconcileVeyraPendingPayments } = await import("@/lib/express-reconcile");

// Older than RECONCILE_AFTER_MS (10 min) so the row is eligible at all.
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function providerSays(status: string | null) {
  fetchSession.mockImplementation(async () =>
    status === null
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({ status }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  selectFilters = {};
  pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: OLD }];
  vi.stubGlobal("fetch", fetchSession);
});

describe("a charge the processor confirms is settled through the real webhook", () => {
  it("settles when the processor reports paid", async () => {
    providerSays("paid");
    const result = await reconcileVeyraPendingPayments();
    expect(result.settled).toBe(1);
    expect(processPaymentWebhook).toHaveBeenCalledTimes(1);
  });

  it("settles by REPLAYING a signed event, never by flipping the row itself", async () => {
    providerSays("succeeded");
    await reconcileVeyraPendingPayments();
    // Routing through the webhook is what inherits paid_side_effects_at,
    // event dedup and every side effect. A direct row update would bypass all
    // three and could double-send email or double-finalize inventory.
    const [body, signature, secret, eventId] = processPaymentWebhook.mock.calls[0] as unknown as string[];
    expect(JSON.parse(body)).toMatchObject({ orderId: "order-1", type: "payment.succeeded", paymentId: "cs_live_1" });
    expect(signature).toBe("sig");
    expect(secret).toBe("test-secret");
    // Deterministic id: re-running the sweep must be a no-op, not a second
    // settlement attempt.
    expect(eventId).toBe("reconcile-order-1");
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("raises a critical alert when a confirmed charge cannot be settled", async () => {
    providerSays("paid");
    processPaymentWebhook.mockRejectedValueOnce(new Error("boom"));
    const result = await reconcileVeyraPendingPayments();
    expect(result.settled).toBe(0);
    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "express_reconcile_failed", severity: "critical" }),
    );
  });
});

describe("an order that was NEVER paid is never promoted", () => {
  // The whole point: a session existing proves only that a shopper reached the
  // card form. These are the statuses that mean the money did not move.
  for (const status of ["open", "processing", "requires_action"]) {
    it(`leaves a "${status}" session completely alone`, async () => {
      providerSays(status);
      const result = await reconcileVeyraPendingPayments();
      expect(result.settled).toBe(0);
      expect(result.failedOut).toBe(0);
      expect(result.unresolved).toBe(1);
      expect(processPaymentWebhook).not.toHaveBeenCalled();
      expect(orderUpdate).not.toHaveBeenCalled();
    });
  }

  it("leaves the order alone when the processor cannot be read", async () => {
    providerSays(null);
    const result = await reconcileVeyraPendingPayments();
    expect(result.settled).toBe(0);
    expect(processPaymentWebhook).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("leaves the order alone when the processor call throws", async () => {
    fetchSession.mockRejectedValue(new Error("network down"));
    const result = await reconcileVeyraPendingPayments();
    expect(result.settled).toBe(0);
    expect(processPaymentWebhook).not.toHaveBeenCalled();
  });
});

describe("a definitively dead session is retired, carefully", () => {
  for (const status of ["failed", "expired", "canceled", "cancelled"]) {
    it(`retires a "${status}" session and returns its stock`, async () => {
      providerSays(status);
      const result = await reconcileVeyraPendingPayments();
      expect(result.failedOut).toBe(1);
      expect(releaseInventoryForOrder).toHaveBeenCalledWith("order-1");
      const captured = orderUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(captured.payload).toMatchObject({ payment_status: "payment_failed" });
      // GUARDED: only a row still reading pending_payment may be retired, so a
      // webhook that marked it paid a moment earlier is never overwritten.
      expect(captured.eq_payment_status).toBe("pending_payment");
      expect(captured.eq_order_id).toBe("order-1");
    });
  }
});

describe("the query only ever considers orders that can be reconciled", () => {
  it("selects unpaid orders that carry a session id, newest first", async () => {
    providerSays("open");
    await reconcileVeyraPendingPayments();
    expect(selectFilters.eq).toEqual(["payment_status", "pending_payment"]);
    // Without a session id there is nothing to ask the processor about.
    expect(selectFilters.not).toEqual(["payment_id", "is", null]);
    expect(selectFilters.lt?.[0]).toBe("created_at");
    expect(selectFilters.order).toEqual(["created_at", { ascending: false }]);
  });

  it("does nothing at all when there is nothing pending", async () => {
    pendingRows = [];
    providerSays("paid");
    const result = await reconcileVeyraPendingPayments();
    expect(result).toEqual({ checked: 0, settled: 0, failedOut: 0, unresolved: 0 });
    expect(processPaymentWebhook).not.toHaveBeenCalled();
  });
});
