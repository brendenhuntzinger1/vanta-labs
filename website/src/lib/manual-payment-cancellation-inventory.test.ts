import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// REVIEW FINDING 2 (P0) — THE CANCEL PATH ASKED A QUESTION ONLY ONE LANE ANSWERS.
//
// returnInventoryForCancelledOrder decides "were these units decremented?" by
// reading orders.paid_side_effects_at. Its own docblock states that latch is
// "the signal, because it is the latch under which the paid side effects run".
//
// That was true of exactly one lane. `paid_side_effects_at` is written in ONE
// place in the whole repository — processPaymentWebhook, the card lane.
// finalizeManualPayment runs the identical side effects behind its OWN claim
// (the conditional flip of payment_status) and never touched the latch.
//
// So for a manually-paid order: inventory decremented, latch NULL, cancel takes
// the "never decremented" branch, calls releaseInventoryForOrder — which only
// reclaims reservations still `active`, and this one is `finalized`, so it is a
// NO-OP — and returns the reassuring string "released". The units are gone.
//
// WHY THE EXISTING SUITE COULD NOT SEE THIS. order-cancellation-inventory.test.ts
// builds order fixtures and sets paid_side_effects_at BY HAND to model "paid". A
// test that constructs the latch it is testing can never discover that the
// production writer does not set it. This file therefore drives the REAL
// finalizeManualPayment into the REAL returnInventoryForCancelledOrder over one
// shared order store, and asserts on the stock.
//
// SECOND DEFECT, found while reproducing: orders.inventory_restocked_at DOES NOT
// EXIST in production (checked 2026-08-26). claimInventoryRestock returns false
// on ANY error, so a missing column is indistinguishable from "someone else
// already restocked" — and the cancel path reports "already_returned". The K-17
// fix was therefore inert on the CARD lane too, silently, for the same reason:
// a failure wearing a success's clothes.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-manual-cancel-1";

interface OrderRow {
  id: string;
  order_id: string;
  payment_status: string;
  payment_method: string;
  order_type: string;
  paid_side_effects_at: string | null;
  /** The receipt the cancel path reads: written only after stock moved. */
  inventory_committed_at: string | null;
  inventory_restocked_at: string | null;
  [key: string]: unknown;
}

const db: {
  order: OrderRow;
  /** false models production TODAY: the restock-claim migration is unapplied. */
  restockClaimColumnExists: boolean;
  decremented: number;
  restocked: Array<unknown[]>;
  released: string[];
  alerts: Array<{ type: string; message: string }>;
} = {
  order: {} as OrderRow,
  restockClaimColumnExists: true,
  decremented: 0,
  restocked: [],
  released: [],
  alerts: [],
};

function freshOrder(): OrderRow {
  return {
    id: "row-1",
    order_id: ORDER_ID,
    order_number: "VL-MC1",
    payment_status: "awaiting_verification",
    payment_method: "zelle",
    order_type: "product",
    paid_side_effects_at: null,
    inventory_committed_at: null,
    inventory_restocked_at: null,
    customer_email: null,
    customer_name: "A Buyer",
    customer_user_id: null,
    coupon_code: null,
    ambassador_id: null,
    referral_code: null,
    subtotal: 200,
    discount_amount: 0,
    amount_paid: 200,
    tax_amount: 0,
    shipping_amount: 0,
    card_processing_fee: 0,
    currency: "USD",
    // No variant_id — production's order_items has no such column (VL-1).
    order_items: [{ product_id: "p1", quantity: 3, product_name: "Item", line_total: 200 }],
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: { type: string; message: string }) => { db.alerts.push(alert); }),
}));

// claimInventoryRestock is left REAL — it is half of what is under test here.
// Only the two stock movers are stubbed, so the assertions are about which one ran.
vi.mock("@/lib/inventory-fulfillment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-fulfillment")>();
  return {
    ...actual,
    restockInventoryForOrder: vi.fn(async (items: unknown[]) => { db.restocked.push(items); }),
    decrementInventoryForOrder: vi.fn(async () => {
      db.decremented += 1;
      return { attempted: 1, failed: 0, errors: [] as string[] };
    }),
  };
});
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => { db.decremented += 1; return { finalized: 1, degraded: false, finalizedLines: null }; }),
  releaseInventoryForOrder: vi.fn(async (orderId: string) => { db.released.push(orderId); }),
}));

vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 0,
  getActivePointsMultiplier: async () => ({ multiplier: 1 }),
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/order-emails", () => ({
  sendOrderEmailOnce: vi.fn(async () => ({ attempted: false, sent: false, error: null })),
}));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "s", html: "h", text: "t" }),
  orderConfirmationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 0, tierName: null })),
  detectCommissionFraudSignal: vi.fn(async () => ({ flagged: false, reason: null })),
}));
vi.mock("@/lib/shippo/order-sync", () => ({ syncOrderToShippo: vi.fn(async () => {}) }));
vi.mock("@/lib/store-credit", () => ({
  redeemStoreCredit: vi.fn(async () => {}),
  refundStoreCreditForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/membership-billing", () => ({
  activatePaidMembership: vi.fn(async () => {}),
  revokeMembershipForRefund: vi.fn(async () => {}),
}));
vi.mock("@/lib/cart-recovery", () => ({ markAbandonedCartsRecovered: vi.fn(async () => {}) }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({}) }));
vi.mock("@/lib/ambassador-settings", () => ({ getAmbassadorProgramSettings: async () => ({ enabled: false }) }));
vi.mock("@/lib/admin-control", () => ({ getReferralProgramConfig: async () => ({ enabled: false }) }));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: () => 0 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/analytics-events", () => ({ logCommerceAnalyticsEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

/**
 * PostgREST refusing a column the database does not have. This is what
 * production returns for inventory_restocked_at today.
 */
const MISSING_COLUMN = {
  code: "PGRST204",
  message: "Could not find the 'inventory_restocked_at' column of 'orders' in the schema cache",
};

vi.mock("@/lib/supabase-server", () => {
  const ordersTable = () => ({
    // PostgREST returns ONLY the columns asked for, nested projections
    // included. A double that hands back the whole row instead lets code read a
    // column it never selected and still pass — so the projection is honoured.
    select: (columns?: string) => {
      const nested = /order_items\(([^)]*)\)/.exec(columns ?? "");
      const project = (row: OrderRow) => {
        if (!nested) return { ...row };
        const keep = nested[1].split(",").map((c) => c.trim()).filter(Boolean);
        return {
          ...row,
          order_items: (row.order_items as Array<Record<string, unknown>>).map((item) =>
            Object.fromEntries(keep.map((column) => [column, item[column]]))),
        };
      };
      const builder: Record<string, unknown> = {
        eq: () => builder,
        maybeSingle: async () => ({ data: project(db.order), error: null }),
      };
      return builder;
    },
    update: (patch: Record<string, unknown>) => {
      const filters: Array<[string, unknown]> = [];
      const apply = () => {
        const statusGuard = filters.find(([c]) => c === "payment_status");
        if (statusGuard && statusGuard[1] !== db.order.payment_status) return [];
        const restockGuard = filters.find(([c]) => c === "is:inventory_restocked_at");
        if (restockGuard && !(restockGuard[1] === null && db.order.inventory_restocked_at === null)) return [];
        const seGuard = filters.find(([c]) => c === "is:paid_side_effects_at");
        if (seGuard && !(seGuard[1] === null && db.order.paid_side_effects_at === null)) return [];
        Object.assign(db.order, patch);
        return [{ id: db.order.id }];
      };
      const builder: Record<string, unknown> = {
        eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
        is(column: string, value: unknown) { filters.push([`is:${column}`, value]); return builder; },
        async select() {
          // The column genuinely absent: PostgREST refuses the whole statement.
          if (!db.restockClaimColumnExists && "inventory_restocked_at" in patch) {
            return { data: null, error: MISSING_COLUMN };
          }
          return { data: apply(), error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          if (!db.restockClaimColumnExists && "inventory_restocked_at" in patch) {
            return Promise.resolve({ error: MISSING_COLUMN }).then(resolve);
          }
          apply();
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return builder;
    },
  });

  const from = (table: string) => {
    if (table === "orders") return ordersTable();
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
  };
  return { supabaseAdmin: { from } };
});

beforeEach(() => {
  vi.clearAllMocks();
  db.order = freshOrder();
  db.restockClaimColumnExists = true;
  db.decremented = 0;
  db.restocked = [];
  db.released = [];
  db.alerts = [];
});

async function approveManualPayment() {
  const { finalizeManualPayment } = await import("@/lib/payment-webhook");
  return finalizeManualPayment(ORDER_ID, { verifiedBy: "owner" });
}

async function cancel() {
  const { returnInventoryForCancelledOrder } = await import("@/lib/order-cancellation-inventory");
  return returnInventoryForCancelledOrder(ORDER_ID);
}

describe("cancelling an order that was paid through the MANUAL lane", () => {
  it("decrements the stock when the admin approves the payment", async () => {
    // Premise check. If this stops being true the rest proves nothing.
    await approveManualPayment();
    expect(db.order.payment_status).toBe("paid");
    expect(db.decremented).toBe(1);
  });

  it("RETURNS the units to stock on cancel, instead of writing them off", async () => {
    await approveManualPayment();

    const outcome = await cancel();

    // The whole finding: this used to be { action: "released" } with an empty
    // restock list — three units destroyed and a reassuring string returned.
    expect(outcome.action).toBe("restocked");
    expect(db.restocked).toHaveLength(1);
    expect(db.restocked[0]).toEqual([{ product_id: "p1", quantity: 3 }]);
  });

  it("marks the paid side effects as having run, so both lanes answer the same question", async () => {
    await approveManualPayment();
    // The latch is the shared vocabulary between the two lanes. The manual lane
    // running the identical side effects must record that identically.
    expect(db.order.paid_side_effects_at).not.toBeNull();
  });

  it("also records the inventory receipt the cancel path actually reads", async () => {
    // VL-10. paid_side_effects_at is the card lane's CLAIM, taken before its
    // side effects run, so it cannot answer "did the units leave the shelf?".
    // inventory_committed_at is that answer, and both lanes write it.
    await approveManualPayment();
    expect(db.order.inventory_committed_at).not.toBeNull();
  });

  it("leaves the latch NULL if the stock never actually moved, so a cancel cannot INVENT units", async () => {
    // The latch must mean "the decrement happened", not "the decrement was
    // about to be attempted". Writing it up with the paid-flip would mark stock
    // as decremented before it was, and a crash in between would let this
    // cancel restock three units that were never removed.
    const reservation = await import("@/lib/inventory-reservation");
    vi.mocked(reservation.finalizeInventoryForOrder).mockRejectedValueOnce(new Error("inventory RPC down"));

    // THE APPROVAL ITSELF SUCCEEDS. The payment is verified and recorded; it is
    // the STOCK that did not move. Re-throwing here used to report a fully
    // successful payment as failed and skip the audit row, the push
    // notification and the Shippo push — none of which the admin's retry can
    // recover, because it returns alreadyPaid. The latch is the protection, and
    // it is what stays NULL.
    await expect(approveManualPayment()).resolves.toBeTruthy();
    expect(db.order.payment_status).toBe("paid");
    expect(db.order.paid_side_effects_at).toBeNull();
    expect(db.order.inventory_committed_at).toBeNull();
    expect(db.alerts.map((a) => a.type)).toContain("unsafe_effect_failed_inventory_decrement");

    const outcome = await cancel();
    expect(outcome.action).toBe("released");
    expect(db.restocked).toHaveLength(0);
  });

  // FIX WAVE 3 — THE REAL FAILURE PATH, WHICH NOTHING USED TO CATCH.
  //
  // finalizeInventoryForOrder does not throw when the RPC is unavailable: it
  // returns { finalized: 0, degraded: true }. decrementInventoryForOrder did not
  // throw either — it logged each failing line and returned void. So on the one
  // failure mode that actually happens, execution fell straight through: no
  // alert, and the latch WAS written over stock that never moved. A later cancel
  // then read the latch, took the restock branch, and added units that were
  // never removed — inventing stock, which oversells.
  it("leaves the latch NULL when the degraded fallback decrement fails on every line", async () => {
    const reservation = await import("@/lib/inventory-reservation");
    const fulfillment = await import("@/lib/inventory-fulfillment");
    vi.mocked(reservation.finalizeInventoryForOrder).mockResolvedValueOnce({ finalized: 0, degraded: true, finalizedLines: null });
    vi.mocked(fulfillment.decrementInventoryForOrder).mockResolvedValueOnce({
      attempted: 1,
      failed: 1,
      errors: ["p1: adjust_inventory_on_sale unavailable"],
    });

    await expect(approveManualPayment()).resolves.toBeTruthy();
    expect(db.order.payment_status).toBe("paid");
    expect(db.order.paid_side_effects_at).toBeNull();
    expect(db.order.inventory_committed_at).toBeNull();
    expect(db.alerts.map((a) => a.type)).toContain("unsafe_effect_failed_inventory_decrement");

    // And the consequence the latch exists to prevent: no invented units.
    const outcome = await cancel();
    expect(outcome.action).toBe("released");
    expect(db.restocked).toHaveLength(0);
  });

  // FIX WAVE 4 (F-10) — "THE FALLBACK FAILED" AND "NO STOCK MOVED" ARE
  // DIFFERENT FACTS, AND ONE BOOLEAN SAID BOTH.
  //
  // When the fallback decrement moves SOME lines and errors on others, the units
  // that did move are gone from the count and the latch stays NULL, so a later
  // cancel takes the release branch and never puts them back. The latch STAYS
  // NULL — restockInventoryForOrder returns every line, so writing it would
  // invent units for the lines that never moved, and this codebase's rule is
  // that under-restock is recoverable and over-restock oversells. What was
  // missing is that anyone was told WHICH failure it was.
  it("names a PARTIAL decrement separately, so the lost units can be corrected by hand", async () => {
    const reservation = await import("@/lib/inventory-reservation");
    const fulfillment = await import("@/lib/inventory-fulfillment");
    vi.mocked(reservation.finalizeInventoryForOrder).mockResolvedValueOnce({ finalized: 0, degraded: true, finalizedLines: null });
    vi.mocked(fulfillment.decrementInventoryForOrder).mockResolvedValueOnce({
      attempted: 3,
      failed: 1,
      errors: ["p3: adjust_inventory_on_sale unavailable"],
    });

    await expect(approveManualPayment()).resolves.toBeTruthy();

    expect(db.order.paid_side_effects_at).toBeNull();
    const types = db.alerts.map((a) => a.type);
    expect(types).toContain("unsafe_effect_failed_inventory_decrement");
    expect(types).toContain("inventory_partially_decremented");
    const partial = db.alerts.find((a) => a.type === "inventory_partially_decremented")!;
    expect(partial.message).toContain("2 of 3");
    expect(partial.message).toContain("will NOT put them back");
  });

  it("does NOT raise the partial alert when nothing moved at all", async () => {
    const reservation = await import("@/lib/inventory-reservation");
    const fulfillment = await import("@/lib/inventory-fulfillment");
    vi.mocked(reservation.finalizeInventoryForOrder).mockResolvedValueOnce({ finalized: 0, degraded: true, finalizedLines: null });
    vi.mocked(fulfillment.decrementInventoryForOrder).mockResolvedValueOnce({
      attempted: 3,
      failed: 3,
      errors: ["p1: down", "p2: down", "p3: down"],
    });

    await expect(approveManualPayment()).resolves.toBeTruthy();

    expect(db.alerts.map((a) => a.type)).not.toContain("inventory_partially_decremented");
  });

  it("still RELEASES rather than restocks an order that was never paid", async () => {
    // The phantom-stock guard. An unpaid order's units were never decremented,
    // so restocking would INVENT three units and oversell them.
    const outcome = await cancel();

    expect(outcome.action).toBe("released");
    expect(db.released).toEqual([ORDER_ID]);
    expect(db.restocked).toHaveLength(0);
  });

  it("returns the units exactly once across two cancels", async () => {
    await approveManualPayment();

    const first = await cancel();
    const second = await cancel();

    expect(first.action).toBe("restocked");
    expect(second.action).toBe("already_returned");
    expect(db.restocked).toHaveLength(1);
  });
});

describe("when the restock-claim column is missing, as it is in production", () => {
  it("does NOT report a silent no-op as 'already returned'", async () => {
    await approveManualPayment();
    db.restockClaimColumnExists = false;

    const outcome = await cancel();

    // "already_returned" would be a lie: nothing returned them, and nothing
    // ever will. The units are gone and the operator has to be told.
    expect(outcome.action).not.toBe("already_returned");
    expect(db.restocked).toHaveLength(0);
    expect(db.alerts.map((a) => a.type)).toContain("cancellation_inventory_unresolved");
  });
});
