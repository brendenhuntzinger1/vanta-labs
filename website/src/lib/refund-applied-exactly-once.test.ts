import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE REFUND IS ONE REFUND, HOWEVER MANY NAMES IT ARRIVES UNDER.
//
// The refund branch's only replay guard short-circuits on a FULLY terminal
// order, and 'partially_refunded' is excluded on purpose so a later FULL refund
// can still complete the restock and the reversals. That left the partial path
// with no guard at all — and this store's live endpoint produces exactly the
// delivery pattern that exploits it. payment-webhook.ts states it plainly:
// "VeyraGate remaps its internal `charge.*` to `payment.*` for merchants, but a
// subscription that includes '*' surfaces the UNMAPPED internal name — and the
// live endpoint for this store subscribes to both". getOrderStatusForEventType
// maps `refund.completed` AND `charge.refunded` to "refunded", the two
// deliveries carry two envelope ids, so the event claim does not dedupe them.
//
// What that cost, on a genuine $60 refund of a $200 order:
//
//   delivery 1  refund_amount $60   (correct)
//   delivery 2  refund_amount $120  — 67% of the ambassador's commission
//                                     reversed instead of 33%
//   delivery 3  refund_amount $180  — the whole commission reversed
//   delivery 4  status 'refunded'   — the ENTIRE order restocked, every
//                                     redeemed point and all store credit
//                                     returned, the membership revoked, for a
//                                     customer who was refunded $60 and kept
//                                     the goods.
//
// The successful-charge side has had an exactly-once handle since
// paid_side_effects_at. This is that handle for a refund, keyed on the REFUND
// (its object id, or failing that the order + amount + the processor's own
// event timestamp) rather than on the delivery that carried it.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-refund-0001";

const state: {
  paymentStatus: string;
  refundAmount: number;
  events: Map<string, { processed_at: string | null; claimed_at: string }>;
  orderUpdates: Array<Record<string, unknown>>;
} = {
  paymentStatus: "paid",
  refundAmount: 0,
  events: new Map(),
  orderUpdates: [],
};

const sideEffects = {
  restock: vi.fn(async () => {}),
  claimRestock: vi.fn(async () => "claimed" as const),
  reverseCommission: vi.fn(async () => {}),
  reversePoints: vi.fn(async () => {}),
  restorePoints: vi.fn(async () => {}),
  refundCredit: vi.fn(async () => {}),
  revokeMembership: vi.fn(async () => {}),
  email: vi.fn(async () => ({ ok: true })),
  alert: vi.fn(async () => {}),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({ verifyWebhookSignature: () => true }),
}));
vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 100,
  getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: sideEffects.restorePoints,
  reverseOrderPoints: sideEffects.reversePoints,
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sideEffects.email }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "s", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "s", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })),
  restockInventoryForOrder: sideEffects.restock,
  claimInventoryRestock: sideEffects.claimRestock,
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
  redeemStoreCredit: vi.fn(async () => {}),
  refundStoreCreditForOrder: sideEffects.refundCredit,
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
    order_number: "VL-REF001",
    payment_status: state.paymentStatus,
    fulfillment_status: "pending",
    payment_method: "card",
    order_type: "product",
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    customer_user_id: "user-1",
    subtotal: 180,
    discount_amount: 0,
    shipping_amount: 20,
    amount_paid: 200,
    refund_amount: state.refundAmount,
    paid_at: "2026-09-01T00:00:00.000Z",
    // The stock actually moved for this order, which is what makes a FULL
    // reversal eligible to return it.
    inventory_committed_at: "2026-09-01T00:00:05.000Z",
    currency: "USD",
    order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1 }],
  });

  const from = (table: string) => {
    if (table === "payment_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const id = String(row.event_id);
          if (state.events.has(id)) return { error: { code: "23505", message: "duplicate key" } };
          state.events.set(id, { processed_at: null, claimed_at: String(row.claimed_at ?? new Date().toISOString()) });
          return { error: null };
        },
        upsert: async (row: Record<string, unknown>) => {
          const id = String(row.event_id);
          state.events.set(id, {
            processed_at: String(row.processed_at ?? new Date().toISOString()),
            claimed_at: state.events.get(id)?.claimed_at ?? new Date().toISOString(),
          });
          return { error: null };
        },
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

    if (table === "order_items") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return Promise.resolve({ data: [{ product_id: "p1", quantity: 1 }], error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }

    if (table === "orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            limit() { return b; },
            order() { return b; },
            async maybeSingle() { return { data: orderRow(), error: null }; },
          };
          return b;
        },
        update: (patch: Record<string, unknown>) => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            neq() { return b; },
            is() { return b; },
            select() { return b; },
            then(resolve: (value: { data: unknown; error: null }) => unknown) {
              state.orderUpdates.push(patch);
              // The webhook writes the status flip and the refund amount as two
              // separate updates. Apply whichever this one carries.
              if (typeof patch.payment_status === "string") state.paymentStatus = patch.payment_status;
              if (typeof patch.refund_amount === "number") state.refundAmount = patch.refund_amount;
              return Promise.resolve({ data: [{ id: "row-1" }], error: null }).then(resolve);
            },
          };
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

/**
 * The two names one refund arrives under. `created_at` is stamped on the
 * underlying event, so both deliveries carry the same one; the envelope id
 * differs, which is precisely why the event claim does not catch this.
 */
function refundDelivery(opts: {
  type?: string;
  amount: number;
  createdAt?: string;
  objectId?: string;
}) {
  return JSON.stringify({
    type: opts.type ?? "refund.completed",
    amount: opts.amount,
    created_at: opts.createdAt ?? "2026-09-05T10:00:00.000Z",
    data: { object: { metadata: { order_id: ORDER_ID }, ...(opts.objectId ? { id: opts.objectId } : {}) } },
  });
}

async function deliver(eventId: string, payload: string) {
  const { processPaymentWebhook } = await import("@/lib/payment-webhook");
  return processPaymentWebhook(payload, "sig", "secret", eventId);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paymentStatus = "paid";
  state.refundAmount = 0;
  state.events = new Map();
  state.orderUpdates = [];
});

const recordedRefund = () => state.refundAmount;

describe("one $60 refund delivered twice under two event names", () => {
  it("records $60, not $120", async () => {
    await deliver("evt-refund-completed", refundDelivery({ amount: 60 }));
    expect(recordedRefund()).toBe(60);

    await deliver("evt-charge-refunded", refundDelivery({ amount: 60, type: "charge.refunded" }));
    expect(recordedRefund(), "the second delivery is the same refund").toBe(60);
  });

  it("leaves the order partially refunded, not refunded, however many times it lands", async () => {
    const payloads = ["refund.completed", "charge.refunded", "refund.succeeded", "charge.refund.updated"];
    for (const [i, type] of payloads.entries()) {
      await deliver(`evt-${i}`, refundDelivery({ amount: 60, type }));
    }
    expect(recordedRefund(), "$60 was refunded, once").toBe(60);
    expect(state.paymentStatus).toBe("partially_refunded");
  });

  it("never restocks the order for a partial refund, at any delivery count", async () => {
    for (let i = 0; i < 4; i += 1) {
      await deliver(`evt-${i}`, refundDelivery({ amount: 60, type: i % 2 ? "charge.refunded" : "refund.completed" }));
    }
    expect(sideEffects.restock).not.toHaveBeenCalled();
    expect(sideEffects.restorePoints, "the customer's redeemed points stay spent").not.toHaveBeenCalled();
    expect(sideEffects.refundCredit, "and so does their store credit").not.toHaveBeenCalled();
    expect(sideEffects.revokeMembership).not.toHaveBeenCalled();
  });

  it("emails the customer about it once", async () => {
    await deliver("evt-1", refundDelivery({ amount: 60 }));
    const after = sideEffects.email.mock.calls.length;
    await deliver("evt-2", refundDelivery({ amount: 60, type: "charge.refunded" }));
    expect(sideEffects.email.mock.calls.length).toBe(after);
  });
});

describe("two GENUINELY different refunds on one order", () => {
  it("both apply when they carry different refund object ids", async () => {
    // The two-step refund this store treats as ordinary practice: goods, then
    // shipping. Different objects, so they are different refunds.
    await deliver("evt-1", refundDelivery({ amount: 60, objectId: "re_goods" }));
    await deliver("evt-2", refundDelivery({ amount: 20, objectId: "re_shipping" }));
    expect(recordedRefund()).toBe(80);
  });

  it("both apply when they carry different event timestamps and no object id", async () => {
    await deliver("evt-1", refundDelivery({ amount: 60, createdAt: "2026-09-05T10:00:00.000Z" }));
    await deliver("evt-2", refundDelivery({ amount: 60, createdAt: "2026-09-06T14:30:00.000Z" }));
    expect(recordedRefund(), "two honest $60 refunds are not one refund twice").toBe(120);
  });

  it("still completes as a FULL refund when the cumulative amount reaches the charge", async () => {
    await deliver("evt-1", refundDelivery({ amount: 150, objectId: "re_one" }));
    expect(state.paymentStatus).toBe("partially_refunded");

    await deliver("evt-2", refundDelivery({ amount: 50, objectId: "re_two" }));
    expect(state.paymentStatus).toBe("refunded");
    expect(recordedRefund()).toBe(200);
    expect(sideEffects.restock, "a full reversal does restock").toHaveBeenCalled();
  });
});

describe("the identity of a refund", () => {
  it("prefers the refund object's own id over the event timestamp", async () => {
    // Same object, two different envelope timestamps: still one refund.
    await deliver("evt-1", refundDelivery({ amount: 60, objectId: "re_x", createdAt: "2026-09-05T10:00:00.000Z" }));
    await deliver("evt-2", refundDelivery({ amount: 60, objectId: "re_x", createdAt: "2026-09-05T10:00:03.000Z" }));
    expect(recordedRefund()).toBe(60);
  });

  it("does not dedupe when the delivery identifies nothing at all", async () => {
    // No object id and no timestamp. Deduping on order + amount alone would
    // swallow a customer's second honest refund, so this deliberately keeps the
    // old behaviour rather than risk keeping their money.
    const bare = (amount: number) => JSON.stringify({
      type: "refund.completed",
      amount,
      data: { object: { metadata: { order_id: ORDER_ID } } },
    });
    await deliver("evt-1", bare(60));
    await deliver("evt-2", bare(60));
    expect(recordedRefund()).toBe(120);
  });
});
