import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE CARD PAYMENT IS ONE SALE, HOWEVER MANY TIMES THE PROCESSOR TELLS US.
//
// Payment processors retry. Veyra may deliver the same success event several
// times, and may deliver a SECOND, distinct success event for the same order.
// Each delivery that reaches the paid side-effects awards points, creates
// commission, redeems the coupon, emails the customer and decrements stock
// again -- for one charge.
//
// Three separate guards stand in the way, and this file proves each:
//
//   1. SIGNATURE       -- an unsigned caller cannot inject a payment at all.
//   2. EVENT CLAIM     -- payment_events' primary key means one delivery of a
//                         given event_id does the work; the rest return
//                         duplicate.
//   3. ATOMIC PAID-FLIP -- `.neq("payment_status", "paid")` means a SECOND,
//                         DIFFERENT event (which the claim cannot catch, since
//                         its event_id is new) updates zero rows. This also
//                         stops a late duplicate from reverting an order that
//                         has already shipped.
//
// WHY THIS FILE EXISTS
//
// Deleting the paid-flip guard, and deleting the stale-claim NULL condition,
// EACH left all 2,701 existing tests green.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-card-0001";

const state: {
  paymentStatus: string;
  fulfillmentStatus: string;
  events: Map<string, { processed_at: string | null; claimed_at: string }>;
  flipFilters: Array<Array<[string, unknown]>>;
  flipsApplied: number;
  signatureValid: boolean;
  sideEffectsClaimedAt: string | null;
  orderType: string;
} = {
  paymentStatus: "pending_payment",
  fulfillmentStatus: "pending",
  events: new Map(),
  flipFilters: [],
  flipsApplied: 0,
  signatureValid: true,
  sideEffectsClaimedAt: null,
  orderType: "product",
};

const sideEffects = {
  email: vi.fn(async () => ({ ok: true })),
  points: vi.fn(async () => {}),
  coupon: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  storeCredit: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  revokeMembership: vi.fn(async () => {}),
  alert: vi.fn(async (_alert: { type: string; severity: string; message: string; context?: unknown }) => {}),
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
  redeemPoints: sideEffects.redeemPoints,
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
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })),
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ ok: false })),
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 15, tierName: null })),
  detectCommissionFraudSignal: vi.fn(async () => ({ flagged: false, reason: null })),
}));
vi.mock("@/lib/shippo/order-sync", () => ({ syncOrderToShippo: vi.fn(async () => {}) }));
vi.mock("@/lib/store-credit", () => ({
  redeemStoreCredit: sideEffects.storeCredit,
  refundStoreCreditForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/membership-billing", () => ({
  activatePaidMembership: vi.fn(async () => {}),
  revokeMembershipForRefund: sideEffects.revokeMembership,
}));
vi.mock("@/lib/cart-recovery", () => ({ markAbandonedCartsRecovered: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: sideEffects.alert }));
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
    order_type: state.orderType,
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    customer_user_id: "user-1",
    coupon_code: "SAVE10",
    // The order redeems store credit AND loyalty points as well as a coupon,
    // so every redemption path below is actually exercised rather than skipped.
    store_credit_redeemed_cents: 500,
    points_redeemed: 100,
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

function refundPayload() {
  return JSON.stringify({
    type: "refund.completed",
    data: { object: { metadata: { order_id: ORDER_ID }, amount: 200 } },
  });
}

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
  state.orderType = "product";
});

describe("an unsigned delivery is not a payment", () => {
  it("refuses an invalid signature and touches nothing", async () => {
    state.signatureValid = false;
    await expect(deliver("evt-1")).rejects.toThrow(/signature/i);
    expect(state.flipsApplied).toBe(0);
    expect(sideEffects.email).not.toHaveBeenCalled();
    expect(state.events.size).toBe(0);
  });
});

describe("the same event delivered repeatedly", () => {
  it("pays the order on the first delivery", async () => {
    const result = await deliver("evt-1");
    expect(result.duplicate).toBe(false);
    expect(state.flipsApplied).toBe(1);
  });

  it("reports later deliveries of the SAME event id as duplicates", async () => {
    await deliver("evt-1");
    const second = await deliver("evt-1");
    const third = await deliver("evt-1");
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(state.flipsApplied).toBe(1);
  });

  it("does not email the customer twice for one charge", async () => {
    await deliver("evt-1");
    const afterFirst = sideEffects.email.mock.calls.length;
    await deliver("evt-1");
    expect(sideEffects.email.mock.calls.length).toBe(afterFirst);
  });

  it("claims once when three identical deliveries race", async () => {
    await Promise.all([deliver("evt-1"), deliver("evt-1"), deliver("evt-1")]);
    expect(state.flipsApplied).toBe(1);
    expect(sideEffects.email).toHaveBeenCalledTimes(1);
  });
});

describe("an old claim row that is already processed", () => {
  it("is never reprocessed, however long ago it was claimed", async () => {
    // A claim old enough to look stranded is normally RETAKEN so a crashed
    // delivery can finish. But one that already completed must stay done --
    // otherwise every sufficiently old event replays its payment.
    const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    state.events.set("evt-old", { processed_at: longAgo, claimed_at: longAgo });
    state.paymentStatus = "paid";

    const result = await deliver("evt-old");

    expect(result.duplicate).toBe(true);
    expect(state.flipsApplied).toBe(0);
    expect(sideEffects.email).not.toHaveBeenCalled();
  });

  it("IS retaken when an old claim never finished, so a crash can recover", async () => {
    const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    state.events.set("evt-stranded", { processed_at: null, claimed_at: longAgo });

    const result = await deliver("evt-stranded");

    // The complement of the test above: unfinished work must still be
    // recoverable, or a crashed delivery strands a real payment forever.
    expect(result.duplicate).toBe(false);
    expect(state.flipsApplied).toBe(1);
  });
});

describe("a SECOND, DIFFERENT success event for the same order", () => {
  it("cannot pay the order twice, even though the event claim does not catch it", async () => {
    await deliver("evt-1");
    const pointsAfterFirst = sideEffects.points.mock.calls.length;
    const emailAfterFirst = sideEffects.email.mock.calls.length;

    // A new event_id: the payment_events primary key is no obstacle. Only the
    // atomic paid-flip stands here.
    const second = await deliver("evt-2");
    expect(second.duplicate).toBe(false); // it IS a new event...
    expect(state.flipsApplied).toBe(1); // ...but it moved no money.
    expect(sideEffects.points.mock.calls.length).toBe(pointsAfterFirst);
    expect(sideEffects.email.mock.calls.length).toBe(emailAfterFirst);
  });

  it("guards the flip on the order not already being paid", async () => {
    await deliver("evt-1");
    const flip = state.flipFilters[0] ?? [];
    // Without this the second event rewrites paid_at and fulfillment_status,
    // reverting an order that may already be shipped.
    expect(flip).toContainEqual(["neq:payment_status", "paid"]);
  });

  it("does not revert an order that has already shipped", async () => {
    await deliver("evt-1");
    state.fulfillmentStatus = "shipped";
    await deliver("evt-2");
    // The late duplicate updated zero rows, so shipped survives.
    expect(state.fulfillmentStatus).toBe("shipped");
    expect(state.flipsApplied).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The coupon was the one side-effect this file mocked but never asserted on.
// redeemCoupon increments redemptions_count, so a second redemption burns a use
// of a limited code for one charge — and a one-time code becomes unusable for
// the customer who was actually given it. The order above carries SAVE10, so
// the coverage cost nothing but the assertions.
// ---------------------------------------------------------------------------
describe("one charge burns one coupon redemption", () => {
  it("redeems the code once on the first delivery", async () => {
    await deliver("evt-1");
    expect(sideEffects.coupon).toHaveBeenCalledTimes(1);
    expect(sideEffects.coupon).toHaveBeenCalledWith("SAVE10");
  });

  it("a redelivery of the same event does not redeem again", async () => {
    await deliver("evt-1");
    await deliver("evt-1");
    expect(sideEffects.coupon).toHaveBeenCalledTimes(1);
  });

  it("nor does a second, DIFFERENT success event for the same order", async () => {
    await deliver("evt-1");
    await deliver("evt-2");
    expect(sideEffects.coupon).toHaveBeenCalledTimes(1);
  });

  it("three racing deliveries still burn exactly one", async () => {
    await Promise.all([deliver("evt-1"), deliver("evt-1"), deliver("evt-1")]);
    expect(sideEffects.coupon).toHaveBeenCalledTimes(1);
  });

  it("an unsigned delivery burns nothing", async () => {
    state.signatureValid = false;
    await expect(deliver("evt-1")).rejects.toThrow(/signature/i);
    expect(sideEffects.coupon).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A FAILED NON-IDEMPOTENT EFFECT MUST RAISE ITS OWN ALERT.
//
// The five effects that cannot be auto-repaired are escalated to a durable
// system alert instead of a console line. Until now that wiring was carried
// entirely by a comment: no test drove a THROWING effect through the webhook,
// so deleting a catch block, or mislabelling one effect as another, was
// invisible. The alert type is what an operator triages by.
// ---------------------------------------------------------------------------
describe("an unsafe effect that throws", () => {
  it("raises unsafe_effect_failed_coupon_redemption when redeemCoupon throws", async () => {
    sideEffects.coupon.mockRejectedValueOnce(new Error("coupon service down"));

    const result = await deliver("evt-1");

    // The payment itself still lands — one broken side-effect must never undo
    // a charge the processor has already taken.
    expect(result.duplicate).toBe(false);
    expect(state.flipsApplied).toBe(1);

    const alerts = sideEffects.alert.mock.calls.map((call) => call[0]);
    const coupon = alerts.find((alert) => alert.type === "unsafe_effect_failed_coupon_redemption");
    expect(coupon).toBeDefined();
    expect(coupon!.severity).toBe("critical");
    expect(coupon!.message).toContain(ORDER_ID);
  });

  it("does not mislabel a store-credit redemption failure as a points-earn failure", async () => {
    // These fail in OPPOSITE money directions: a points-earn failure owes the
    // customer, a redemption failure means the customer kept the credit AND
    // got the discount. Sharing one try/catch sent an operator to the wrong
    // repair.
    sideEffects.storeCredit.mockRejectedValueOnce(new Error("credit ledger down"));

    await deliver("evt-1");

    const types = sideEffects.alert.mock.calls.map((call) => call[0].type);
    expect(types).toContain("unsafe_effect_failed_store_credit_redemption");
    expect(types).not.toContain("unsafe_effect_failed_points_earn");
  });
});

// ---------------------------------------------------------------------------
// TWO MORE EFFECTS THAT FAIL IN THEIR OWN DIRECTION.
//
// The rule this file already proves for store credit — ONE EFFECT, ONE ALERT
// TYPE — was only half-applied. A points REDEMPTION shared a try/catch with the
// points EARN and surfaced as `points_earn`; the membership revoke on a refund
// had a brand-new alert call that nothing drove, so deleting it left every test
// green. Both are wired here through the real webhook.
// ---------------------------------------------------------------------------
describe("a points redemption that throws", () => {
  it("is not reported as a points-earn failure", async () => {
    // Opposite directions: a failed redemption means the customer kept the
    // points AND took the discount (the store is short); a failed earn means
    // the customer is owed.
    sideEffects.redeemPoints.mockRejectedValueOnce(new Error("points ledger down"));

    await deliver("evt-1");

    const types = sideEffects.alert.mock.calls.map((call) => call[0].type);
    expect(types).toContain("unsafe_effect_failed_points_redemption");
    expect(types).not.toContain("unsafe_effect_failed_points_earn");
  });

  it("does not cancel the points the customer earned on the same order", async () => {
    sideEffects.redeemPoints.mockRejectedValueOnce(new Error("points ledger down"));

    await deliver("evt-1");

    // The earn ran in its own try, so one failure did not swallow the other.
    expect(sideEffects.points).toHaveBeenCalled();
  });
});

describe("a membership revoke that throws on a refund", () => {
  it("raises unsafe_effect_failed_membership_revoke", async () => {
    // A refunded membership whose revoke fails leaves the customer with member
    // pricing, free shipping and points multipliers indefinitely. This is not
    // auto-repairable — ending a subscription is not replayable — so the alert
    // IS the recovery path.
    state.orderType = "membership";
    sideEffects.revokeMembership.mockRejectedValueOnce(new Error("billing provider down"));

    await deliver("evt-refund-1", refundPayload());

    expect(sideEffects.revokeMembership).toHaveBeenCalledWith("user-1");
    const alerts = sideEffects.alert.mock.calls.map((call) => call[0]);
    const revoke = alerts.find((alert) => alert.type === "unsafe_effect_failed_membership_revoke");
    expect(revoke).toBeDefined();
    expect(revoke!.severity).toBe("critical");
    expect(revoke!.message).toContain(ORDER_ID);
  });

  it("raises nothing when the revoke succeeds", async () => {
    state.orderType = "membership";

    await deliver("evt-refund-2", refundPayload());

    const types = sideEffects.alert.mock.calls.map((call) => call[0].type);
    expect(types).not.toContain("unsafe_effect_failed_membership_revoke");
  });
});

// ---------------------------------------------------------------------------
// THE FAILURE ARRIVES AS A RETURN VALUE, NOT AN EXCEPTION — FIX WAVE 3.
//
// supabase-js RESOLVES on error; it does not reject. redeemCoupon,
// finalizeInventoryForOrder and decrementInventoryForOrder were all total
// functions built on it — every branch ended in `console.error(...); return`.
// So four of the eight new unsafeEffectAlert sites were unreachable code, and
// the only tests that drove them made the callee THROW, which the real callee
// never does. The block above proves the throwing path; this one proves the
// path that actually happens.
// ---------------------------------------------------------------------------
describe("an unsafe effect that REPORTS its failure instead of throwing", () => {
  it("raises unsafe_effect_failed_coupon_redemption when redeemCoupon reports failure", async () => {
    sideEffects.coupon.mockResolvedValueOnce({ ok: false, error: "coupon rpc unavailable" });

    const result = await deliver("evt-1");

    expect(result.duplicate).toBe(false);
    const alerts = sideEffects.alert.mock.calls.map((call) => call[0]);
    const coupon = alerts.find((alert) => alert.type === "unsafe_effect_failed_coupon_redemption");
    expect(coupon).toBeDefined();
    expect(coupon!.severity).toBe("critical");
    expect(String((coupon!.context as { error?: string }).error)).toContain("coupon rpc unavailable");
  });

  it("raises nothing when the redemption is recorded", async () => {
    await deliver("evt-1");
    const types = sideEffects.alert.mock.calls.map((call) => call[0].type);
    expect(types).not.toContain("unsafe_effect_failed_coupon_redemption");
  });

  it("raises unsafe_effect_failed_inventory_decrement when the fallback decrement fails on every line", async () => {
    const reservation = await import("@/lib/inventory-reservation");
    const fulfillment = await import("@/lib/inventory-fulfillment");
    // The reachable failure: the reservation RPC is unavailable (returned, not
    // thrown), and the legacy decrement then errors on each line (logged, not
    // thrown). Nothing propagated, so nothing alerted.
    vi.mocked(reservation.finalizeInventoryForOrder).mockResolvedValueOnce({ finalized: 0, degraded: true });
    vi.mocked(fulfillment.decrementInventoryForOrder).mockResolvedValueOnce({
      attempted: 2,
      failed: 2,
      errors: ["p1: rpc down", "p2: rpc down"],
    });

    await deliver("evt-1");

    const types = sideEffects.alert.mock.calls.map((call) => call[0].type);
    expect(types).toContain("unsafe_effect_failed_inventory_decrement");
  });

  it("raises nothing when the fallback decrement moves the stock", async () => {
    const reservation = await import("@/lib/inventory-reservation");
    vi.mocked(reservation.finalizeInventoryForOrder).mockResolvedValueOnce({ finalized: 0, degraded: true });

    await deliver("evt-1");

    const types = sideEffects.alert.mock.calls.map((call) => call[0].type);
    expect(types).not.toContain("unsafe_effect_failed_inventory_decrement");
  });
});
