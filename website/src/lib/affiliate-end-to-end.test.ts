import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE WHOLE CHAIN, ONE AMBASSADOR, ONE ORDER, ONE PAYOUT.
//
// referral link -> correct partner -> her configured 15% -> remove the code ->
// reapply it -> no false $100 refusal -> checkout -> payment -> attribution ->
// exactly one commission at the configured rate -> what admin says is owed ->
// payout -> gone from owed, present exactly once in paid history.
//
// Every step runs the real function. The database is a stateful fake that
// enforces the constraints production actually has (unique order_id on both
// commission tables, and the atomic status claim payouts depend on), so a step
// cannot pass here by doing something postgres would refuse.
//
// MIZZY, exactly as production holds her: 15.00 customer discount, 15.00
// commission, rate locked, minimum qualifying order 100.
// ---------------------------------------------------------------------------

const AMB = "amb-mizzy";
const CODE = "MIZZY";
const ORDER = "order-e2e-1";

const CONFIG = {
  customerDiscountPercent: "15.00",
  commissionPercent: "15.00",
  minimumQualifyingOrder: 100,
  programDefaultDiscount: 10,
  programDefaultCommission: 10,
  minimumPayoutThreshold: 25,
};

/** Merchandise the shopper buys. Above her $100 minimum. */
const SUBTOTAL = 200;
const EXPECTED_DISCOUNT = 30;      // 15% of 200
const COMMISSIONABLE = 170;        // 200 - 30
const EXPECTED_COMMISSION = 25.5;  // 15% of 170

type Row = Record<string, unknown>;

const db = {
  referralOrders: new Map<string, Row>(),
  commissions: new Map<string, Row>(),
  payouts: [] as Row[],
  events: new Map<string, unknown>(),
  paidSideEffectsAt: null as string | null,
  paymentStatus: "pending_payment",
  ambassadorStatus: "approved",
  emails: [] as Array<{ to: string; subject: string }>,
  /** Write attempts, so "one row" is told apart from "written twice". */
  writes: { referralInsert: 0, referralUpdate: 0, commissionUpsert: 0 },
};

// ---------------------------------------------------------------------------
// Front half: what the shopper is shown, and what the server would charge.
// Both use the real resolvers; no mocking is needed for pure functions.
// ---------------------------------------------------------------------------
const { resolveAmbassadorCustomerDiscount } = await import("@/lib/ambassador-discount");
const { resolveCartDiscount } = await import("@/lib/discount-resolution");
const { resolveCustomerDiscount } = await import("@/lib/profit-engine");

/** The cart, given what the RPC now sends it. */
function cartShows(subtotal: number, rateFromRpc: unknown) {
  const percent = resolveAmbassadorCustomerDiscount(rateFromRpc, CONFIG.programDefaultDiscount);
  // Below the minimum the referral does not compete, because checkout refuses
  // the order outright rather than discounting it.
  const qualifies = subtotal >= CONFIG.minimumQualifyingOrder;
  return resolveCartDiscount({
    subtotal,
    quantityBundleSavings: 0,
    bulkSavingsAmount: 0,
    memberPricingAmount: 0,
    ambassadorPersonalAmount: 0,
    couponDiscountAmount: 0,
    promo: qualifies ? { type: "referral", amount: subtotal * (percent / 100) } : null,
  }).amount;
}

/** The server's authoritative customer discount for the same basket. */
function serverCharges(subtotal: number) {
  const percent = resolveAmbassadorCustomerDiscount(
    CONFIG.customerDiscountPercent,
    CONFIG.programDefaultDiscount,
  );
  return resolveCustomerDiscount(
    {
      subtotal, fullSubtotal: subtotal, quantityBundleSavings: 0, productCost: 0,
      bundleDiscount: 0, referralAccepted: true, referralPercent: percent,
      isMember: false, membershipPercent: 0, couponDiscount: 0,
      bulkSavingsAmount: 0, personalDiscountAmount: 0, allowCouponStacking: false,
      commissionPercent: 0, processingFeePercent: 0, shippingCollected: 0,
      shippingCost: 0, handlingCollected: 0, taxPercent: 0,
    },
    new Set(["coupon", "referral", "bundle", "membership"]),
  ).amount;
}

// ---------------------------------------------------------------------------
// Back half: the real payment webhook and the real payout writer.
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({ verifyWebhookSignature: () => true }) }));
vi.mock("@/lib/membership", () => ({
  calculateEarnedPoints: () => 0, getActivePointsMultiplier: async () => 1,
  getActivePointsPerDollar: async () => 1, recordPointsLedgerEntry: vi.fn(async () => {}),
  redeemPoints: vi.fn(async () => {}), restoreRedeemedPoints: vi.fn(async () => {}),
  reverseOrderPoints: vi.fn(async () => {}),
}));
vi.mock("@/lib/coupons", () => ({ redeemCoupon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string }) => { db.emails.push(m); return { success: true, ok: true }; }),
}));
vi.mock("@/lib/email/order-email-once", () => ({ sendOrderEmailOnce: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => ({ subject: "commission earned", html: "h" }),
  orderConfirmationTemplate: () => ({ subject: "order", html: "h" }),
  refundConfirmationTemplate: () => ({ subject: "refund", html: "h" }),
  ambassadorApplicationReceivedTemplate: () => ({ subject: "applied", html: "h" }),
  ambassadorApprovedTemplate: () => ({ subject: "approved", html: "h" }),
  ambassadorDeniedTemplate: () => ({ subject: "denied", html: "h" }),
  ambassadorPayoutSentTemplate: () => ({ subject: "payout sent", html: "h" }),
  newAmbassadorApplicationTemplate: () => ({ subject: "new application", html: "h" }),
  referralCodeAssignedTemplate: () => ({ subject: "Your Vanta Labs Referral Code Is Ready", html: "h" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })), restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ ok: true, finalized: 1, degraded: false })),
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  // Her rate is LOCKED in production, so tiers never override it.
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: Number(CONFIG.commissionPercent), tierName: null })),
  detectCommissionFraudSignal: vi.fn(async () => ({ flagged: false, reason: null })),
}));
vi.mock("@/lib/shippo/order-sync", () => ({ syncOrderToShippo: vi.fn(async () => {}) }));
vi.mock("@/lib/store-credit", () => ({ redeemStoreCredit: vi.fn(async () => {}), refundStoreCreditForOrder: vi.fn(async () => {}) }));
vi.mock("@/lib/membership-billing", () => ({ activatePaidMembership: vi.fn(async () => {}), revokeMembershipForRefund: vi.fn(async () => {}) }));
vi.mock("@/lib/cart-recovery", () => ({ markAbandonedCartsRecovered: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: CONFIG.minimumQualifyingOrder,
    minimumPayoutThreshold: CONFIG.minimumPayoutThreshold,
    commissionHoldDays: 14,
  }),
  getAmbassadorMarketingResources: async () => [],
}));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "support@example.test" }),
  getReferralProgramConfig: async () => ({
    enabled: true, commissionsPaused: false,
    defaultCommissionPercent: CONFIG.programDefaultCommission,
    discountPercent: CONFIG.programDefaultDiscount,
    personalDiscountPercent: 20,
  }),
}));

vi.mock("@/lib/supabase-server", () => {
  const orderRow = () => ({
    id: "row-1", order_id: ORDER, order_number: "VL-E2E0001", order_type: "product",
    payment_status: db.paymentStatus, fulfillment_status: "pending", payment_method: "card",
    customer_email: "shopper@example.test", customer_name: "A Shopper", customer_user_id: "user-shopper",
    referral_code: CODE, ambassador_id: AMB, coupon_code: null,
    subtotal: SUBTOTAL, shipping_amount: 15, discount_amount: EXPECTED_DISCOUNT, tax_amount: 0,
    card_processing_fee: 0, amount_paid: SUBTOTAL - EXPECTED_DISCOUNT + 15, refund_amount: 0, paid_at: null,
    shipping_address: "1 Test St", city: "Denver", postal_code: "80202",
    points_redeemed: 0, store_credit_redeemed_cents: 0, membership_tier_id: null, membership_cycle: null,
    order_items: [{ id: 1, product_id: "p1", product_name: "Item", quantity: 1 }],
  });

  /** A commission table with a real UNIQUE(order_id), as production has. */
  function ledger(store: Map<string, Row>, tally: { insert: () => void; update: () => void; upsert: () => void }) {
    return {
      select: () => {
        const f: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          eq(c: string, v: unknown) { f[c] = v; return b; },
          in(c: string, v: unknown[]) { f[`in:${c}`] = v; return b; },
          // ORDER AND RANGE, so a PAGED read can be modelled here at all.
          //
          // Without these the double answers eq/in/maybeSingle and nothing
          // else, so any caller that pages — `.order("id").range(from, to)`,
          // which is how every other financial read in this codebase reaches
          // past PostgREST's 1,000-row cap — dies with "order is not a
          // function". That is a limit of the double, not of the code under
          // test, and it blocked the F-A-10 paging fix until this landed.
          //
          // `order` sorts the filtered rows; `range` slices them inclusively,
          // matching PostgREST. Both keep returning the builder so the chain
          // composes in any order.
          order(c: string, opts?: { ascending?: boolean }) {
            f[`order:${c}`] = opts?.ascending === false ? "desc" : "asc";
            return b;
          },
          range(from: number, to: number) { f["range"] = [from, to]; return b; },
          async maybeSingle() { return { data: store.get(String(f.order_id)) ?? null, error: null }; },
          then(res: (v: unknown) => unknown) {
            let rows = [...store.values()].filter((r) => Object.entries(f).every(([k, v]) => {
              if (k.startsWith("in:")) return (v as unknown[]).includes(r[k.slice(3)]);
              if (k.startsWith("order:") || k === "range") return true;
              return r[k] === v;
            }));

            const orderKey = Object.keys(f).find((k) => k.startsWith("order:"));
            if (orderKey) {
              const col = orderKey.slice(6);
              const dir = f[orderKey] === "desc" ? -1 : 1;
              rows = [...rows].sort((x, y) =>
                String(x[col] ?? "") < String(y[col] ?? "") ? -dir
                  : String(x[col] ?? "") > String(y[col] ?? "") ? dir : 0);
            }

            const range = f["range"] as [number, number] | undefined;
            if (range) rows = rows.slice(range[0], range[1] + 1);

            return Promise.resolve(res({ data: rows, error: null }));
          },
        };
        return b;
      },
      insert(row: Row) {
        tally.insert();
        const key = String(row.order_id);
        const dup = store.has(key);
        if (!dup) store.set(key, { id: `${key}-r`, ...row });
        const env = dup
          ? { data: null, error: { code: "23505", message: "duplicate key" } }
          : { data: { id: `${key}-r` }, error: null };
        const b: Record<string, unknown> = {
          select() { return b; }, async single() { return env; },
          then(res: (v: unknown) => unknown) { return Promise.resolve(res(env)); },
        };
        return b;
      },
      async upsert(row: Row, opts?: { onConflict?: string }) {
        tally.upsert();
        const key = String(row.order_id);
        if (opts?.onConflict !== "order_id" && store.has(key)) {
          return { error: { code: "23505", message: "duplicate key" } };
        }
        store.set(key, { ...(store.get(key) ?? {}), id: `${key}-r`, ...row });
        return { error: null };
      },
      update(payload: Row) {
        tally.update();
        const f: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          eq(c: string, v: unknown) { f[c] = v; return apply(); },
          in(c: string, v: unknown[]) { f[`in:${c}`] = v; return apply(); },
          select() { return apply(true); },
        };
        function matches(r: Row) {
          return Object.entries(f).every(([k, v]) =>
            k.startsWith("in:") ? (v as unknown[]).includes(r[k.slice(3)]) : r[k] === v);
        }
        function apply(returning = false): Record<string, unknown> {
          const chain: Record<string, unknown> = {
            eq(c: string, v: unknown) { f[c] = v; return chain; },
            in(c: string, v: unknown[]) { f[`in:${c}`] = v; return chain; },
            select() { returning = true; return chain; },
            then(res: (v: unknown) => unknown) {
              const hit = [...store.values()].filter(matches);
              for (const r of hit) store.set(String(r.order_id), { ...r, ...payload });
              return Promise.resolve(res({ data: returning ? hit.map((r) => ({ ...r, ...payload })) : null, error: null }));
            },
          };
          return chain;
        }
        return b;
      },
    };
  }

  const from = (table: string) => {
    if (table === "payment_events") {
      return {
        insert: async (row: Row) => {
          const id = String(row.event_id);
          if (db.events.has(id)) return { error: { code: "23505", message: "duplicate key" } };
          db.events.set(id, { processed_at: null, claimed_at: String(row.claimed_at) });
          return { error: null };
        },
        upsert: async () => ({ error: null }),
        select: () => { let id = ""; const b: Record<string, unknown> = { eq(_c: string, v: string) { id = v; return b; }, async maybeSingle() { return { data: db.events.get(id) ?? null, error: null }; } }; return b; },
        update: () => { let id = ""; const b: Record<string, unknown> = { eq(_c: string, v: string) { id = v; return b; }, is() { return b; }, lt() { return b; }, async select() { return db.events.has(id) ? { data: [{ event_id: id }], error: null } : { data: [], error: null }; } }; return b; },
        delete: () => ({ eq: async (_c: string, v: string) => { db.events.delete(v); return { error: null }; } }),
      };
    }
    if (table === "orders") {
      return {
        select: () => { const b: Record<string, unknown> = { eq() { return b; }, limit() { return b; }, order() { return b; }, async maybeSingle() { return { data: orderRow(), error: null }; } }; return b; },
        update: () => {
          const filters: Array<[string, unknown]> = [];
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push([c, v]); return b; },
            neq(c: string, v: unknown) { filters.push([`neq:${c}`, v]); return b; },
            is(c: string, v: unknown) { filters.push([`is:${c}`, v]); return b; },
            select() { return b; },
            then(res: (v: { data: unknown; error: null }) => unknown) { return Promise.resolve(res(settle())); },
          };
          function settle() {
            if (filters.some(([c]) => c === "is:paid_side_effects_at")) {
              if (db.paidSideEffectsAt !== null) return { data: [], error: null };
              db.paidSideEffectsAt = new Date().toISOString();
              return { data: [{ id: "row-1" }], error: null };
            }
            const notPaid = filters.find(([c]) => c === "neq:payment_status");
            if (notPaid) {
              if (db.paymentStatus === notPaid[1]) return { data: [], error: null };
              db.paymentStatus = "paid";
              return { data: [{ id: "row-1" }], error: null };
            }
            return { data: [{ id: "row-1" }], error: null };
          }
          return b;
        },
      };
    }
    if (table === "referral_orders") return ledger(db.referralOrders, { insert: () => { db.writes.referralInsert += 1; }, update: () => { db.writes.referralUpdate += 1; }, upsert: () => {} });
    if (table === "commissions") return ledger(db.commissions, { insert: () => {}, update: () => {}, upsert: () => { db.writes.commissionUpsert += 1; } });
    if (table === "ambassadors" || table === "partners") {
      return {
        select: () => ({
          eq: () => ({
            async maybeSingle() {
              return { data: {
                id: AMB, name: "Jaeley Reynolds", email: "amb@example.test",
                status: db.ambassadorStatus,
                customer_discount_percent: CONFIG.customerDiscountPercent,
                commission_percent: CONFIG.commissionPercent,
                payout_method: "paypal", payout_handle: "amb@example.test",
              }, error: null };
            },
            in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })) }),
          }),
          in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [{ id: AMB, name: "Jaeley Reynolds", payout_method: "paypal", payout_handle: "amb@example.test", status: db.ambassadorStatus }], error: null })) }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "partner_payouts") {
      return {
        insert: (row: Row) => { db.payouts.push(row); return { select: () => ({ single: async () => ({ data: { id: row.id }, error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })) }; },
        select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: db.payouts, error: null }) }) }), order: () => ({ limit: async () => ({ data: db.payouts, error: null }) }) }),
      };
    }
    const noop: Record<string, unknown> = {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), order: () => ({ limit: async () => ({ data: [], error: null }) }), in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })) }) }), in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })) }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })) }),
      update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
    return noop;
  };
  return { supabaseAdmin: { from } };
});

const { processPaymentWebhook } = await import("@/lib/payment-webhook");

async function payFor(eventId: string) {
  const body = JSON.stringify({ type: "payment.succeeded", data: { object: { metadata: { order_id: ORDER }, amount: 185 } } });
  return processPaymentWebhook(body, "sig", "secret", eventId);
}

/** What admin says is owed: approved-for-payout rows, the payout queue's source. */
function amountOwed(): number {
  let total = 0;
  for (const row of db.referralOrders.values()) {
    if (row.payment_status === "approved_for_payout") total += Number(row.commission_amount ?? 0);
  }
  return Math.round(total * 100) / 100;
}

function paidHistory(): Row[] {
  return [...db.referralOrders.values()].filter((r) => r.payment_status === "paid");
}

beforeEach(() => {
  db.referralOrders.clear(); db.commissions.clear(); db.payouts.length = 0;
  db.events.clear(); db.paidSideEffectsAt = null; db.paymentStatus = "pending_payment";
  db.ambassadorStatus = "approved"; db.emails.length = 0;
  db.writes.referralInsert = 0; db.writes.referralUpdate = 0; db.writes.commissionUpsert = 0;
  vi.clearAllMocks();
});

// ===========================================================================
describe("1. the link resolves to the right partner at the right rate", () => {
  it("her 15% reaches the cart, not the program's 10%", () => {
    expect(cartShows(SUBTOTAL, CONFIG.customerDiscountPercent)).toBe(EXPECTED_DISCOUNT);
  });

  it("cart and server agree to the cent", () => {
    expect(cartShows(SUBTOTAL, CONFIG.customerDiscountPercent)).toBe(serverCharges(SUBTOTAL));
  });
});

describe("2. remove the code, reapply it, same answer", () => {
  it("applying by link and by typing give identical discounts", () => {
    const viaLink = cartShows(SUBTOTAL, CONFIG.customerDiscountPercent);
    const removed = cartShows(SUBTOTAL, null) === 20; // program default only, if the code were gone
    const viaTyping = cartShows(SUBTOTAL, CONFIG.customerDiscountPercent);
    expect(viaLink).toBe(EXPECTED_DISCOUNT);
    expect(viaTyping).toBe(EXPECTED_DISCOUNT);
    expect(removed).toBe(true); // sanity: removing really does change the answer
  });

  it("no false $100 refusal on a qualifying basket", () => {
    expect(SUBTOTAL).toBeGreaterThanOrEqual(CONFIG.minimumQualifyingOrder);
    expect(cartShows(SUBTOTAL, CONFIG.customerDiscountPercent)).toBeGreaterThan(0);
  });

  it("and the minimum still holds below it, matching what checkout enforces", () => {
    expect(cartShows(50, CONFIG.customerDiscountPercent)).toBe(0);
  });
});

describe("3. payment creates exactly one commission at the configured rate", () => {
  it("one delivery, one commission, $25.50", async () => {
    await payFor("evt-1");

    expect(db.referralOrders.size).toBe(1);
    expect(db.commissions.size).toBe(1);
    const row = db.referralOrders.get(ORDER)!;
    expect(row.ambassador_id).toBe(AMB);
    expect(row.referral_code).toBe(CODE);
    expect(row.commission_percent).toBe(15);
    expect(row.commission_amount).toBe(EXPECTED_COMMISSION);
    expect(row.amount_paid).toBe(COMMISSIONABLE);
    expect(row.ineligible_reason).toBeNull();
  });

  it("commission is on discounted merchandise — never shipping or tax", async () => {
    await payFor("evt-1");
    // 15% of the $185 charged would be $27.75; of the $200 gross, $30.
    expect(db.referralOrders.get(ORDER)!.commission_amount).toBe(EXPECTED_COMMISSION);
    expect(db.referralOrders.get(ORDER)!.commission_amount).not.toBe(27.75);
    expect(db.referralOrders.get(ORDER)!.commission_amount).not.toBe(30);
  });

  it("the ambassador is notified once", async () => {
    await payFor("evt-1");
    expect(db.emails.filter((e) => e.subject === "commission earned")).toHaveLength(1);
  });
});

describe("4. duplicate and concurrent webhooks never pay twice", () => {
  it("a redelivery of the same event changes nothing", async () => {
    await payFor("evt-1");
    const again = await payFor("evt-1");
    expect(again).toMatchObject({ duplicate: true });
    expect(db.referralOrders.size).toBe(1);
    expect(db.referralOrders.get(ORDER)!.commission_amount).toBe(EXPECTED_COMMISSION);
  });

  it("a SECOND, DIFFERENT success event adds no second commission", async () => {
    await payFor("evt-1");
    await payFor("evt-2");
    expect(db.referralOrders.size).toBe(1);
    expect(db.commissions.size).toBe(1);
    expect(db.emails.filter((e) => e.subject === "commission earned")).toHaveLength(1);
    // Row COUNT alone cannot catch a second pass: it would find the existing
    // row and take the update branch, leaving one row with the same figure.
    // The write tally is what proves the side-effects claim actually held.
    expect(db.writes.referralInsert).toBe(1);
    expect(db.writes.referralUpdate).toBe(0);
    expect(db.writes.commissionUpsert).toBe(1);
  });

  it("four concurrent deliveries still produce one commission, and one write", async () => {
    await Promise.all([payFor("c-1"), payFor("c-2"), payFor("c-3"), payFor("c-4")]);
    expect(db.referralOrders.size).toBe(1);
    expect(db.commissions.size).toBe(1);
    expect(db.referralOrders.get(ORDER)!.commission_amount).toBe(EXPECTED_COMMISSION);
    expect(db.writes.referralInsert).toBe(1);
    expect(db.writes.commissionUpsert).toBe(1);
  });
});

describe("5. what admin says is owed", () => {
  it("a fresh commission is pending, not yet owed", async () => {
    await payFor("evt-1");
    expect(db.referralOrders.get(ORDER)!.payment_status).toBe("pending");
    expect(amountOwed()).toBe(0);
  });

  it("once approved for payout it is owed, exactly once", async () => {
    await payFor("evt-1");
    const row = db.referralOrders.get(ORDER)!;
    db.referralOrders.set(ORDER, { ...row, payment_status: "approved_for_payout", approved_for_payout_at: new Date().toISOString() });

    expect(amountOwed()).toBe(EXPECTED_COMMISSION);
    expect(paidHistory()).toHaveLength(0);
  });
});

describe("6. payout removes it from owed and records it once", () => {
  async function approveAndPay() {
    await payFor("evt-1");
    const row = db.referralOrders.get(ORDER)!;
    db.referralOrders.set(ORDER, { ...row, payment_status: "approved_for_payout", approved_for_payout_at: new Date().toISOString() });
    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    return markCommissionsPaid({
      partnerId: AMB, amount: EXPECTED_COMMISSION, confirmedTransferred: true,
      overrideMinimumThreshold: true, actorUsername: "owner",
    });
  }

  it("pays the exact amount owed", async () => {
    const result = await approveAndPay();
    expect(result.amount).toBe(EXPECTED_COMMISSION);
    expect(result.orderCount).toBe(1);
  });

  it("owed drops to zero and paid history holds it exactly once", async () => {
    await approveAndPay();
    expect(amountOwed()).toBe(0);
    expect(paidHistory()).toHaveLength(1);
    expect(paidHistory()[0].commission_amount).toBe(EXPECTED_COMMISSION);
  });


  // BLOCK E / E-03 — the boundary this suite never crossed.
  //
  // Mutation testing found that changing markCommissionsPaid's status filter from
  //     .in("payment_status", ["approved_for_payout"])
  // to  .in("payment_status", ["approved_for_payout", "pending"])
  // left the ENTIRE 3,593-test suite green. This suite drives the real function,
  // but its fixture never held a commission still inside its hold period, so
  // widening the filter changed nothing it could observe.
  //
  // A payout that also sweeps up `pending` commissions pays an ambassador for
  // orders that can still be refunded — the hold period exists precisely to stop
  // that, and it is worthless if the payout query ignores it.
  it("pays only what is approved, leaving commissions still inside the hold period alone", async () => {
    await payFor("evt-1");
    const row = db.referralOrders.get(ORDER)!;
    db.referralOrders.set(ORDER, { ...row, payment_status: "approved_for_payout", approved_for_payout_at: new Date().toISOString() });

    // A second commission for the same ambassador, still held.
    const HELD = "order-e2e-held";
    db.referralOrders.set(HELD, {
      ...row,
      id: `${HELD}-r`,
      order_id: HELD,
      payment_status: "pending",
      approved_for_payout_at: null,
      commission_amount: 60,
    });

    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    const result = await markCommissionsPaid({
      partnerId: AMB, amount: EXPECTED_COMMISSION, confirmedTransferred: true,
      overrideMinimumThreshold: true, actorUsername: "owner",
    });

    // The approved one, and only the approved one.
    expect(result.amount).toBe(EXPECTED_COMMISSION);
    expect(result.orderCount).toBe(1);

    // The held one is untouched and still owed to nobody yet.
    expect(db.referralOrders.get(HELD)!.payment_status).toBe("pending");
    expect(paidHistory()).toHaveLength(1);
    expect(paidHistory()[0].order_id).toBe(ORDER);
  });

  it("the display mirror is flipped to paid as well", async () => {
    await approveAndPay();
    expect(db.commissions.get(ORDER)!.status).toBe("paid");
  });

  /** The double-click. The atomic claim must make the second call a no-op. */
  it("a second payout claims nothing and pays nothing", async () => {
    await approveAndPay();
    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    const second = await markCommissionsPaid({
      partnerId: AMB, amount: EXPECTED_COMMISSION, confirmedTransferred: true,
      overrideMinimumThreshold: true, actorUsername: "owner",
    });
    expect(second.amount).toBe(0);
    expect(second.orderCount).toBe(0);
    expect(paidHistory()).toHaveLength(1);
  });

  /**
   * TRUE concurrency, not a sequential double-click. Two admins pressing at the
   * same moment both pass the pending SELECT, so only the atomic status claim
   * on the UPDATE stands between them and paying twice.
   */
  it("two simultaneous payouts pay once between them", async () => {
    await payFor("evt-1");
    const row = db.referralOrders.get(ORDER)!;
    db.referralOrders.set(ORDER, { ...row, payment_status: "approved_for_payout", approved_for_payout_at: new Date().toISOString() });

    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    const call = () => markCommissionsPaid({
      partnerId: AMB, amount: EXPECTED_COMMISSION, confirmedTransferred: true,
      overrideMinimumThreshold: true, actorUsername: "owner",
    });
    const [a, b] = await Promise.all([call(), call()]);

    const totalPaid = a.amount + b.amount;
    expect(totalPaid).toBe(EXPECTED_COMMISSION);
    expect([a.orderCount, b.orderCount].sort()).toEqual([0, 1]);
    expect(paidHistory()).toHaveLength(1);
    expect(amountOwed()).toBe(0);
  });

  /**
   * The amount must come from the commissions actually owed. A caller-supplied
   * figure would let an admin flip $25.50 of commission to paid while recording
   * a $1 payout — or the reverse.
   */
  it("ignores a caller-supplied amount and pays what is owed", async () => {
    await payFor("evt-1");
    const row = db.referralOrders.get(ORDER)!;
    db.referralOrders.set(ORDER, { ...row, payment_status: "approved_for_payout", approved_for_payout_at: new Date().toISOString() });

    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    const result = await markCommissionsPaid({
      partnerId: AMB, amount: 1, confirmedTransferred: true,
      overrideMinimumThreshold: true, actorUsername: "owner",
    });

    expect(result.amount).toBe(EXPECTED_COMMISSION);
    expect(result.amount).not.toBe(1);
  });

  it("refuses to record a payout without confirming the transfer happened", async () => {
    await payFor("evt-1");
    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    await expect(markCommissionsPaid({
      partnerId: AMB, amount: EXPECTED_COMMISSION, overrideMinimumThreshold: true,
    })).rejects.toThrow(/confirm the transfer/i);
  });
});

describe("7. money reconciles across all three views", () => {
  it("customer paid, ambassador earned, store kept — one arithmetic", async () => {
    await payFor("evt-1");

    const customerMerchandise = SUBTOTAL - EXPECTED_DISCOUNT;   // 170
    const commission = Number(db.referralOrders.get(ORDER)!.commission_amount); // 25.50

    expect(customerMerchandise).toBe(COMMISSIONABLE);
    expect(commission).toBe(Math.round(customerMerchandise * 0.15 * 100) / 100);
    // The base the ambassador is paid on is exactly what the customer paid for
    // goods — not the gross, and not the card total including shipping.
    expect(db.referralOrders.get(ORDER)!.amount_paid).toBe(customerMerchandise);
  });
});
