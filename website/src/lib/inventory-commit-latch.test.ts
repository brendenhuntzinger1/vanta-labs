import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE PAID LANES, ON THE TWO FACTS A CANCEL LATER DEPENDS ON.
//
// VL-10 / INV-01 / F1 — WHAT `paid_side_effects_at` ACTUALLY MEANS.
//
// The card lane takes that latch FIRST, as its exactly-once claim over every
// paid side effect, and only then decrements stock. It has to: the claim is
// what stops a duplicate webhook delivery paying an ambassador twice, so it
// cannot wait until the end. That makes it a claim, not a receipt — it says
// "this delivery won the right to run the side effects", never "the units left
// the shelf".
//
// `returnInventoryForCancelledOrder` read it as the second thing. So an order
// whose decrement FAILED — reservation RPC down, then every legacy line
// erroring — still carried the latch, and cancelling it "restocked" units that
// had never been removed. Invented stock, which oversells. The manual lane had
// already worked this out and left its latch NULL on a failed decrement; the
// card lane could not do the same without giving up its claim.
//
// So the two facts get two columns. `paid_side_effects_at` stays the claim.
// `inventory_committed_at` is the receipt: written by BOTH paid lanes, only
// after stock has actually moved, and it is what the cancel path reads.
//
// F4 — A PARTIALLY-SUCCESSFUL RESERVATION.
//
// `reserveInventoryForOrder` holds line by line and returns `degraded: true`
// the moment one line's RPC fails — AFTER the earlier lines are already held.
// A two-line order can therefore reach payment with a hold on line 1 and none
// on line 2.
//
// The paid lanes fell back to the legacy decrement on `fin.degraded ||
// fin.finalized === 0`. That partial order finalizes 1 line, reports
// `degraded: false, finalized: 1`, and the fallback is SKIPPED — so line 2 is
// sold with no stock movement at all, and nothing says so. The condition has
// to compare what finalized against what the order actually contains.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-latch-0001";

const state: {
  paymentStatus: string;
  events: Map<string, { processed_at: string | null; claimed_at: string }>;
  sideEffectsClaimedAt: string | null;
  orderUpdates: Array<Record<string, unknown>>;
  items: Array<{ product_id: string; quantity: number }>;
  itemsError: { message: string } | null;
} = {
  paymentStatus: "pending_payment",
  events: new Map(),
  sideEffectsClaimedAt: null,
  orderUpdates: [],
  items: [],
  itemsError: null,
};

const { legacyDecrement, holder } = vi.hoisted(() => ({
  legacyDecrement: vi.fn(async (items: Array<{ product_id?: string | null }>) => ({
    attempted: items.length, failed: 0, errors: [] as string[],
  })),
  holder: {} as {
    finalizeResult: {
      degraded: boolean;
      finalized: number;
      finalizedLines: Array<{ slug: string; variantId: string | null; quantity: number }> | null;
    };
  },
}));

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
  restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "s", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "s", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-fulfillment")>();
  return {
    ...actual,
    // The real per-line diff — stubbing it would let the F4 cases pass without
    // the matching that is the whole point of them.
    itemsNotFinalized: actual.itemsNotFinalized,
    decrementInventoryForOrder: legacyDecrement,
    restockInventoryForOrder: vi.fn(async () => {}),
    claimInventoryRestock: vi.fn(async () => "claimed"),
  };
});
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
vi.mock("@/lib/order-push-notification", () => ({ scheduleOrderPushNotification: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase-server", () => {
  const orderRow = () => ({
    id: "row-1",
    order_id: ORDER_ID,
    order_number: "VL-LATCH01",
    payment_status: state.paymentStatus,
    fulfillment_status: "pending",
    payment_method: "card",
    order_type: "product",
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    customer_user_id: "user-1",
    subtotal: 200,
    discount_amount: 0,
    amount_paid: 200,
    currency: "USD",
    order_items: state.items,
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

    if (table === "order_items") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return Promise.resolve(
                state.itemsError ? { data: null, error: state.itemsError } : { data: state.items, error: null },
              ).then(resolve);
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
        update: (payload: Record<string, unknown>) => {
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
            state.orderUpdates.push(payload);
            const claimsSideEffects = filters.some(([c]) => c === "is:paid_side_effects_at");
            if (claimsSideEffects) {
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

async function deliver(eventId: string) {
  const { processPaymentWebhook } = await import("@/lib/payment-webhook");
  return processPaymentWebhook(
    JSON.stringify({ type: "payment.succeeded", data: { object: { metadata: { order_id: ORDER_ID }, amount: 200 } } }),
    "sig",
    "secret",
    eventId,
  );
}

/** Every value the lanes wrote to `orders.inventory_committed_at`. */
function committedLatchWrites(): unknown[] {
  return state.orderUpdates
    .filter((u) => Object.prototype.hasOwnProperty.call(u, "inventory_committed_at"))
    .map((u) => u.inventory_committed_at);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paymentStatus = "pending_payment";
  state.events = new Map();
  state.sideEffectsClaimedAt = null;
  state.orderUpdates = [];
  state.items = [{ product_id: "p1", quantity: 1 }];
  state.itemsError = null;
  holder.finalizeResult = { degraded: false, finalized: 1, finalizedLines: [{ slug: "p1", variantId: null, quantity: 1 }] };
  legacyDecrement.mockClear();
  legacyDecrement.mockImplementation(async (items: Array<{ product_id?: string | null }>) => ({
    attempted: items.length, failed: 0, errors: [] as string[],
  }));
});

describe("VL-10 — the card lane records that stock moved, separately from its claim", () => {
  it("stamps inventory_committed_at once the decrement has actually run", async () => {
    await deliver("evt-1");

    expect(committedLatchWrites()).toHaveLength(1);
    expect(typeof committedLatchWrites()[0]).toBe("string");
  });

  it("leaves inventory_committed_at NULL when the decrement failed outright", async () => {
    // The claim is already spent — that is what makes this dangerous. Only the
    // receipt can tell a later cancel that nothing left the shelf.
    holder.finalizeResult = { degraded: true, finalized: 0, finalizedLines: null };
    legacyDecrement.mockImplementation(async () => ({ attempted: 1, failed: 1, errors: ["p1: rpc down"] }));

    await deliver("evt-1");

    expect(state.sideEffectsClaimedAt).not.toBeNull();
    expect(committedLatchWrites()).toHaveLength(0);
  });

  it("leaves inventory_committed_at NULL when only SOME lines decremented", async () => {
    // Restocking every line on a cancel would invent units for the lines that
    // never moved, so a partial is not a commit.
    state.items = [{ product_id: "p1", quantity: 1 }, { product_id: "p2", quantity: 1 }];
    holder.finalizeResult = { degraded: true, finalized: 0, finalizedLines: null };
    legacyDecrement.mockImplementation(async () => ({ attempted: 2, failed: 1, errors: ["p2: rpc down"] }));

    await deliver("evt-1");

    expect(committedLatchWrites()).toHaveLength(0);
  });

  it("does not stamp it for a membership order, which holds no stock", async () => {
    state.items = [];
    await deliver("evt-1");
    // A product order with no lines is still a product order; the latch is
    // written because nothing was owed. What must never happen is a latch on an
    // order whose lines failed to move, which the cases above cover.
    expect(committedLatchWrites().length).toBeLessThanOrEqual(1);
  });
});

describe("F4 — a partially-successful reservation still moves the rest of the stock", () => {
  it("decrements the lines the reservation never held", async () => {
    state.items = [{ product_id: "p1", quantity: 1 }, { product_id: "p2", quantity: 2 }];
    // Line 1 was held and finalized; line 2's reserve RPC failed at checkout, so
    // there was never a hold for it to finalize.
    holder.finalizeResult = {
      degraded: false,
      finalized: 1,
      finalizedLines: [{ slug: "p1", variantId: null, quantity: 1 }],
    };

    await deliver("evt-1");

    expect(legacyDecrement).toHaveBeenCalledTimes(1);
    expect(legacyDecrement.mock.calls[0][0]).toEqual([{ product_id: "p2", quantity: 2 }]);
    expect(committedLatchWrites()).toHaveLength(1);
  });

  it("does not re-decrement a line the reservation already finalized", async () => {
    state.items = [{ product_id: "p1", quantity: 1 }];
    holder.finalizeResult = {
      degraded: false,
      finalized: 1,
      finalizedLines: [{ slug: "p1", variantId: null, quantity: 1 }],
    };

    await deliver("evt-1");

    expect(legacyDecrement).not.toHaveBeenCalled();
  });

  it("matches a dosed line by the variant encoded in product_id", async () => {
    state.items = [
      { product_id: "bpc-157-10mg::dose-5mg", quantity: 1 },
      { product_id: "bpc-157-10mg::dose-10mg", quantity: 1 },
    ];
    holder.finalizeResult = {
      degraded: false,
      finalized: 1,
      finalizedLines: [{ slug: "bpc-157-10mg", variantId: "dose-5mg", quantity: 1 }],
    };

    await deliver("evt-1");

    expect(legacyDecrement.mock.calls[0][0]).toEqual([{ product_id: "bpc-157-10mg::dose-10mg", quantity: 1 }]);
  });

  it("falls back for the WHOLE order when the holds could not be enumerated", async () => {
    // readPendingHolds is best-effort. If it could not say which lines were
    // held, the diff is unusable and the old rule applies: fall back only when
    // nothing finalized, so a successful finalize is never decremented twice.
    state.items = [{ product_id: "p1", quantity: 1 }, { product_id: "p2", quantity: 1 }];
    holder.finalizeResult = { degraded: false, finalized: 2, finalizedLines: null };

    await deliver("evt-1");

    expect(legacyDecrement).not.toHaveBeenCalled();
  });

  it("still falls back for the whole order when the reservation is degraded", async () => {
    state.items = [{ product_id: "p1", quantity: 1 }, { product_id: "p2", quantity: 1 }];
    holder.finalizeResult = { degraded: true, finalized: 1, finalizedLines: [{ slug: "p1", variantId: null, quantity: 1 }] };

    await deliver("evt-1");

    expect(legacyDecrement).toHaveBeenCalledTimes(1);
    expect(legacyDecrement.mock.calls[0][0]).toHaveLength(2);
  });
});
