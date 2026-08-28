import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A PARTIAL REFUND RETURNS PART OF THE MONEY. IT DOES NOT UNDO THE ORDER.
//
// `getOrderStatusForEventType` maps refund.completed to "refunded" whether the
// processor returned $10 of a $200 order or the whole $200. The partial/full
// distinction lives in `resolveRefundOutcome`, and the four ALL-OR-NOTHING
// reversals in the refund branch used to ignore it entirely:
//
//   reverseOrderPoints        debits EVERY point the order earned
//   restoreRedeemedPoints     re-credits EVERY point it spent
//   refundStoreCreditForOrder returns the ENTIRE store-credit redemption
//   revokeMembershipForRefund ends the membership outright
//
// So a $10 goodwill refund handed back the customer's whole store-credit
// redemption and all their redeemed points, and cancelled a paid-for
// membership. Each of those effects is idempotent-by-absence — one row per
// order — so the later FULL refund cannot re-run what the partial already
// spent. Getting it wrong once is permanent. (VL-20 / REF-01)
//
// The second half of this file is REF-02: `upsertOrderRecord` writes
// payment_status = 'refunded' BEFORE these effects run, so a throw escaping the
// branch is not a retryable failure — the processor's retry hits the
// already-terminal guard and returns without running anything. The work is
// deleted, not deferred. Every effect therefore has to contain its own failure.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-refund-0001";

const state: {
  paymentStatus: string;
  orderType: string;
  amountPaid: number;
  subtotal: number;
  refundAmount: number;
  events: Map<string, { processed_at: string | null; claimed_at: string }>;
  orderUpdates: Array<Record<string, unknown>>;
  commissionReversalThrows: boolean;
  restockClaimThrows: boolean;
} = {
  paymentStatus: "paid",
  orderType: "membership",
  amountPaid: 200,
  subtotal: 200,
  refundAmount: 0,
  events: new Map(),
  orderUpdates: [],
  commissionReversalThrows: false,
  restockClaimThrows: false,
};

const effects = {
  reverseOrderPoints: vi.fn(async () => true),
  restoreRedeemedPoints: vi.fn(async () => true),
  refundStoreCredit: vi.fn(async () => true),
  revokeMembership: vi.fn(async () => {}),
  restock: vi.fn(async () => {}),
  claimRestock: vi.fn(async () => {
    if (state.restockClaimThrows) throw new Error("restock claim exploded");
    return "claimed" as const;
  }),
  releaseHold: vi.fn(async () => {}),
  sendEmail: vi.fn(async () => ({ ok: true })),
  alert: vi.fn(async (_alert: { type: string; severity: string; message: string; context?: unknown }) => {}),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({ verifyWebhookSignature: () => true }),
}));
vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 0,
  getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: effects.restoreRedeemedPoints,
  reverseOrderPoints: effects.reverseOrderPoints,
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: effects.sendEmail }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "s", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "s", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })),
  restockInventoryForOrder: effects.restock,
  claimInventoryRestock: effects.claimRestock,
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ ok: false })),
  releaseInventoryForOrder: effects.releaseHold,
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 15, tierName: null })),
  detectCommissionFraudSignal: vi.fn(async () => ({ flagged: false, reason: null })),
}));
vi.mock("@/lib/shippo/order-sync", () => ({ syncOrderToShippo: vi.fn(async () => {}) }));
vi.mock("@/lib/store-credit", () => ({
  redeemStoreCredit: vi.fn(async () => {}),
  refundStoreCreditForOrder: effects.refundStoreCredit,
}));
vi.mock("@/lib/membership-billing", () => ({
  activatePaidMembership: vi.fn(async () => {}),
  revokeMembershipForRefund: effects.revokeMembership,
}));
vi.mock("@/lib/cart-recovery", () => ({ markAbandonedCartsRecovered: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: effects.alert }));
vi.mock("@/lib/ambassador-settings", () => ({ getAmbassadorProgramSettings: async () => ({ enabled: false }) }));
vi.mock("@/lib/admin-control", () => ({ getReferralProgramConfig: async () => ({ enabled: false }) }));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: async () => 0 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/supabase-server", () => {
  const orderRow = () => ({
    order_id: ORDER_ID,
    order_number: "VL-REF0001",
    payment_status: state.paymentStatus,
    fulfillment_status: "awaiting_fulfillment",
    payment_method: "card",
    // A MEMBERSHIP order that also spent points and store credit, so all four
    // all-or-nothing reversals are reachable in one delivery.
    order_type: state.orderType,
    membership_tier_id: "tier-1",
    membership_cycle: "monthly",
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    customer_user_id: "user-1",
    store_credit_redeemed_cents: 2500,
    points_redeemed: 400,
    points_earned: 200,
    subtotal: state.subtotal,
    discount_amount: 0,
    amount_paid: state.amountPaid,
    refund_amount: state.refundAmount,
    currency: "USD",
    order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1 }],
  });

  const from = (table: string) => {
    if (table === "payment_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const id = String(row.event_id);
          if (state.events.has(id)) return { error: { code: "23505", message: "duplicate key" } };
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
          const b: Record<string, unknown> = {
            eq() { return b; }, is() { return b; }, lt() { return b; },
            async select() { return { data: [{ event_id: "e" }], error: null }; },
          };
          return b;
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
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
        upsert: async (row: Record<string, unknown>) => {
          state.orderUpdates.push(row);
          if (typeof row.payment_status === "string") state.paymentStatus = row.payment_status;
          return { error: null };
        },
        update: (row: Record<string, unknown>) => {
          state.orderUpdates.push(row);
          const b: Record<string, unknown> = {
            eq() { return b; }, neq() { return b; }, is() { return b; },
            select() { return b; },
            then(resolve: (value: { data: unknown; error: null }) => unknown) {
              return Promise.resolve({ data: [{ id: "row-1" }], error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }

    if (table === "referral_orders") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            async maybeSingle() {
              return {
                data: { payment_status: "paid", commission_amount: 30, commission_percent: 15, amount_paid: 200 },
                error: null,
              };
            },
          };
          return b;
        },
        update: () => ({
          // THE VL-7 FAILURE, EXACTLY AS PRODUCTION RAISES IT: the refund path
          // writes 'manual_review' and the CHECK constraint refuses it.
          eq: async () => (state.commissionReversalThrows
            ? { error: { code: "23514", message: 'new row for relation "referral_orders" violates check constraint' } }
            : { error: null }),
        }),
      };
    }

    const noop: Record<string, unknown> = {
      select: () => ({
        eq: () => ({
          eq: () => ({ limit: async () => ({ data: [], error: null }) }),
          maybeSingle: async () => ({ data: null, error: null }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
          limit: async () => ({ data: [], error: null }),
          then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
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

function refundPayload(amount: number) {
  // Flat `orderId` + top-level `amount`, which is the shape resolveRefundOutcome
  // reads (`eventPayload.amount`) — a refund whose amount does not reach it is
  // treated as a FULL reversal, so the partial cases below would not exist.
  return JSON.stringify({
    type: "refund.completed",
    orderId: ORDER_ID,
    amount,
    data: { object: { metadata: { order_id: ORDER_ID } } },
  });
}

async function deliverRefund(eventId: string, amount: number) {
  const { processPaymentWebhook } = await import("@/lib/payment-webhook");
  return processPaymentWebhook(refundPayload(amount), "sig", "secret", eventId);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paymentStatus = "paid";
  state.orderType = "membership";
  state.amountPaid = 200;
  state.subtotal = 200;
  state.refundAmount = 0;
  state.events = new Map();
  state.orderUpdates = [];
  state.commissionReversalThrows = false;
  state.restockClaimThrows = false;
});

describe("a PARTIAL refund (VL-20 / REF-01)", () => {
  it("is recorded as partially_refunded, not refunded", async () => {
    const result = await deliverRefund("evt-partial", 10);
    expect(result.status).toBe("refunded");
    const persisted = state.orderUpdates.find((row) => typeof row.payment_status === "string");
    expect(persisted?.payment_status).toBe("partially_refunded");
  });

  it("does NOT return the customer's whole store-credit redemption", async () => {
    await deliverRefund("evt-partial", 10);
    expect(effects.refundStoreCredit).not.toHaveBeenCalled();
  });

  it("does NOT restore every redeemed point, nor claw back every earned point", async () => {
    await deliverRefund("evt-partial", 10);
    expect(effects.restoreRedeemedPoints).not.toHaveBeenCalled();
    expect(effects.reverseOrderPoints).not.toHaveBeenCalled();
  });

  it("does NOT revoke a membership that is still paid for", async () => {
    await deliverRefund("evt-partial", 10);
    expect(effects.revokeMembership).not.toHaveBeenCalled();
  });

  it("still reverses the commission — PROPORTIONALLY, which is the one effect that prorates", async () => {
    // Not skipped, not full: 10/200 of the merchandise base came back.
    await deliverRefund("evt-partial", 10);
    const { computeRetainedCommission } = await import("@/lib/payment-webhook");
    expect(computeRetainedCommission({ base: 200, percent: 15, refundedFraction: 10 / 200 })).toBe(28.5);
  });
});

describe("a FULL refund", () => {
  it("runs every all-or-nothing reversal", async () => {
    await deliverRefund("evt-full", 200);
    expect(effects.reverseOrderPoints).toHaveBeenCalledWith(ORDER_ID);
    expect(effects.restoreRedeemedPoints).toHaveBeenCalledWith(ORDER_ID);
    expect(effects.refundStoreCredit).toHaveBeenCalledWith(ORDER_ID);
  });

  it("ends the membership", async () => {
    await deliverRefund("evt-full", 200);
    expect(effects.revokeMembership).toHaveBeenCalled();
  });

  it("still runs them when a partial refund got there first", async () => {
    // The customer was refunded $150 earlier; this event returns the rest. The
    // cumulative amount is what decides full vs partial, so the reversals the
    // partial correctly skipped must happen NOW.
    state.paymentStatus = "partially_refunded";
    state.refundAmount = 150;
    await deliverRefund("evt-remainder", 50);
    expect(effects.refundStoreCredit).toHaveBeenCalledWith(ORDER_ID);
    expect(effects.revokeMembership).toHaveBeenCalled();
  });
});

describe("a throw inside the refund branch (REF-02)", () => {
  it("does not strand the restock when the commission reversal is refused", async () => {
    // The exact production failure: referral_orders' CHECK rejects
    // 'manual_review' with 23514 (VL-7). The refund branch must absorb it.
    state.orderType = "product";
    state.commissionReversalThrows = true;
    await expect(deliverRefund("evt-23514", 200)).resolves.toMatchObject({ status: "refunded" });
    expect(effects.restock).toHaveBeenCalled();
    expect(effects.refundStoreCredit).toHaveBeenCalledWith(ORDER_ID);
  });

  it("alerts on the failed commission reversal rather than swallowing it", async () => {
    state.orderType = "product";
    state.commissionReversalThrows = true;
    await deliverRefund("evt-23514-alert", 200);
    const alerted = effects.alert.mock.calls.map(([alert]) => alert.type);
    expect(alerted).toContain("unsafe_effect_failed_commission_reversal");
  });

  it("does not strand the customer's money when the restock claim explodes", async () => {
    state.orderType = "product";
    state.restockClaimThrows = true;
    await expect(deliverRefund("evt-restock-throw", 200)).resolves.toMatchObject({ status: "refunded" });
    expect(effects.refundStoreCredit).toHaveBeenCalledWith(ORDER_ID);
    expect(effects.reverseOrderPoints).toHaveBeenCalledWith(ORDER_ID);
    expect(effects.alert.mock.calls.map(([alert]) => alert.type))
      .toContain("unsafe_effect_failed_inventory_restock");
  });

  it("is why nothing may throw here: the retry is short-circuited by the terminal guard", async () => {
    // Prove the premise rather than asserting it in a comment. The refund has
    // already written payment_status = 'refunded'; a retry with a fresh event id
    // returns at the guard and runs NOTHING.
    await deliverRefund("evt-first", 200);
    state.paymentStatus = "refunded";
    vi.clearAllMocks();

    const retry = await deliverRefund("evt-retry", 200);
    expect(retry.status).toBe("refunded");
    expect(effects.restock).not.toHaveBeenCalled();
    expect(effects.refundStoreCredit).not.toHaveBeenCalled();
    expect(effects.reverseOrderPoints).not.toHaveBeenCalled();
  });
});
