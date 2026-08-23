import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// STOCK LEAVES THE SHELF EXACTLY ONCE PER PAID ORDER.
//
// Checkout places a temporary HOLD. When payment succeeds the hold is
// FINALIZED into a permanent deduction. But a hold may not exist -- an
// untracked item, an expired hold, a pre-migration order, or an environment
// where the reserve_inventory RPC is absent (the reservation deliberately
// fails OPEN, since it is a guard and not a gate). For those the webhook
// falls back to the legacy atomic decrement.
//
// The seam is one condition: `if (fin.degraded || fin.finalized === 0)`.
// Both ways of breaking it are silent and expensive:
//   - never falling back  -> stock never leaves; the shelf empties while the
//                            system still offers the item for sale
//   - always falling back -> stock leaves TWICE per order; inventory halves
//
// WHY THIS FILE EXISTS
//
// Forcing that condition to false AND forcing it to true EACH left all 2,711
// existing tests green. Nothing connected the two sides of this handoff.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-stock-0001";

const state: {
  paymentStatus: string;
  fulfillmentStatus: string;
  events: Map<string, { processed_at: string | null; claimed_at: string }>;
  flipFilters: Array<Array<[string, unknown]>>;
  flipsApplied: number;
  signatureValid: boolean;
  sideEffectsClaimedAt: string | null;
} = {
  paymentStatus: "pending_payment",
  fulfillmentStatus: "pending",
  events: new Map(),
  flipFilters: [],
  flipsApplied: 0,
  signatureValid: true,
  sideEffectsClaimedAt: null,
};

const { legacyDecrement, holder } = vi.hoisted(() => ({
  legacyDecrement: vi.fn(async () => {}),
  holder: {} as { finalizeResult: { ok: boolean; degraded: boolean; finalized: number } },
}));

const sideEffects = {
  email: vi.fn(async () => ({ ok: true })),
  points: vi.fn(async () => {}),
  coupon: vi.fn(async () => ({ ok: true })),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({
    verifyWebhookSignature: () => state.signatureValid,
  }),
}));
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
  decrementInventoryForOrder: legacyDecrement,
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: async () => holder.finalizeResult,
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 15, tierName: null })),
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
vi.mock("@/lib/ambassador-settings", () => ({ getAmbassadorProgramSettings: async () => ({ enabled: false }) }));
vi.mock("@/lib/admin-control", () => ({ getReferralProgramConfig: async () => ({ enabled: false }) }));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: async () => 0 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/supabase-server", () => {
  const orderRow = () => ({
    order_id: ORDER_ID,
    order_number: "VL-CARD001",
    payment_status: state.paymentStatus,
    fulfillment_status: state.fulfillmentStatus,
    payment_method: "card",
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
  });

  const from = (table: string) => {
    if (table === "payment_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const id = String(row.event_id);
          if (state.events.has(id)) {
            return { error: { code: "23505", message: "duplicate key" } };
          }
          state.events.set(id, { processed_at: null, claimed_at: String(row.claimed_at) });
          return { error: null };
        },
        upsert: async () => ({ error: null }),
        select: () => {
          let id = "";
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            async maybeSingle() { return { data: state.events.get(id) ?? null, error: null }; },
          };
          return b;
        },
        update: () => {
          let id = "";
          let requiresUnprocessed = false;
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            is(_c: string, v: unknown) { requiresUnprocessed = v === null; return b; },
            lt() { return b; },
            async select() {
              const row = state.events.get(id);
              if (!row) return { data: [], error: null };
              if (requiresUnprocessed && row.processed_at !== null) return { data: [], error: null };
              return { data: [{ event_id: id }], error: null };
            },
          };
          return b;
        },
        delete: () => ({ eq: async (_c: string, v: string) => { state.events.delete(v); return { error: null }; } }),
      };
    }

    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            limit() { return b; },
            async maybeSingle() { return { data: orderRow(), error: null }; },
            order() { return b; },
          };
          return b;
        },
        update: () => {
          const filters: Array<[string, unknown]> = [];
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push([c, v]); return b; },
            neq(c: string, v: unknown) { filters.push([`neq:${c}`, v]); return b; },
            is(c: string, v: unknown) { filters.push([`is:${c}`, v]); return b; },
            select() { return b; },
            then(resolve: (value: { data: unknown; error: null }) => unknown) {
              return Promise.resolve(settle()).then(resolve);
            },
          };
          function settle() {
            state.flipFilters.push(filters);

            // The side-effects claim: succeeds only while the column is NULL.
            const claimsSideEffects = filters.some(([c]) => c === "is:paid_side_effects_at");
            if (claimsSideEffects) {
              if (state.sideEffectsClaimedAt !== null) return { data: [], error: null };
              state.sideEffectsClaimedAt = new Date().toISOString();
              return { data: [{ id: "row-1" }], error: null };
            }

            // The atomic paid-flip: matches only while the order is NOT paid.
            const notPaid = filters.find(([c]) => c === "neq:payment_status");
            if (notPaid) {
              if (state.paymentStatus === notPaid[1]) return { data: [], error: null };
              state.paymentStatus = "paid";
              state.flipsApplied += 1;
              return { data: [{ id: "row-1" }], error: null };
            }
            return { data: [{ id: "row-1" }], error: null };
          }
          return b;
        },
      };
    }

    const noop: Record<string, unknown> = {
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
    return noop;
  };
  return { supabaseAdmin: { from } };
});

function successPayload() {
  return JSON.stringify({
    type: "payment.succeeded",
    data: { object: { metadata: { order_id: ORDER_ID }, amount: 200 } },
  });
}

async function deliver(eventId: string, payload = successPayload()) {
  const { processPaymentWebhook } = await import("@/lib/payment-webhook");
  return processPaymentWebhook(payload, "sig", "secret", eventId);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paymentStatus = "pending_payment";
  state.fulfillmentStatus = "pending";
  state.events = new Map();
  state.flipFilters = [];
  state.flipsApplied = 0;
  state.signatureValid = true;
  state.sideEffectsClaimedAt = null;
  holder.finalizeResult = { ok: true, degraded: false, finalized: 1 };
  legacyDecrement.mockClear();
});

describe("a hold that finalized normally", () => {
  it("deducts stock ONCE and does not also run the legacy decrement", async () => {
    holder.finalizeResult = { ok: true, degraded: false, finalized: 1 };
    await deliver("evt-1");
    expect(legacyDecrement).not.toHaveBeenCalled();
  });
});

describe("when there is no hold to finalize", () => {
  it("falls back to the legacy decrement when nothing was finalized", async () => {
    // Untracked item, expired hold, or a pre-migration order.
    holder.finalizeResult = { ok: true, degraded: false, finalized: 0 };
    await deliver("evt-1");
    expect(legacyDecrement).toHaveBeenCalledTimes(1);
  });

  it("falls back when the reservation system is degraded", async () => {
    // reserve_inventory is absent or erroring. The reservation failed open, so
    // the atomic decrement is the only thing left that moves stock. If this
    // link breaks, the shelf empties silently while the store keeps selling.
    holder.finalizeResult = { ok: true, degraded: true, finalized: 0 };
    await deliver("evt-1");
    expect(legacyDecrement).toHaveBeenCalledTimes(1);
  });

  it("falls back when degraded even though some lines finalized", async () => {
    holder.finalizeResult = { ok: true, degraded: true, finalized: 1 };
    await deliver("evt-1");
    expect(legacyDecrement).toHaveBeenCalledTimes(1);
  });
});

describe("a duplicate delivery", () => {
  it("does not deduct stock a second time", async () => {
    holder.finalizeResult = { ok: true, degraded: false, finalized: 0 };
    await deliver("evt-1");
    expect(legacyDecrement).toHaveBeenCalledTimes(1);
    await deliver("evt-1");
    expect(legacyDecrement).toHaveBeenCalledTimes(1);
  });

  it("does not deduct stock again for a SECOND, DIFFERENT success event", async () => {
    holder.finalizeResult = { ok: true, degraded: false, finalized: 0 };
    await deliver("evt-1");
    await deliver("evt-2");
    expect(legacyDecrement).toHaveBeenCalledTimes(1);
  });
});
