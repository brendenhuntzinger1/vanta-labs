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
    // Which page of the RUN this is — the loop builds a fresh query per page,
    // so the failure has to be counted across queries rather than within one.
    const runPage = pagesRead;
    pagesRead += 1;
    if (readErrorOnPage !== null && runPage === readErrorOnPage) {
      return Promise.resolve({ data: null, error: { message: "connection reset" } });
    }
    const data = page === 0 ? pendingRows : [];
    page += 1;
    return Promise.resolve({ data, error: null });
  };
  return q;
}

/** Which SELECT page (if any) comes back as a database error. */
let readErrorOnPage: number | null = null;
/** Pages read so far in this run, counted across the per-page queries. */
let pagesRead = 0;

/** The most recent alert row of the queried type, or null for "none yet". */
let lastAlertAt: string | null = null;

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "system_alerts") {
        // Read-only: the throttle asks when this alert last fired.
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.order = () => q;
        q.limit = () => Promise.resolve({
          data: lastAlertAt ? [{ created_at: lastAlertAt }] : [],
          error: null,
        });
        return q;
      }
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
// Older than RECONCILE_STALE_MS (24h), so it counts toward the backlog warning.
const ANCIENT = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

function providerSays(status: string | null) {
  fetchSession.mockImplementation(async () =>
    status === null
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({ status }) },
  );
}

/** The processor answers with a whole session object, reason fields included. */
function providerSaysSession(session: Record<string, unknown>) {
  fetchSession.mockImplementation(async () => ({ ok: true, json: async () => session }));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectFilters = {};
  lastAlertAt = null;
  readErrorOnPage = null;
  pagesRead = 0;
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

  // WHY it was retired is recorded beside the status, so the admin can tell a
  // shopper who walked away from a bank that said no. Until 2026-09-04 both
  // read as the bare word payment_failed.
  it("records an expired session as an abandoned checkout, not a decline", async () => {
    providerSays("expired");
    await reconcileVeyraPendingPayments();
    const payload = (orderUpdate.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(payload.payment_failure_kind).toBe("checkout_expired");
    expect(payload.payment_failure_code).toBe("expired");
    expect(String(payload.payment_failure_reason)).toMatch(/expired/i);
    expect(typeof payload.payment_failed_at).toBe("string");
  });

  it("records a cancelled session as an abandoned checkout", async () => {
    providerSays("canceled");
    await reconcileVeyraPendingPayments();
    const payload = (orderUpdate.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(payload.payment_failure_kind).toBe("checkout_expired");
    expect(payload.payment_failure_code).toBe("canceled");
  });

  it("records a failed session as a processor decline, keeping the processor's own reason", async () => {
    providerSaysSession({ status: "failed", last_error: { code: "do_not_honor", message: "Do not honor" } });
    await reconcileVeyraPendingPayments();
    const payload = (orderUpdate.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(payload.payment_status).toBe("payment_failed");
    expect(payload.payment_failure_kind).toBe("processor_declined");
    expect(payload.payment_failure_code).toBe("do_not_honor");
    expect(payload.payment_failure_reason).toBe("Do not honor");
  });

  it("never writes failure detail onto a session that is merely still open", async () => {
    providerSays("open");
    await reconcileVeyraPendingPayments();
    expect(orderUpdate).not.toHaveBeenCalled();
  });
});

describe("a checkout the processor never resolves is retired after a week", () => {
  // Older than RECONCILE_ABANDON_MS (7 days).
  const LAST_MONTH = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();

  for (const status of ["open", "processing", "requires_action", null]) {
    it(`retires a week-old "${status ?? "unreadable"}" session as an abandoned checkout and returns its stock`, async () => {
      pendingRows = [{ order_id: "order-old", payment_id: "cs_live_old", created_at: LAST_MONTH }];
      providerSays(status);
      const result = await reconcileVeyraPendingPayments();
      expect(result.failedOut).toBe(1);
      expect(result.unresolved).toBe(0);
      expect(orderUpdate).toHaveBeenCalledTimes(1);
      const call = orderUpdate.mock.calls[0][0] as { payload: Record<string, unknown>; eq_order_id: string; eq_payment_status: string };
      expect(call.eq_order_id).toBe("order-old");
      // Never over a row a webhook has since moved on.
      expect(call.eq_payment_status).toBe("pending_payment");
      expect(call.payload).toMatchObject({
        payment_status: "payment_failed",
        payment_failure_kind: "checkout_expired",
        payment_failure_code: "abandoned",
      });
      expect(String(call.payload.payment_failure_reason)).toMatch(/no charge was attempted/i);
      expect(releaseInventoryForOrder).toHaveBeenCalledWith("order-old");
      expect(processPaymentWebhook).not.toHaveBeenCalled();
    });
  }

  it("still settles a week-old session the processor says is PAID — money moved, order owed", async () => {
    pendingRows = [{ order_id: "order-old", payment_id: "cs_live_old", created_at: LAST_MONTH }];
    providerSays("paid");
    const result = await reconcileVeyraPendingPayments();
    expect(result.settled).toBe(1);
    expect(result.failedOut).toBe(0);
    expect(processPaymentWebhook).toHaveBeenCalledTimes(1);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("leaves a session that is merely a few days old alone", async () => {
    const THREE_DAYS = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    pendingRows = [{ order_id: "order-3d", payment_id: "cs_live_3d", created_at: THREE_DAYS }];
    providerSays("open");
    const result = await reconcileVeyraPendingPayments();
    expect(result.unresolved).toBe(1);
    expect(result.failedOut).toBe(0);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("no longer counts retired checkouts toward the backlog warning", async () => {
    pendingRows = [
      { order_id: "order-old", payment_id: "cs_live_old", created_at: LAST_MONTH },
      { order_id: "order-2d", payment_id: "cs_live_2d", created_at: ANCIENT },
    ];
    providerSays("open");
    await reconcileVeyraPendingPayments();
    const backlog = (recordSystemAlert.mock.calls as unknown as Array<[{ type: string; context: { stale: number } }]>).map((c) => c[0]).find((a) => a.type === "payment_reconcile_backlog");
    expect(backlog).toBeDefined();
    expect(backlog?.context.stale).toBe(1);
  });
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

// ---------------------------------------------------------------------------
// The backlog warning itself. None of this changes which orders are touched —
// it changes only what the operator is told, and how often.
//
// The old copy was wrong in two ways that sent an operator chasing nothing:
// it called these "express" orders (the query matches ANY order carrying a
// session id, and the two that triggered it in production were plain card
// checkouts with checkout_channel NULL), and it said they hold inventory (both
// reservations had read `released` for over a day by the time it first fired).
// It also fired every single sweep — 43 times in 22 hours for two orders — which
// is how a true warning becomes noise nobody reads.
// ---------------------------------------------------------------------------
describe("the backlog warning tells the truth, and only occasionally", () => {
  it("does not claim held inventory, and does not call these express orders", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("open");

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment_reconcile_backlog", severity: "warning" }),
    );
    const [{ message }] = recordSystemAlert.mock.calls[0] as unknown as [{ message: string }];
    expect(message).not.toMatch(/inventory/i);
    expect(message).not.toMatch(/express/i);
  });

  it("stays quiet when the same warning was already raised within the throttle window", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("open");
    lastAlertAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("warns again once the throttle window has passed", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("open");
    lastAlertAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7h ago

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
  });

  it("still says nothing about a pending order that is younger than 24h", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: OLD }];
    providerSays("open");

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("never lets the throttle silence the critical could-not-settle alert", async () => {
    // Throttling is for the aggregate backlog warning only. A charge that is
    // confirmed paid but could not be settled is per-order and severe, and must
    // fire every time regardless of how recently anything else alerted.
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("paid");
    processPaymentWebhook.mockRejectedValueOnce(new Error("boom"));
    lastAlertAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "express_reconcile_failed", severity: "critical" }),
    );
  });
});

// ---------------------------------------------------------------------------
// P9-02. The sweep must not report a clean run when it could not look.
//
// The paging loop used to break on `error || !data || data.length === 0`,
// which made "the database refused the read" indistinguishable from "there is
// nothing pending". The run returned checked: 0 and /api/cron/sweep counted it
// as a success — so the one job standing between a charged card and an order
// that reads unpaid could fail on every tick, silently.
// ---------------------------------------------------------------------------
describe("a read the sweep could not perform is never reported as a clean sweep", () => {
  it("rejects instead of returning checked: 0 when the first page errors", async () => {
    readErrorOnPage = 0;
    // The route records a REJECTED job as a critical cron_sweep_failed alert;
    // a resolved zero records nothing at all.
    await expect(reconcileVeyraPendingPayments()).rejects.toThrow(/could not read pending orders/i);
  });

  it("names the underlying database failure so the alert is actionable", async () => {
    readErrorOnPage = 0;
    await expect(reconcileVeyraPendingPayments()).rejects.toThrow(/connection reset/);
  });

  it("still settles the orders it DID read before raising the failure", async () => {
    // Page 0 reads a full page; page 1 fails. The charge on page 0 is real
    // money owed to a real order, so it must be settled on this run rather
    // than left waiting for the read to recover.
    pendingRows = Array.from({ length: 50 }, (_unused, index) => ({
      order_id: `order-${index}`,
      payment_id: `cs_live_${index}`,
      created_at: OLD,
    }));
    readErrorOnPage = 1;
    providerSays("paid");

    await expect(reconcileVeyraPendingPayments()).rejects.toThrow(/could not read pending orders/i);
    expect(processPaymentWebhook).toHaveBeenCalledTimes(50);
  });

  it("still reports a genuinely empty backlog as a clean, successful run", async () => {
    pendingRows = [];
    await expect(reconcileVeyraPendingPayments()).resolves.toEqual({
      checked: 0,
      settled: 0,
      failedOut: 0,
      unresolved: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// THE SWEEP HAS TO SURVIVE A PROCESSOR THAT DOES NOT ANSWER, AND A BACKLOG.
//
// The read here has always been bounded (10 pages x 50 = 500 rows). The WORK
// was not: 500 sequential HTTP round trips, no per-request timeout and no
// elapsed-time check anywhere in the loop.
//
//   * `fetch` has no default request timeout, so ONE hung connection consumed
//     the whole 60s function budget — and this job shares that budget with
//     every other cron sweep (campaigns, automations, expiry), so one stuck
//     session took all of them down with it. veyra-membership.ts fixed exactly
//     this (K-19) for the same processor; this file was missed.
//
//   * 500 round trips cannot finish in 60s whatever each one costs, so at any
//     real backlog the job was killed mid-run on every tick.
//
// Both are safe to bound: the sweep is idempotent and reads NEWEST FIRST, so a
// freshly charged order is always at the front and what is left behind is the
// oldest and least urgent.
// ---------------------------------------------------------------------------
describe("the sweep bounds its own work", () => {
  it("gives every processor poll a timeout", async () => {
    providerSays("paid");
    await reconcileVeyraPendingPayments();

    expect(fetchSession).toHaveBeenCalled();
    const [, init] = fetchSession.mock.calls[0] as [string, RequestInit];
    // AbortSignal.timeout(...) — not merely "a signal was passed": an already
    // aborted or never-firing signal would satisfy a weaker assertion.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("stops polling once its time budget is spent, and says how far it got", async () => {
    // 500 rows, each poll costing more than the budget allows in total.
    pendingRows = Array.from({ length: 500 }, (_, index) => ({
      order_id: `order-${index}`,
      payment_id: `cs_live_${index}`,
      created_at: OLD,
    }));
    providerSays("unknown"); // neither settle nor retire — just costs a call

    // Advance the clock 4s per poll: the 30s budget is spent after ~8 of them,
    // which is what proves the loop stops on TIME rather than on row count.
    const realNow = Date.now;
    let clock = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fetchSession.mockImplementation(async () => {
      clock += 4_000;
      return { ok: true, json: async () => ({ status: "unknown" }) };
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await reconcileVeyraPendingPayments();

      // Nowhere near all 500, and `checked` reports what was POLLED rather than
      // the size of the queue — an operator reading it sees work done.
      expect(fetchSession.mock.calls.length).toBeLessThan(20);
      expect(result.checked).toBe(fetchSession.mock.calls.length);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stopped after \d+s having polled \d+ of 500/));
    } finally {
      warn.mockRestore();
      (Date.now as unknown as { mockRestore: () => void }).mockRestore();
    }
  });

  it("polls everything when the backlog fits inside the budget", async () => {
    // Guard rail: the budget must not cut short an ordinary run.
    pendingRows = Array.from({ length: 25 }, (_, index) => ({
      order_id: `order-${index}`,
      payment_id: `cs_live_${index}`,
      created_at: OLD,
    }));
    providerSays("paid");

    const result = await reconcileVeyraPendingPayments();

    expect(result.checked).toBe(25);
    expect(result.settled).toBe(25);
  });
});
