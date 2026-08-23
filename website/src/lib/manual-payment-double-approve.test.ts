import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// TWO ADMINS CLICKING "APPROVE" IS STILL ONE PAYMENT.
//
// finalizeManualPayment runs everything a paid order triggers: points awarded,
// ambassador commission created, coupon marked redeemed, confirmation email
// sent, inventory decremented, Shippo sync scheduled. Running it twice for one
// payment awards all of it twice.
//
// The guard is optimistic concurrency: the UPDATE that flips the order to paid
// carries `.eq("payment_status", <the status we just read>)`. A second approve
// -- a double-click, a second admin, a retried request -- updates ZERO rows
// and returns alreadyPaid instead of running the side effects again.
//
// WHY THIS FILE EXISTS
//
// Deleting that precondition left all 2,690 existing tests green. So did
// deleting the paid-flip's own `.neq("payment_status", "paid")`. Nothing
// proved that a second approve is inert.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-manual-0001";

const state: {
  paymentStatus: string;
  updateFilters: Array<Array<[string, unknown]>>;
  updatesApplied: number;
  paymentMethod: string;
} = { paymentStatus: "awaiting_verification", updateFilters: [], updatesApplied: 0, paymentMethod: "zelle" };

const sideEffects = {
  points: vi.fn(async () => {}),
  coupon: vi.fn(async () => ({ ok: true })),
  email: vi.fn(async () => ({ ok: true })),
  inventory: vi.fn(async () => {}),
  commission: vi.fn(async () => ({ percent: 15, tierName: null })),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));

vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 100,
  getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: sideEffects.points,
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: sideEffects.coupon }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sideEffects.email }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "s", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "s", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: sideEffects.inventory,
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ ok: false })),
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: sideEffects.commission,
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
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({}) }));
vi.mock("@/lib/ambassador-settings", () => ({ getAmbassadorProgramSettings: async () => ({ enabled: false }) }));
vi.mock("@/lib/admin-control", () => ({ getReferralProgramConfig: async () => ({ enabled: false }) }));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: async () => 0 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                order_id: ORDER_ID,
                order_number: "VL-MANUAL1",
                payment_status: state.paymentStatus,
                payment_method: state.paymentMethod,
                order_type: "product",
                customer_email: "buyer@example.test",
                customer_name: "A Buyer",
                customer_user_id: "user-1",
                coupon_code: "SAVE10",
                subtotal: 200,
                discount_amount: 0,
                amount_paid: 200,
                currency: "USD",
                order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1 }],
              },
              error: null,
            }),
          }),
        }),
        update: () => {
          const filters: Array<[string, unknown]> = [];
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            neq(column: string, value: unknown) {
              filters.push([`neq:${column}`, value]);
              return builder;
            },
            async select() {
              state.updateFilters.push(filters);
              // Models the real conditional UPDATE: it matches only while the
              // row still holds the status the caller read.
              const guard = filters.find(([c]) => c === "payment_status");
              const matches = !guard || guard[1] === state.paymentStatus;
              if (!matches) return { data: [], error: null };
              state.paymentStatus = "paid";
              state.updatesApplied += 1;
              return { data: [{ id: "row-1" }], error: null };
            },
          };
          return builder;
        },
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

async function approve() {
  const { finalizeManualPayment } = await import("@/lib/payment-webhook");
  return finalizeManualPayment(ORDER_ID, { verifiedBy: "owner" });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paymentStatus = "awaiting_verification";
  state.updateFilters = [];
  state.updatesApplied = 0;
  state.paymentMethod = "zelle";
});

describe("approving a manual payment twice", () => {
  it("pays the order on the first approve", async () => {
    const result = await approve();
    expect(result.alreadyPaid).toBeFalsy();
    expect(state.updatesApplied).toBe(1);
  });

  it("claims the order conditionally on the status it just read", async () => {
    await approve();
    // Without this precondition the update is not atomic and a concurrent
    // approve also 'succeeds', running every side effect a second time.
    const filters = state.updateFilters[0] ?? [];
    expect(filters).toContainEqual(["payment_status", "awaiting_verification"]);
  });

  it("REFUSES the second approve without re-running side effects", async () => {
    await approve();
    const pointsAfterFirst = sideEffects.points.mock.calls.length;
    const couponAfterFirst = sideEffects.coupon.mock.calls.length;
    const emailAfterFirst = sideEffects.email.mock.calls.length;

    const second = await approve();

    expect(second.alreadyPaid).toBe(true);
    expect(state.updatesApplied).toBe(1);
    expect(sideEffects.points.mock.calls.length).toBe(pointsAfterFirst);
    expect(sideEffects.coupon.mock.calls.length).toBe(couponAfterFirst);
    expect(sideEffects.email.mock.calls.length).toBe(emailAfterFirst);
  });

  it("flips the order exactly once across three racing approvals", async () => {
    await Promise.all([approve(), approve(), approve()]);
    expect(state.updatesApplied).toBe(1);
  });

  it("awards the side effects ONCE when three approvals race", async () => {
    // The real race: all three read "awaiting_verification" before any of them
    // writes, so all three pass the already-paid short-circuit and reach the
    // conditional claim. Only the winner may award points, redeem the coupon
    // and email the customer -- the losers must see zero updated rows and
    // stop. Asserting only that the STATUS flipped once would not catch a
    // loser that carried on past a failed claim.
    const results = await Promise.all([approve(), approve(), approve()]);

    // Two of the three must be refused outright...
    expect(results.filter((r) => r.alreadyPaid).length).toBe(2);
    // ...and each side effect must have run exactly once for one payment.
    expect(sideEffects.email).toHaveBeenCalledTimes(1);
    expect(sideEffects.points).toHaveBeenCalledTimes(1);
    expect(sideEffects.coupon).toHaveBeenCalledTimes(1);
  });
});

describe("orders that must never be approved through this path", () => {
  for (const status of ["refunded", "partially_refunded", "canceled"]) {
    it(`refuses a ${status} order rather than re-awarding everything`, async () => {
      state.paymentStatus = status;
      await expect(approve()).rejects.toThrow(/Cannot approve/i);
      expect(state.updatesApplied).toBe(0);
      expect(sideEffects.points).not.toHaveBeenCalled();
      expect(sideEffects.coupon).not.toHaveBeenCalled();
    });
  }

  for (const method of ["card", ""]) {
    it(`refuses a ${method || "(blank)"}-method order — the real webhook will pay it`, async () => {
      // Approving a card order here would award everything a second time when
      // the genuine card webhook also fires.
      state.paymentMethod = method;
      await expect(approve()).rejects.toThrow(/not a manual payment order/i);
      expect(state.updatesApplied).toBe(0);
      expect(sideEffects.email).not.toHaveBeenCalled();
    });
  }

  it("reports an already-paid order as paid without touching anything", async () => {
    state.paymentStatus = "paid";
    const result = await approve();
    expect(result.alreadyPaid).toBe(true);
    expect(state.updatesApplied).toBe(0);
    expect(sideEffects.points).not.toHaveBeenCalled();
  });
});
