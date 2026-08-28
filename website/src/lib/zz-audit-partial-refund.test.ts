import { beforeEach, describe, expect, it, vi } from "vitest";

const ORDER_ID = "order-partial-0001";

const state = {
  paymentStatus: "paid" as string,
  refundAmount: 0 as number,
  events: new Map<string, { processed_at: string | null; claimed_at: string }>(),
  emailLog: [] as Array<{ id: number; order_id: string; kind: string; status: string }>,
};

const sideEffects = {
  email: vi.fn(async (_m?: { subject?: string; idempotencyKey?: string }) => ({ success: true, provider: "x" })),
  alert: vi.fn(async () => {}),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({ verifyWebhookSignature: () => true }) }));
vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 100,
  getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sideEffects.email }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "commission", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "receipt", html: "h" }),
  refundConfirmationTemplate: (i: { refundAmount: number; isFullRefund: boolean }) =>
    ({ subject: `refund $${i.refundAmount} full=${i.isFullRefund}`, html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })),
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => "claimed"),
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
  refundStoreCreditForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/membership-billing", () => ({
  activatePaidMembership: vi.fn(async () => {}),
  revokeMembershipForRefund: vi.fn(async () => {}),
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
    id: "row-1",
    order_id: ORDER_ID,
    order_number: "VL-PART001",
    payment_status: state.paymentStatus,
    fulfillment_status: "awaiting_fulfillment",
    payment_method: "card",
    order_type: "product",
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    customer_user_id: "user-1",
    subtotal: 200,
    discount_amount: 0,
    amount_paid: 200,
    refund_amount: state.refundAmount,
    currency: "USD",
    order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1 }],
  });

  const from = (table: string) => {
    if (table === "payment_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const id = String(row.event_id);
          if (state.events.has(id)) return { error: { code: "23505", message: "dup" } };
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
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            is() { return b; },
            lt() { return b; },
            async select() { return { data: state.events.has(id) ? [{ event_id: id }] : [], error: null }; },
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
            eq() { return b; }, limit() { return b; }, order() { return b; },
            async maybeSingle() { return { data: orderRow(), error: null }; },
          };
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          const b: Record<string, unknown> = {
            eq() { return b; }, neq() { return b; }, is() { return b; },
            select() { return b; },
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              if (typeof payload.payment_status === "string") state.paymentStatus = String(payload.payment_status);
              if (payload.refund_amount !== undefined) state.refundAmount = Number(payload.refund_amount);
              return Promise.resolve({ data: [{ id: "row-1" }], error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }

    if (table === "order_email_log") {
      return {
        // Models the production partial unique index:
        //   unique (order_id, kind) where status in ('sending','sent')
        insert: (row: Record<string, unknown>) => {
          const b = {
            select() { return b; },
            async maybeSingle() {
              const held = state.emailLog.some(
                (r) => r.order_id === row.order_id && r.kind === row.kind && (r.status === "sending" || r.status === "sent"),
              );
              if (held) return { data: null, error: { code: "23505", message: "duplicate key" } };
              const created = { id: state.emailLog.length + 1, order_id: String(row.order_id), kind: String(row.kind), status: String(row.status) };
              state.emailLog.push(created);
              return { data: { id: created.id }, error: null };
            },
          };
          return b;
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (_c: string, v: unknown) => {
            const target = state.emailLog.find((r) => r.id === v);
            if (target && typeof payload.status === "string") target.status = String(payload.status);
            return { error: null };
          },
        }),
      };
    }

    const noop: Record<string, unknown> = {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
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
  return JSON.stringify({ type: "refund.completed", amount, data: { object: { metadata: { order_id: ORDER_ID } } } });
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
  state.emailLog = [];
});

describe("two-step partial refund (goods, then shipping)", () => {
  it("tells the customer about BOTH refunds", async () => {
    const r1 = await deliver("evt-r1", refundPayload(60));
    console.log("r1:", JSON.stringify(r1), "status now:", state.paymentStatus, "refund:", state.refundAmount, "log:", JSON.stringify(state.emailLog));
    console.log("emails after r1:", JSON.stringify(sideEffects.email.mock.calls.map(([m]) => m?.subject)));
    const r2 = await deliver("evt-r2", refundPayload(140));
    console.log("r2:", JSON.stringify(r2));

    const refundSubjects = sideEffects.email.mock.calls
      .map(([m]) => String(m?.subject ?? ""))
      .filter((s) => s.startsWith("refund"));

    // Diagnostics
    console.log("payment_status after both:", state.paymentStatus, "refund_amount:", state.refundAmount);
    console.log("email log rows:", JSON.stringify(state.emailLog));
    console.log("refund emails:", JSON.stringify(refundSubjects));

    expect(refundSubjects.length).toBe(2);
  });
});
