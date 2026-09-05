// ---------------------------------------------------------------------------
// A REFUND IS NOT A RETURN. STOCK COMES BACK ONLY IF THE GOODS NEVER LEFT.
//
// The admin refund action deliberately restocks nothing ("a returned vial may
// have spent a week in a mailbox") and says the processor-driven path in
// payment-webhook.ts "covers an order the customer never received (a failed or
// cancelled order whose goods never left)". The webhook path did not check
// that. It restocked behind `inventory_committed_at` alone, so a full refund
// or chargeback issued at the processor for an order that had SHIPPED — a
// lost parcel, a goodwill refund, a dispute on a delivered order — put units
// back on the shelf that nobody has. Phantom stock oversells.
//
// The cancel chokepoint (shippo/service.ts) already refuses to restock out of
// label_purchased and alerts instead; from `shipped` onward a cancel is not
// even a legal transition. This pins the same rule onto the refund path.
// ---------------------------------------------------------------------------
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

const ORDER_ID = "order-refund-shipped-0001";

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
  inventoryCommittedAt: string | null;
  fulfillmentStatus: string;
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
  /** orders.inventory_committed_at — the paid transition's receipt that stock was decremented. */
  inventoryCommittedAt: "2026-08-01T00:00:00.000Z",
  fulfillmentStatus: "awaiting_fulfillment",
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
    // The receipt that the paid transition wrote when the stock actually left
    // the shelf. The refund branch restocks only behind it (null would mean
    // "paid, but the decrement failed" — nothing to return).
    inventory_committed_at: state.inventoryCommittedAt,
    fulfillment_status: state.fulfillmentStatus,
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
  state.inventoryCommittedAt = "2026-08-01T00:00:00.000Z";
  state.fulfillmentStatus = "awaiting_fulfillment";
});


const PARCEL_MAY_HAVE_LEFT = ["label_purchased", "shipped", "in_transit", "out_for_delivery", "delivered", "returned"];
const GOODS_STILL_HERE = ["pending", "awaiting_fulfillment", "processing", "ready_to_fulfill", "packed"];

describe("a processor refund on an order whose parcel may already have left", () => {
  for (const status of PARCEL_MAY_HAVE_LEFT) {
    it(`does NOT restock a ${status} order, and tells the operator instead`, async () => {
      state.orderType = "product";
      state.fulfillmentStatus = status;
      const result = await deliverRefund(`evt-shipped-${status}`, 200);
      expect(result.status).toBe("refunded");
      expect(effects.claimRestock).not.toHaveBeenCalled();
      expect(effects.restock).not.toHaveBeenCalled();
      expect(effects.alert).toHaveBeenCalledWith(
        expect.objectContaining({ type: "refund_after_shipment_not_restocked", severity: "warning" }),
      );
      // The money side of the refund is unaffected.
      expect(effects.reverseOrderPoints).toHaveBeenCalled();
      expect(effects.refundStoreCredit).toHaveBeenCalled();
    });
  }
});

describe("a processor refund on an order whose goods never left", () => {
  for (const status of GOODS_STILL_HERE) {
    it(`still restocks a ${status} order exactly as before`, async () => {
      state.orderType = "product";
      state.fulfillmentStatus = status;
      const result = await deliverRefund(`evt-here-${status}`, 200);
      expect(result.status).toBe("refunded");
      expect(effects.claimRestock).toHaveBeenCalled();
      expect(effects.restock).toHaveBeenCalled();
      expect(effects.alert).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "refund_after_shipment_not_restocked" }),
      );
    });
  }
});
