import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// REVIEW FINDING 1 (P0) — A FAILED ACCRUAL IS MONEY OWED TO A REAL PERSON.
//
// Both paid lanes take an exactly-once claim and THEN accrue the commission:
//
//   card path      orders.paid_side_effects_at  NULL -> now, then accrue
//   manual path    orders.payment_status        <read> -> paid, then accrue
//
// Once that claim is consumed the accrual gets exactly one attempt. The card
// path swallowed its failure into a console.error; the manual path let it
// throw, and the admin's retry then lost the claim and returned alreadyPaid.
// Either way the ambassador earned nothing, permanently, with no repair path.
//
// THIS IS NOT HYPOTHETICAL. Checked against the live production database on
// 2026-08-26:
//
//   referral_orders_payment_status_check
//     CHECK (payment_status = ANY (ARRAY['paid','refunded','partially_refunded']))
//
// The accrual inserts payment_status 'pending'. On production TODAY that is a
// 23514, on every single referred order, until
// sql/referral-orders-commission-lifecycle.sql is applied.
//
// WHY THE EXISTING SUITES COULD NOT SEE THIS. Every accrual double accepts any
// insert, so 'pending' always lands and the failure branch is unreachable. The
// double below models the REAL production constraint verbatim, and can be told
// to "apply the migration" mid-test — which is the actual deployment sequence
// this has to survive.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-accrual-0001";
const AMBASSADOR_ID = "amb-0001";

/** Verbatim from production. `pending` is NOT in it — that is the whole point. */
const LEGACY_PAYMENT_STATUSES = new Set(["paid", "refunded", "partially_refunded"]);

interface ReferralOrderRow {
  id: string;
  order_id: string;
  payment_status: string;
  commission_amount: number;
  [key: string]: unknown;
}

const db: {
  /** false = production as it stands today; true = migration applied. */
  lifecycleMigrationApplied: boolean;
  orderStatus: string;
  paidSideEffectsAt: string | null;
  referralOrders: Map<string, ReferralOrderRow>;
  commissions: Map<string, Record<string, unknown>>;
  insertAttempts: number;
} = {
  lifecycleMigrationApplied: false,
  orderStatus: "awaiting_verification",
  paidSideEffectsAt: null,
  referralOrders: new Map(),
  commissions: new Map(),
  insertAttempts: 0,
};

const sideEffects = {
  finalizeInventory: vi.fn(async () => ({ finalized: 1, degraded: false })),
  decrementInventory: vi.fn(async () => {}),
  redeemCoupon: vi.fn(async () => ({ ok: true })),
  recordPoints: vi.fn(async () => {}),
  alert: vi.fn(async () => {}),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));

vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 100,
  getActivePointsMultiplier: async () => ({ multiplier: 1 }),
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: sideEffects.recordPoints,
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: sideEffects.redeemCoupon }));
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
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: sideEffects.decrementInventory,
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: sideEffects.finalizeInventory,
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 15, tierName: "base" })),
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
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: sideEffects.alert }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({}) }));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({ enabled: true, minimumQualifyingOrder: 0, commissionHoldDays: 14 }),
}));
vi.mock("@/lib/admin-control", () => ({
  getReferralProgramConfig: async () => ({
    enabled: true, commissionsPaused: false, defaultCommissionPercent: 15,
    discountPercent: 10, personalDiscountPercent: 10,
  }),
}));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: () => 10 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/analytics-events", () => ({ logCommerceAnalyticsEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

const ORDER_ROW = () => ({
  id: "row-order-1",
  order_id: ORDER_ID,
  order_number: "VL-ACC1",
  payment_status: db.orderStatus,
  paid_side_effects_at: db.paidSideEffectsAt,
  payment_method: "zelle",
  order_type: "product",
  customer_email: "buyer@example.test",
  customer_name: "A Buyer",
  customer_user_id: null,
  coupon_code: null,
  ambassador_id: AMBASSADOR_ID,
  referral_code: "ELIJAH15",
  subtotal: 200,
  discount_amount: 20,
  amount_paid: 180,
  tax_amount: 0,
  shipping_amount: 0,
  card_processing_fee: 0,
  shipping_address: "1 Test St",
  city: "Testville",
  postal_code: "00000",
  paid_at: db.orderStatus === "paid" ? "2026-08-26T00:00:00.000Z" : null,
  currency: "USD",
  order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1, line_total: 200 }],
});

/**
 * The referral_orders CHECK, as production actually holds it.
 *
 * Returns the PostgREST-shaped error supabase-js would hand back, so the code
 * under test sees exactly what it sees in production.
 */
function checkPaymentStatus(status: string): { code: string; message: string } | null {
  if (db.lifecycleMigrationApplied) return null;
  if (LEGACY_PAYMENT_STATUSES.has(status)) return null;
  return {
    code: "23514",
    message: `new row for relation "referral_orders" violates check constraint "referral_orders_payment_status_check"`,
  };
}

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => {
          const filters: Array<[string, unknown]> = [];
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
            not() { return builder; },
            gte() { return builder; },
            order() { return builder; },
            limit: async () => {
              // The repair sweep's scan: paid orders carrying an ambassador.
              const row = ORDER_ROW();
              const paid = filters.some(([c, v]) => c === "payment_status" && v === "paid");
              return { data: paid && db.orderStatus === "paid" ? [row] : [], error: null };
            },
            maybeSingle: async () => ({ data: ORDER_ROW(), error: null }),
          };
          return builder;
        },
        update: (patch: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = [];
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
            is(column: string, value: unknown) { filters.push([`is:${column}`, value]); return builder; },
            async select() {
              const statusGuard = filters.find(([c]) => c === "payment_status");
              if (statusGuard && statusGuard[1] !== db.orderStatus) return { data: [], error: null };
              const seGuard = filters.find(([c]) => c === "is:paid_side_effects_at");
              if (seGuard && db.paidSideEffectsAt !== null) return { data: [], error: null };
              if ("payment_status" in patch) db.orderStatus = String(patch.payment_status);
              if ("paid_side_effects_at" in patch) db.paidSideEffectsAt = String(patch.paid_side_effects_at);
              return { data: [{ id: "row-order-1" }], error: null };
            },
            then(resolve: (v: unknown) => unknown) { return Promise.resolve({ error: null }).then(resolve); },
          };
          return builder;
        },
      };
    }

    if (table === "referral_orders") {
      return {
        select: () => {
          const builder: Record<string, unknown> = {
            eq: () => builder,
            in: async () => ({ data: Array.from(db.referralOrders.values()).map((r) => ({ order_id: r.order_id })), error: null }),
            maybeSingle: async () => ({ data: db.referralOrders.get(ORDER_ID) ?? null, error: null }),
          };
          return builder;
        },
        insert: (row: Record<string, unknown>) => {
          db.insertAttempts += 1;
          const violation = checkPaymentStatus(String(row.payment_status));
          const result = violation
            ? { data: null, error: violation }
            : (() => {
              const stored = { ...row, id: `ro-${db.referralOrders.size + 1}` } as ReferralOrderRow;
              db.referralOrders.set(String(row.order_id), stored);
              return { data: { id: stored.id }, error: null };
            })();
          return { select: () => ({ single: async () => result }) };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, value: unknown) => {
            const violation = checkPaymentStatus(String(patch.payment_status ?? "paid"));
            if (violation) return { error: violation };
            const existing = db.referralOrders.get(String(value));
            if (existing) db.referralOrders.set(String(value), { ...existing, ...patch } as ReferralOrderRow);
            return { error: null };
          },
        }),
      };
    }

    if (table === "commissions") {
      return {
        upsert: async (row: Record<string, unknown>) => {
          db.commissions.set(String(row.order_id), row);
          return { error: null };
        },
      };
    }

    if (table === "ambassadors") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: AMBASSADOR_ID, status: "approved", customer_discount_percent: 10 },
              error: null,
            }),
          }),
        }),
      };
    }

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
  db.lifecycleMigrationApplied = false;
  db.orderStatus = "awaiting_verification";
  db.paidSideEffectsAt = null;
  db.referralOrders.clear();
  db.commissions.clear();
  db.insertAttempts = 0;
});

async function approveManually() {
  const { finalizeManualPayment } = await import("@/lib/payment-webhook");
  return finalizeManualPayment(ORDER_ID, { verifiedBy: "owner" });
}

async function repair() {
  const { repairMissingCommissionAccruals } = await import("@/lib/commission-accrual-repair");
  return repairMissingCommissionAccruals();
}

describe("an accrual that fails against the live constraint", () => {
  it("REPRODUCES the production failure: 'pending' is refused today", async () => {
    // Guards the premise of every other test here. If this ever stops failing,
    // the double has stopped modelling production and the rest is theatre.
    expect(checkPaymentStatus("pending")).toMatchObject({ code: "23514" });
    expect(checkPaymentStatus("approved_for_payout")).toMatchObject({ code: "23514" });
    db.lifecycleMigrationApplied = true;
    expect(checkPaymentStatus("pending")).toBeNull();
  });

  it("still pays the order and still moves the stock when the accrual is refused", async () => {
    const result = await approveManually();

    // The accrual failing is not a reason to leave the order unpaid...
    expect(result.alreadyPaid).toBeFalsy();
    expect(db.orderStatus).toBe("paid");
    // ...nor to skip every side effect that comes after it. Before the fix the
    // throw escaped here and inventory was never finalised: the customer paid,
    // the units stayed on the shelf, and the store oversold them to someone else.
    expect(sideEffects.finalizeInventory).toHaveBeenCalledTimes(1);
  });

  it("does not lose the commission: the repair sweep re-derives it from the order", async () => {
    await approveManually();
    expect(db.referralOrders.size).toBe(0); // refused, as production would

    // The operator applies sql/referral-orders-commission-lifecycle.sql.
    db.lifecycleMigrationApplied = true;

    const outcome = await repair();

    expect(outcome.repaired).toBe(1);
    const accrued = db.referralOrders.get(ORDER_ID);
    expect(accrued).toBeDefined();
    // 15% of (200 - 20). The money is right, not merely present.
    expect(Number(accrued?.commission_amount)).toBeCloseTo(27, 2);
    expect(accrued?.ambassador_id).toBe(AMBASSADOR_ID);
  });

  it("is idempotent: a second sweep does not accrue the same order twice", async () => {
    await approveManually();
    db.lifecycleMigrationApplied = true;

    const first = await repair();
    const second = await repair();

    expect(first.repaired).toBe(1);
    expect(second.repaired).toBe(0);
    expect(db.referralOrders.size).toBe(1);
  });

  it("recovers the card lane too, whose claim is already spent", async () => {
    // The card path consumes paid_side_effects_at and swallows the failure, so
    // no redelivery re-runs it. The order row is still the record of what is owed.
    db.orderStatus = "paid";
    db.paidSideEffectsAt = "2026-08-26T00:00:00.000Z";
    db.lifecycleMigrationApplied = true;

    const outcome = await repair();

    expect(outcome.repaired).toBe(1);
    expect(db.referralOrders.get(ORDER_ID)).toBeDefined();
  });

  it("reports the backlog it could not clear rather than swallowing it", async () => {
    // Migration still unapplied: the sweep cannot fix anything, and that is
    // exactly when somebody needs to be told.
    db.orderStatus = "paid";
    db.paidSideEffectsAt = "2026-08-26T00:00:00.000Z";

    const outcome = await repair();

    expect(outcome.failed).toBe(1);
    expect(outcome.repaired).toBe(0);
    expect(sideEffects.alert).toHaveBeenCalled();
  });
});
