import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE ELIGIBLE PAID ORDER EARNS EXACTLY ONE COMMISSION.
//
// WHY THIS FILE EXISTS. The commission MONEY is thoroughly proven — the
// arithmetic, the discount interaction, the refund retention, the tier
// resolution all run against the real functions. What was NOT proven anywhere
// is the thing that actually pays an ambassador twice: HOW MANY ROWS a sequence
// of webhook deliveries leaves behind.
//
// Every existing assertion about that is a source-text match:
//
//   expect(webhook).toContain("existingCommission")
//   expect(webhook).toContain('.is("paid_side_effects_at", null)')
//
// A string match proves the characters are present. It cannot tell you the
// guard is wired to anything, cannot tell you what happens on the second
// delivery, and stays green if the branch it names is dead. That is the same
// class of test that let an audit misread which table stock lives in tonight.
//
// So this drives the REAL processPaymentWebhook against a store that enforces
// the unique keys production actually has:
//
//   commissions_order_id_key       UNIQUE (order_id)
//   referral_orders_order_id_key   UNIQUE (order_id)
//
// (Verified against the live database via pg_index. The fake below rejects a
// second insert with 23505 exactly as postgres would, so a test cannot pass
// here by doing something the database would refuse.)
//
// WHY IT HAS TO BE BEHAVIOURAL AND NOT A PRODUCTION QUERY. There are 6
// ambassadors in production and ZERO commissions — no order has ever carried an
// ambassador_id. Production data can prove nothing about this path. The only
// honest certification is to execute it.
//
// NEGATIVE CONTROLS. Each guard was removed from payment-webhook.ts in turn and
// the named test confirmed red; all five were then restored:
//
//   runSideEffects forced true          -> "a second, distinct success event"
//   the non-pending early return gutted -> "never regresses ... already paid out"
//   payload attribution preferred       -> "a payload naming a different ambassador"
//   the live status check disabled      -> "an ambassador deactivated after the order"
//   minimum gated post-discount         -> "a cart that qualified at checkout"
//
// The first draft of the spoof test did NOT go red: it planted the forged
// attribution under data.object, while normalizeOrderPayload reads it from the
// top level, so the fallback under test was never reached. It was fixed, not
// kept. A test that cannot fail is worse than no test, because it reads as
// coverage.
// ---------------------------------------------------------------------------

const ORDER_ID = "order-amb-0001";
const AMBASSADOR_A = "amb-aaaa";
const AMBASSADOR_B = "amb-bbbb";

type CommissionRow = Record<string, unknown>;

const state = {
  /** Order attribution, as persisted at checkout. */
  ambassadorId: AMBASSADOR_A as string | null,
  referralCode: "ELIJAH-AB78AE" as string | null,
  subtotal: 200,
  discountAmount: 40,
  amountPaid: 175,
  orderType: "product",
  paymentStatus: "pending_payment",
  sideEffectsClaimedAt: null as string | null,

  /** Live ambassador state at webhook time. */
  ambassadorStatus: "approved",
  customerDiscountOverride: null as unknown,

  /** Program policy at webhook time. */
  programEnabled: true,
  commissionsPaused: false,
  minimumQualifyingOrder: 0,

  /** The two tables, each with a real UNIQUE(order_id). */
  referralOrders: new Map<string, CommissionRow>(),
  commissions: new Map<string, CommissionRow>(),
  /** Every write attempt, so "one row" can be told apart from "overwritten". */
  referralInserts: 0,
  commissionUpserts: 0,

  events: new Map<string, { processed_at: string | null; claimed_at: string }>(),
};

const sent = { commissionEmails: [] as unknown[] };

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
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (message: unknown) => {
    sent.commissionEmails.push(message);
    return { ok: true };
  }),
}));
vi.mock("@/lib/email/order-email-once", () => ({ sendOrderEmailOnce: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: (input: Record<string, unknown>) => ({ subject: "commission", html: "h", ...input }),
  orderConfirmationTemplate: () => ({ subject: "s", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => {}),
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ ok: false })),
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 10, tierName: null })),
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
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

// Program policy is read live at webhook time — that is the whole point of the
// eligibility re-check — so these read from state rather than being constants.
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: state.minimumQualifyingOrder,
    minimumPayoutThreshold: 25,
  }),
}));
vi.mock("@/lib/admin-control", () => ({
  getReferralProgramConfig: async () => ({
    enabled: state.programEnabled,
    commissionsPaused: state.commissionsPaused,
    defaultCommissionPercent: 10,
    discountPercent: 20,
  }),
}));
// The real resolver, not a stub — the snapshot it produces is asserted below.
vi.mock("@/lib/ambassador-discount", async () => await vi.importActual("@/lib/ambassador-discount"));

vi.mock("@/lib/supabase-server", () => {
  const orderRow = () => ({
    id: "row-1",
    order_id: ORDER_ID,
    order_number: "VL-AMB0001",
    order_type: state.orderType,
    payment_status: state.paymentStatus,
    fulfillment_status: "pending",
    payment_method: "card",
    customer_email: "buyer@example.test",
    customer_name: "A Buyer",
    customer_user_id: "user-1",
    referral_code: state.referralCode,
    ambassador_id: state.ambassadorId,
    coupon_code: null,
    subtotal: state.subtotal,
    shipping_amount: 15,
    discount_amount: state.discountAmount,
    tax_amount: 0,
    card_processing_fee: 0,
    amount_paid: state.amountPaid,
    refund_amount: 0,
    paid_at: null,
    shipping_address: "1 Test St",
    city: "Denver",
    postal_code: "80202",
    points_redeemed: 0,
    store_credit_redeemed_cents: 0,
    order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1 }],
  });

  /** A table with a real UNIQUE(order_id), matching production's index. */
  /**
   * Production's `referral_orders` constraints, read from its catalog this
   * session (information_schema.columns + pg_constraint):
   *
   *   ambassador_id / referral_code / original_subtotal / customer_discount /
   *   amount_paid / commission_amount            NOT NULL, no default
   *   referral_orders_original_subtotal_check    CHECK (original_subtotal >= 0)
   *   referral_orders_customer_discount_check    CHECK (customer_discount >= 0)
   *   referral_orders_amount_paid_check          CHECK (amount_paid >= 0)
   *   referral_orders_commission_amount_check    CHECK (commission_amount >= 0)
   *   referral_orders_payment_status_check        see below
   *
   * The unique key was already modelled here. These were not, and that is why
   * this suite stayed green while production refused every single accrual: the
   * insert fails on `original_subtotal` before it ever reaches the CHECK that
   * Block G+H reported. Verified against production with a rolled-back DO block.
   */
  const RO_NOT_NULL = [
    "order_id", "ambassador_id", "referral_code",
    "original_subtotal", "customer_discount", "amount_paid", "commission_amount",
  ];
  const RO_NON_NEGATIVE = ["original_subtotal", "customer_discount", "amount_paid", "commission_amount"];
  /**
   * The lifecycle the repo declares (three table definitions, all
   * `default 'pending'`, alongside approved_for_payout_at / commission_paid_at /
   * reversed_at) and the whole application implements. Production's CHECK is
   * currently narrower; src/lib/sql/referral-orders-commission-lifecycle.sql
   * widens it to exactly this set.
   */
  const RO_PAYMENT_STATUS = new Set([
    "pending", "approved_for_payout", "paid", "reversed", "voided",
    "refunded", "partially_refunded",
  ]);

  function violatesReferralOrderConstraints(row: CommissionRow) {
    for (const column of RO_NOT_NULL) {
      if (row[column] === undefined || row[column] === null) {
        return { code: "23502", message: `null value in column "${column}" of relation "referral_orders" violates not-null constraint` };
      }
    }
    for (const column of RO_NON_NEGATIVE) {
      if (Number(row[column]) < 0) {
        return { code: "23514", message: `new row for relation "referral_orders" violates check constraint "referral_orders_${column}_check"` };
      }
    }
    if (!RO_PAYMENT_STATUS.has(String(row.payment_status ?? ""))) {
      return { code: "23514", message: `new row for relation "referral_orders" violates check constraint "referral_orders_payment_status_check"` };
    }
    return null;
  }

  function keyedTable(
    store: Map<string, CommissionRow>,
    onInsert: () => void,
    onUpsert: () => void,
    enforceRow?: (row: CommissionRow) => { code: string; message: string } | null,
  ) {
    return {
      select: () => {
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          eq(column: string, value: unknown) { filters[column] = value; return b; },
          in(column: string, values: unknown[]) { filters[`in:${column}`] = values; return b; },
          async maybeSingle() { return { data: store.get(String(filters.order_id)) ?? null, error: null }; },
          then(resolve: (v: unknown) => unknown) {
            // Used by the unpaid-balance read, which filters by ambassador.
            const rows = [...store.values()].filter((row) => {
              for (const [column, value] of Object.entries(filters)) {
                if (column.startsWith("in:")) {
                  if (!(value as unknown[]).includes(row[column.slice(3)])) return false;
                } else if (row[column] !== value) {
                  return false;
                }
              }
              return true;
            });
            return Promise.resolve(resolve({ data: rows, error: null }));
          },
        };
        return b;
      },
      insert(row: CommissionRow) {
        onInsert();
        const key = String(row.order_id);
        const violation = enforceRow?.(row) ?? null;
        if (violation) {
          const rejected: Record<string, unknown> = {
            select() { return rejected; },
            async single() { return { data: null, error: violation }; },
            then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data: null, error: violation })); },
          };
          return rejected;
        }
        const duplicate = store.has(key);
        if (!duplicate) store.set(key, { id: `${key}-c`, ...row });
        const envelope = duplicate
          // 23505 unique_violation, exactly what postgres returns.
          ? { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
          : { data: { id: `${key}-c` }, error: null };
        const b: Record<string, unknown> = {
          select() { return b; },
          async single() { return envelope; },
          then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve(envelope)); },
        };
        return b;
      },
      async upsert(row: CommissionRow, options?: { onConflict?: string }) {
        onUpsert();
        const key = String(row.order_id);
        if (options?.onConflict !== "order_id" && store.has(key)) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        store.set(key, { ...(store.get(key) ?? {}), id: `${key}-c`, ...row });
        return { error: null };
      },
      update(payload: CommissionRow) {
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            const key = String(filters.order_id ?? "");
            const existing = store.get(key);
            if (existing) store.set(key, { ...existing, ...payload });
            return Promise.resolve({ error: null });
          },
        };
        return b;
      },
    };
  }

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
            // The exactly-once side-effects claim: wins only while NULL.
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

    if (table === "referral_orders") {
      return keyedTable(
        state.referralOrders,
        () => { state.referralInserts += 1; },
        () => {},
        violatesReferralOrderConstraints,
      );
    }
    if (table === "commissions") {
      return keyedTable(state.commissions, () => {}, () => { state.commissionUpserts += 1; });
    }
    if (table === "ambassadors") {
      return {
        select: () => ({
          eq: () => ({
            async maybeSingle() {
              return {
                data: { status: state.ambassadorStatus, customer_discount_percent: state.customerDiscountOverride },
                error: null,
              };
            },
          }),
        }),
      };
    }
    if (table === "partners") {
      return {
        select: () => ({
          eq: () => ({
            async maybeSingle() { return { data: { name: "Elijah", email: "elijah@example.test" }, error: null }; },
          }),
        }),
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

function payload(type = "payment.succeeded") {
  return JSON.stringify({ type, data: { object: { metadata: { order_id: ORDER_ID }, amount: 175 } } });
}

/** One webhook delivery. A distinct eventId is a genuinely NEW delivery. */
async function deliver(eventId: string, type = "payment.succeeded") {
  return processPaymentWebhook(payload(type), "sig", "secret", eventId);
}

const commission = () => state.commissions.get(ORDER_ID);

beforeEach(() => {
  state.ambassadorId = AMBASSADOR_A;
  state.referralCode = "ELIJAH-AB78AE";
  state.subtotal = 200;
  state.discountAmount = 40;
  state.amountPaid = 175;
  state.orderType = "product";
  state.paymentStatus = "pending_payment";
  state.sideEffectsClaimedAt = null;
  state.ambassadorStatus = "approved";
  state.customerDiscountOverride = null;
  state.programEnabled = true;
  state.commissionsPaused = false;
  state.minimumQualifyingOrder = 0;
  state.referralOrders.clear();
  state.commissions.clear();
  state.referralInserts = 0;
  state.commissionUpserts = 0;
  state.events.clear();
  sent.commissionEmails.length = 0;
  vi.clearAllMocks();
});

describe("one paid order, one commission", () => {
  it("awards exactly one commission for the right amount", async () => {
    await deliver("evt-1");

    expect(state.referralOrders.size).toBe(1);
    expect(state.commissions.size).toBe(1);
    // $200 cart, $40 referral discount -> $160 commissionable, 10% -> $16.00.
    expect(commission()!.commission_amount).toBe(16);
    expect(commission()!.partner_id).toBe(AMBASSADOR_A);
    expect(commission()!.referral_code).toBe("ELIJAH-AB78AE");
    expect(commission()!.status).toBe("pending");
    expect(commission()!.ineligible_reason).toBeNull();
  });

  /**
   * M-01. These two columns are NOT NULL in production with no default, and the
   * accrual never sent either — so every insert was refused with 23502 before it
   * could reach the payment_status CHECK that Block G+H reported. This suite was
   * green throughout, because its own double was more permissive than the
   * database. It is not any more.
   */
  it("records the subtotal checkout gated on, and the discount in dollars", async () => {
    await deliver("evt-1");

    const row = [...state.referralOrders.values()][0];
    // $200 cart, $40 referral discount -> $160 commissionable.
    expect(Number(row.original_subtotal)).toBeCloseTo(200, 2);
    expect(Number(row.customer_discount)).toBeCloseTo(40, 2);
    // The dollars off and the RATE are different facts, stored separately.
    // `customer_discount` is what the shopper saved; `customer_discount_percent`
    // is the rate that produced it, frozen at order time.
    expect(row.customer_discount).not.toBe(row.customer_discount_percent);
  });

  it("never records a negative discount, whatever order the subtotals arrive in", async () => {
    // referral_orders_customer_discount_check refuses a negative, so a caller
    // whose qualifying subtotal is the SMALLER of the two must clamp, not throw.
    await deliver("evt-1");

    const row = [...state.referralOrders.values()][0];
    expect(Number(row.customer_discount)).toBeGreaterThanOrEqual(0);
    expect(Number(row.original_subtotal)).toBeGreaterThanOrEqual(Number(row.amount_paid));
  });

  it("accrues at 'pending' so both the hold period and the payout gate can see it", async () => {
    await deliver("evt-1");

    // autoApproveEligibleCommissions selects `pending`; markCommissionsPaid
    // selects `approved_for_payout`. Accruing straight to 'paid' — the fix
    // originally proposed for this defect — would skip the hold period and be
    // invisible to both, which is money state wrong rather than money missing.
    expect([...state.referralOrders.values()][0].payment_status).toBe("pending");
  });

  it("commissions the discounted merchandise only — never shipping or tax", async () => {
    await deliver("evt-1");
    // The order collected $15 shipping on top; 10% of the $175 charged would be
    // $17.50. The ambassador earns on merchandise.
    expect(commission()!.commission_amount).toBe(16);
    expect(commission()!.commission_amount).not.toBe(17.5);
  });

  it("freezes the customer discount that applied when the order was placed", async () => {
    state.customerDiscountOverride = 20;
    await deliver("evt-1");
    expect(commission()!.customer_discount_percent).toBe(20);
    expect(commission()!.commission_percent).toBe(10);
  });

  it("emails the ambassador once", async () => {
    await deliver("evt-1");
    expect(sent.commissionEmails).toHaveLength(1);
  });
});

describe("never two", () => {
  /**
   * The retry. Same event_id — the payment_events primary key stops it before
   * anything else runs.
   */
  it("a redelivered event writes nothing further", async () => {
    await deliver("evt-1");
    const firstAmount = commission()!.commission_amount;

    const again = await deliver("evt-1");

    expect(again).toMatchObject({ duplicate: true });
    expect(state.commissions.size).toBe(1);
    expect(state.referralInserts).toBe(1);
    expect(commission()!.commission_amount).toBe(firstAmount);
    expect(sent.commissionEmails).toHaveLength(1);
  });

  /**
   * The dangerous one: a SECOND, DIFFERENT success event for the same order.
   * Its event_id is new, so the event claim cannot catch it. Only the
   * paid_side_effects_at claim stands in the way.
   */
  it("a second, distinct success event for the same order earns nothing more", async () => {
    await deliver("evt-1");
    await deliver("evt-2");

    expect(state.commissions.size).toBe(1);
    expect(state.referralInserts).toBe(1);
    expect(state.commissionUpserts).toBe(1);
    expect(commission()!.commission_amount).toBe(16);
    expect(sent.commissionEmails).toHaveLength(1);
  });

  it("neither does a third, or a fourth", async () => {
    for (const id of ["evt-1", "evt-2", "evt-3", "evt-4"]) await deliver(id);
    expect(state.commissions.size).toBe(1);
    expect(state.referralInserts).toBe(1);
    expect(sent.commissionEmails).toHaveLength(1);
  });

  /**
   * The regression that actually cost money once: a replay rewrote an
   * already-PAID commission back to "pending", re-entering it into the payout
   * pipeline. The guard must hold even if a caller reaches the record path
   * directly, so this bypasses the side-effects claim by clearing it.
   */
  it("never regresses a commission that has already been paid out", async () => {
    await deliver("evt-1");
    // The payout run happened: the ambassador has their $16.
    state.referralOrders.set(ORDER_ID, { ...state.referralOrders.get(ORDER_ID)!, payment_status: "paid" });
    state.commissions.set(ORDER_ID, { ...state.commissions.get(ORDER_ID)!, status: "paid" });
    state.sideEffectsClaimedAt = null; // as if the claim were lost

    await deliver("evt-2");

    expect(state.referralOrders.get(ORDER_ID)!.payment_status).toBe("paid");
    expect(state.commissions.get(ORDER_ID)!.status).toBe("paid");
    expect(state.commissions.size).toBe(1);
    expect(sent.commissionEmails).toHaveLength(1);
  });
});

describe("what does not earn", () => {
  /**
   * An ineligible order still gets a ROW, at zero, carrying the reason. An
   * absent row is indistinguishable from a bug; a zero row with a reason is an
   * answer the owner can read.
   */
  it("an ambassador deactivated after the order earns $0, with the reason recorded", async () => {
    state.ambassadorStatus = "suspended";
    await deliver("evt-1");

    expect(state.commissions.size).toBe(1);
    expect(commission()!.commission_amount).toBe(0);
    expect(commission()!.ineligible_reason).toBe("Ambassador is not active.");
    expect(sent.commissionEmails).toHaveLength(0);
  });

  it("earns $0 while the whole program is switched off", async () => {
    state.programEnabled = false;
    await deliver("evt-1");
    expect(commission()!.commission_amount).toBe(0);
    expect(commission()!.ineligible_reason).toBe("Referral program is disabled.");
  });

  it("earns $0 while commissions are paused, even though the program is on", async () => {
    state.commissionsPaused = true;
    await deliver("evt-1");
    expect(commission()!.commission_amount).toBe(0);
    expect(commission()!.ineligible_reason).toBe("Commissions are paused.");
  });

  /**
   * The minimum is checked against the PRE-discount subtotal — what checkout
   * gated on. A $200 cart that qualified must not be disqualified by its own
   * $40 referral discount dropping it to $160.
   */
  it("a cart that qualified at checkout is not disqualified by its own discount", async () => {
    state.minimumQualifyingOrder = 175;
    await deliver("evt-1");
    expect(commission()!.ineligible_reason).toBeNull();
    expect(commission()!.commission_amount).toBe(16);
  });

  it("but a genuinely small cart earns $0", async () => {
    state.minimumQualifyingOrder = 250;
    await deliver("evt-1");
    expect(commission()!.commission_amount).toBe(0);
    expect(String(commission()!.ineligible_reason)).toContain("minimum qualifying order");
  });

  it("an order with no ambassador creates no commission row at all", async () => {
    state.ambassadorId = null;
    state.referralCode = null;
    await deliver("evt-1");
    expect(state.commissions.size).toBe(0);
    expect(state.referralOrders.size).toBe(0);
  });

  /** Attribution needs both halves; half of one is not a referral. */
  it("an ambassador id with no code creates nothing", async () => {
    state.referralCode = null;
    await deliver("evt-1");
    expect(state.commissions.size).toBe(0);
  });

  it("a code with no ambassador creates nothing", async () => {
    state.ambassadorId = null;
    await deliver("evt-1");
    expect(state.commissions.size).toBe(0);
  });

  it("a failed payment never reaches the commission path", async () => {
    await deliver("evt-1", "payment.failed");
    expect(state.commissions.size).toBe(0);
  });

  it("a cancelled payment never reaches it either", async () => {
    await deliver("evt-1", "payment.canceled");
    expect(state.commissions.size).toBe(0);
  });
});

describe("the money is the order's own, not another's", () => {
  /**
   * Attribution is read from the persisted ORDER ROW, never from the provider's
   * echoed payload — a webhook body is attacker-influenced in a way the order
   * row is not. Ambassador B cannot be paid for Ambassador A's order by
   * claiming so in the event.
   */
  it("a payload naming a different ambassador cannot redirect the commission", async () => {
    const spoofed = JSON.stringify({
      type: "payment.succeeded",
      // normalizeOrderPayload reads attribution from the TOP level of the event,
      // beside the Veyra envelope — which is where a forged one would sit too.
      ambassadorId: AMBASSADOR_B,
      referralCode: "MINE-NOW",
      commissionPercent: 90,
      data: { object: { metadata: { order_id: ORDER_ID }, amount: 175 } },
    });

    await processPaymentWebhook(spoofed, "sig", "secret", "evt-1");

    expect(commission()!.partner_id).toBe(AMBASSADOR_A);
    expect(commission()!.referral_code).toBe("ELIJAH-AB78AE");
    expect(commission()!.commission_amount).toBe(16);
  });

  it("the two mirrors agree on the amount", async () => {
    await deliver("evt-1");
    expect(state.commissions.get(ORDER_ID)!.commission_amount).toBe(
      state.referralOrders.get(ORDER_ID)!.commission_amount,
    );
    expect(state.commissions.get(ORDER_ID)!.partner_id).toBe(
      state.referralOrders.get(ORDER_ID)!.ambassador_id,
    );
  });
});
