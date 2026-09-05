import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PAYING FOR A MEMBERSHIP HAS TO ACTUALLY GRANT ONE.
//
// WHY THIS FILE EXISTS. There are 162 membership tests and they are good ones —
// entitlement states, the grace window, what counts as a payment, the billing
// arithmetic, tier changes. Every one of them tests a pure function DOWNSTREAM
// of activation. Not one tests that activation is reached.
//
// Every existing test that so much as names activatePaidMembership only mocks
// it away:
//
//   vi.mock("@/lib/membership-billing", () => ({
//     activatePaidMembership: vi.fn(async () => {}),   <- never asserted on
//   }));
//
// So the whole suite stays green if the call is deleted, if its guard is
// inverted, or if it is handed the wrong cycle. The one thing a member cares
// about — I paid, do I have it — was the one thing nothing checked.
//
// The gap is not theoretical. Production has exactly ONE paid membership order
// in its entire history (VL-49CA32C1, $1.00 monthly, 2026-08-03). A renewal
// billing event landed 258ms after the payment settled, so activation did fire.
// That account's customer_memberships row no longer exists, and no code path in
// this repository deletes one: cancelMembership only updates, the admin "remove"
// action calls cancelMembership, and the single delete statement in
// membership-false-activation-cleanup.sql is guarded four ways — that order
// clears two of them independently (a paid renewal event, and an order with
// paid_at set). The row's disappearance is consistent with hands-on SQL during
// that night's testing burst, not with a live defect, and nothing here changes
// production code. But with n=1 and the row gone, the only way to know the next
// real member gets what they paid for is to execute the path.
//
// The cycle assertions carry their own history: resolveMembershipCycle used to
// read `String(cycle ?? "annual") === "monthly" ? "monthly" : "annual"`, so a
// missing cycle silently granted a YEAR. That is proven here at the webhook,
// not just at the helper.
//
// NEGATIVE CONTROLS. Each guard was broken in turn and the named test confirmed
// red; all were restored:
//
//   the activation call deleted            -> "a paid membership order grants it"
//   runSideEffects forced true             -> "a second delivery does not grant twice"
//   the membership_tier_id guard dropped   -> "an order with no tier grants nothing"
//   the isMembershipOrder guard dropped    -> "a product order never grants membership"
//   cycle defaulted to annual              -> "a missing cycle grants a MONTH"
// ---------------------------------------------------------------------------

const ORDER_ID = "order-mem-0001";
const USER_ID = "user-member-1";
const TIER_ID = "tier-essential";

const activate = vi.fn(async () => {});

const state = {
  orderType: "membership",
  membershipTierId: TIER_ID as string | null,
  membershipCycle: "monthly" as unknown,
  customerUserId: USER_ID as string | null,
  paymentStatus: "pending_payment",
  sideEffectsClaimedAt: null as string | null,
  events: new Map<string, { processed_at: string | null; claimed_at: string }>(),
  /** Set when the non-membership branch runs, so the two are told apart. */
  inventoryFinalized: 0,
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({ verifyWebhookSignature: () => true }),
}));
vi.mock("@/lib/membership-billing", () => ({
  activatePaidMembership: activate,
  revokeMembershipForRefund: vi.fn(async () => {}),
}));
vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 0,
  getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1,
  recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}),
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/order-email-once", () => ({ sendOrderEmailOnce: vi.fn(async () => ({ ok: true })) }));
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
  finalizeInventoryForOrder: vi.fn(async () => {
    state.inventoryFinalized += 1;
    return { ok: true, finalized: 1, degraded: false };
  }),
  releaseInventoryForOrder: vi.fn(async () => {}),
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
vi.mock("@/lib/cart-recovery", () => ({ markAbandonedCartsRecovered: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({ minimumQualifyingOrder: 0, minimumPayoutThreshold: 25 }),
}));
vi.mock("@/lib/admin-control", () => ({
  getReferralProgramConfig: async () => ({ enabled: false, commissionsPaused: true, defaultCommissionPercent: 0, discountPercent: 0 }),
}));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: () => 0 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/supabase-server", () => {
  const orderRow = () => ({
    id: "row-1",
    order_id: ORDER_ID,
    order_number: "VL-MEM0001",
    order_type: state.orderType,
    membership_tier_id: state.membershipTierId,
    membership_cycle: state.membershipCycle,
    payment_status: state.paymentStatus,
    fulfillment_status: "pending",
    payment_method: "card",
    customer_email: "member@example.test",
    customer_name: "A Member",
    customer_user_id: state.customerUserId,
    referral_code: null,
    ambassador_id: null,
    coupon_code: null,
    subtotal: 9.99,
    shipping_amount: 0,
    discount_amount: 0,
    tax_amount: 0,
    card_processing_fee: 0,
    amount_paid: 9.99,
    refund_amount: 0,
    paid_at: null,
    shipping_address: null,
    city: null,
    postal_code: null,
    points_redeemed: 0,
    store_credit_redeemed_cents: 0,
    order_items: [],
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
          let id = "";
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            is() { return b; },
            lt() { return b; },
            async select() {
              const row = state.events.get(id);
              return row ? { data: [{ event_id: id }], error: null } : { data: [], error: null };
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
            order() { return b; },
            async maybeSingle() { return { data: orderRow(), error: null }; },
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
              return Promise.resolve(resolve(settle()));
            },
          };
          function settle() {
            if (filters.some(([c]) => c === "is:paid_side_effects_at")) {
              if (state.sideEffectsClaimedAt !== null) return { data: [], error: null };
              state.sideEffectsClaimedAt = new Date().toISOString();
              return { data: [{ id: "row-1" }], error: null };
            }
            const notPaid = filters.find(([c]) => c === "neq:payment_status");
            if (notPaid) {
              if (state.paymentStatus === notPaid[1]) return { data: [], error: null };
              state.paymentStatus = "paid";
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

const { processPaymentWebhook } = await import("@/lib/payment-webhook");

async function deliver(eventId: string, type = "payment.succeeded") {
  const body = JSON.stringify({ type, data: { object: { metadata: { order_id: ORDER_ID }, amount: 9.99 } } });
  return processPaymentWebhook(body, "sig", "secret", eventId);
}

/** The arguments activation was actually called with. */
const grant = () => activate.mock.calls[0] as unknown as [string, string, string, string] | undefined;

beforeEach(() => {
  state.orderType = "membership";
  state.membershipTierId = TIER_ID;
  state.membershipCycle = "monthly";
  state.customerUserId = USER_ID;
  state.paymentStatus = "pending_payment";
  state.sideEffectsClaimedAt = null;
  state.events.clear();
  state.inventoryFinalized = 0;
  activate.mockClear();
});

describe("the member gets what they paid for", () => {
  it("a paid membership order grants it, to the right account, on the right tier", async () => {
    await deliver("evt-1");

    expect(activate).toHaveBeenCalledTimes(1);
    // The paid ORDER rides along so the signup receipt is logged against it
    // (send-once slot on order_email_log) instead of being fire-and-forget.
    expect(grant()).toEqual([USER_ID, TIER_ID, "monthly", ORDER_ID]);
  });

  it("an annual purchase grants a year", async () => {
    state.membershipCycle = "annual";
    await deliver("evt-1");
    expect(grant()![2]).toBe("annual");
  });

  it("reads the cycle case- and whitespace-insensitively", async () => {
    state.membershipCycle = "  Annual ";
    await deliver("evt-1");
    expect(grant()![2]).toBe("annual");
  });
});

describe("a missing cycle must never be read as a year", () => {
  /**
   * This once granted TWELVE MONTHS for a data fault. A wrong monthly costs the
   * customer 30 days of benefits; a wrong annual costs the store a year of
   * them, and writes cancel_at_period_end, so the member immediately reads
   * "set to cancel".
   */
  it.each([null, undefined, "", "   ", "yearly", "12mo", 42])(
    "a cycle of %p grants a MONTH",
    async (cycle) => {
      state.membershipCycle = cycle;
      await deliver("evt-1");
      expect(activate).toHaveBeenCalledTimes(1);
      expect(grant()![2]).toBe("monthly");
    },
  );
});

describe("granted once, never twice", () => {
  it("a redelivered event does not grant again", async () => {
    await deliver("evt-1");
    const again = await deliver("evt-1");
    expect(again).toMatchObject({ duplicate: true });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  /**
   * A second, DIFFERENT success event for the same order. Its event_id is new,
   * so the event claim cannot catch it — only the side-effects claim can. A
   * second activation would restart the paid period, silently extending a term
   * the customer paid for once.
   */
  it("a second delivery does not grant twice", async () => {
    await deliver("evt-1");
    await deliver("evt-2");
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("nor a third or a fourth", async () => {
    for (const id of ["evt-1", "evt-2", "evt-3", "evt-4"]) await deliver(id);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe("what must not grant a membership", () => {
  it("an order with no tier grants nothing", async () => {
    state.membershipTierId = null;
    await deliver("evt-1");
    expect(activate).not.toHaveBeenCalled();
  });

  it("a guest checkout with no account grants nothing", async () => {
    state.customerUserId = null;
    await deliver("evt-1");
    expect(activate).not.toHaveBeenCalled();
  });

  it("a product order never grants membership", async () => {
    state.orderType = "product";
    await deliver("evt-1");
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(["payment.failed", "payment.canceled"])("a %s event grants nothing", async (type) => {
    await deliver("evt-1", type);
    expect(activate).not.toHaveBeenCalled();
  });

  /**
   * A missing tier is a data fault, and the activation call is best-effort. It
   * must not take the rest of the paid side-effects down with it.
   */
  it("a fault in activation does not abort the webhook", async () => {
    activate.mockRejectedValueOnce(new Error("tier lookup exploded"));
    await expect(deliver("evt-1")).resolves.toBeDefined();
    expect(state.paymentStatus).toBe("paid");
  });
});

describe("a membership is not a parcel", () => {
  it("holds no inventory", async () => {
    await deliver("evt-1");
    expect(state.inventoryFinalized).toBe(0);
  });

  it("but a product order does finalize stock — proving the branch is live", async () => {
    state.orderType = "product";
    await deliver("evt-1");
    expect(state.inventoryFinalized).toBe(1);
  });
});
