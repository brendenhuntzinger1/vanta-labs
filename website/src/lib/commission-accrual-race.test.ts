import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE ELIGIBLE REFERRAL CONVERSION -> AT MOST ONE COMMISSION OBLIGATION.
//
// The 30-minute `commissionAccrualRepair` sweep and the live payment webhook
// both reach `ensureCommissionRecord`, which is SELECT-then-INSERT
// (payment-webhook.ts:792-800 then :879). Under real concurrency both readers
// can see no row and BOTH take the INSERT branch. Application idempotency
// cannot close that; only the database can.
//
// It IS closed, at the database:
//
//     referral_orders_order_id_key   UNIQUE (order_id)
//
// declared inline on the column in every create-table in src/lib/sql
// (deploy-run-once.sql:315, orders-schema.sql:46, partner-system-repair.sql:404,
// schema-complete-sync.sql:333 and :468) and read back off live Postgres in
// docs/FINAL-VERIFICATION-LOG.md:257. `idx_referral_orders_order_id` is a
// SEPARATE, non-unique index; reading only that one is what makes this race
// look reachable when it is not.
//
// WHY THIS FILE EXISTS AND commission-accrual-recovery.test.ts DOES NOT COVER
// IT. That suite's referral_orders double accepts EVERY insert, so it cannot
// tell a world with the unique key from a world without it — the exact "stale
// fixture that does not match the production schema" hazard. The double here
// enforces the constraint, and `constraints.uniqueOrderId` can switch it off so
// the mutation control has something real to break.
//
// The money at stake: markCommissionsPaid (partner-portal.ts:1890-1944) sums
// commission_amount across ALL of an ambassador's approved_for_payout rows. Two
// rows for one order is a payout of double the commission.
// ---------------------------------------------------------------------------

const ORDER_ID = "VL-RACE-1";
const AMBASSADOR_ID = "amb-race-1";

type Row = Record<string, unknown>;

const constraints = { uniqueOrderId: true };

const db: {
  orders: Row[];
  referralOrders: Row[];
  commissions: Row[];
  insertAttempts: number;
  rejections: string[];
  commissionEmails: number;
  alerts: Row[];
} = {
  orders: [],
  referralOrders: [],
  commissions: [],
  insertAttempts: 0,
  rejections: [],
  commissionEmails: 0,
  alerts: [],
};

/**
 * Parks a caller inside `ensureCommissionRecord`'s existence probe so two
 * writers can be held there at once. Without this the single-threaded test
 * runner would serialise them and the interleaving under test would never
 * actually occur.
 */
const gate = {
  armed: false,
  waiting: [] as Array<() => void>,
  async pause() {
    if (!this.armed) return;
    await new Promise<void>((resolve) => { this.waiting.push(resolve); });
  },
  release() {
    this.armed = false;
    const parked = this.waiting;
    this.waiting = [];
    for (const resume of parked) resume();
  },
  async waitFor(count: number) {
    for (let i = 0; i < 500 && this.waiting.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (this.waiting.length < count) {
      throw new Error(`only ${this.waiting.length}/${count} writers reached the existence probe`);
    }
  },
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn; } }));
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
vi.mock("@/lib/email/order-emails", () => ({
  sendOrderEmailOnce: vi.fn(async () => ({ attempted: false, sent: false, error: null })),
}));
vi.mock("@/lib/email/templates", () => ({
  commissionEarnedTemplate: () => { db.commissionEmails += 1; return { subject: "s", html: "h", text: "t" }; },
  orderConfirmationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
  refundConfirmationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
}));
vi.mock("@/lib/inventory-fulfillment", () => ({
  decrementInventoryForOrder: vi.fn(async () => ({ attempted: 0, failed: 0, errors: [] as string[] })),
  restockInventoryForOrder: vi.fn(async () => {}),
  claimInventoryRestock: vi.fn(async () => true),
}));
vi.mock("@/lib/inventory-reservation", () => ({
  finalizeInventoryForOrder: vi.fn(async () => ({ finalized: 1, degraded: false })),
  releaseInventoryForOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/ambassador-commission", () => ({
  getEffectiveCommissionPercent: vi.fn(async () => ({ percent: 15, tierName: "base" })),
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
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: vi.fn(async (alert: Row) => { db.alerts.push(alert); }),
}));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    enabled: true, minimumQualifyingOrder: 0, commissionHoldDays: 14, minimumPayoutThreshold: 0,
  }),
}));
vi.mock("@/lib/admin-control", () => ({
  getReferralProgramConfig: async () => ({
    enabled: true, commissionsPaused: false, defaultCommissionPercent: 15,
    discountPercent: 10, personalDiscountPercent: 10,
  }),
}));
vi.mock("@/lib/ambassador-discount", () => ({ resolveAmbassadorCustomerDiscount: () => 10 }));
vi.mock("@/lib/order-attribution", () => ({ getOrderAttribution: async () => null }));
vi.mock("@/lib/attribution", () => ({ toAnalyticsAttribution: () => ({}) }));
vi.mock("@/lib/analytics-events", () => ({ logCommerceAnalyticsEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/supabase-server", () => {
  type Pred = (row: Row) => boolean;

  function select(rows: () => Row[], table: string) {
    const preds: Pred[] = [];
    let take: number | null = null;
    const matched = () => {
      const hit = rows().filter((row) => preds.every((p) => p(row)));
      return (take == null ? hit : hit.slice(0, take)).map((row) => ({ ...row }));
    };
    const b: Record<string, unknown> = {
      eq(c: string, v: unknown) { preds.push((r) => String(r[c] ?? "") === String(v)); return b; },
      not(c: string) { preds.push((r) => r[c] != null); return b; },
      gte(c: string, v: unknown) { preds.push((r) => r[c] != null && String(r[c]) >= String(v)); return b; },
      in(c: string, vs: unknown[]) { preds.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      order() { return b; },
      limit(n: number) { take = n; return b; },
      async maybeSingle() {
        // The ONE await point that decides this race.
        if (table === "referral_orders") await gate.pause();
        const hit = matched();
        if (hit.length > 1) {
          return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
        }
        return { data: hit[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ data: matched(), error: null }).then(resolve);
      },
    };
    return b;
  }

  function update(rows: () => Row[], patch: Row) {
    const preds: Pred[] = [];
    const apply = () => {
      const hit = rows().filter((row) => preds.every((p) => p(row)));
      for (const row of hit) Object.assign(row, patch);
      return { data: hit.map((row) => ({ ...row })), error: null };
    };
    const b: Record<string, unknown> = {
      eq(c: string, v: unknown) { preds.push((r) => String(r[c] ?? "") === String(v)); return b; },
      in(c: string, vs: unknown[]) { preds.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      select() { return { then: (res: (v: unknown) => unknown) => Promise.resolve(apply()).then(res) }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(apply()).then(resolve); },
    };
    return b;
  }

  const from = (table: string): Record<string, unknown> => {
    if (table === "orders") {
      return { select: () => select(() => db.orders, table), update: (p: Row) => update(() => db.orders, p) };
    }

    if (table === "referral_orders") {
      return {
        select: () => select(() => db.referralOrders, table),
        update: (p: Row) => update(() => db.referralOrders, p),
        insert: (row: Row) => {
          db.insertAttempts += 1;
          // referral_orders_order_id_key, verbatim in behaviour.
          if (constraints.uniqueOrderId
            && db.referralOrders.some((r) => String(r.order_id) === String(row.order_id))) {
            const error = {
              code: "23505",
              message: 'duplicate key value violates unique constraint "referral_orders_order_id_key"',
              details: `Key (order_id)=(${String(row.order_id)}) already exists.`,
            };
            db.rejections.push(error.code);
            return { select: () => ({ single: async () => ({ data: null, error }) }) };
          }
          const stored = { ...row, id: `ro-${db.referralOrders.length + 1}` };
          db.referralOrders.push(stored);
          return { select: () => ({ single: async () => ({ data: { id: stored.id }, error: null }) }) };
        },
      };
    }

    if (table === "commissions") {
      return {
        select: () => select(() => db.commissions, table),
        update: (p: Row) => update(() => db.commissions, p),
        upsert: async (row: Row) => {
          const found = db.commissions.find((r) => String(r.order_id) === String(row.order_id));
          if (found) Object.assign(found, row);
          else db.commissions.push({ ...row });
          return { error: null };
        },
      };
    }

    if (table === "ambassadors") {
      return {
        select: () => select(
          () => [{ id: AMBASSADOR_ID, status: "approved", customer_discount_percent: 10 }],
          table,
        ),
      };
    }
    if (table === "partners") {
      return {
        select: () => select(
          () => [{ id: AMBASSADOR_ID, name: "Amb", email: "amb@example.test" }],
          table,
        ),
      };
    }

    return {
      select: () => select(() => [], table),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
  };

  return { supabaseAdmin: { from } };
});

function seedPaidReferredOrder() {
  db.orders.push({
    id: "row-1",
    order_id: ORDER_ID,
    payment_status: "paid",
    ambassador_id: AMBASSADOR_ID,
    referral_code: "AMB15",
    subtotal: 200,
    discount_amount: 20,
    customer_email: "buyer@example.test",
    shipping_address: "1 Test St",
    city: "Testville",
    postal_code: "00000",
    paid_at: "2026-08-26T00:00:00.000Z",
  });
}

async function webhookAccrual() {
  const { accrueCommissionForPaidOrder } = await import("@/lib/payment-webhook");
  return accrueCommissionForPaidOrder(db.orders[0] as never);
}

async function sweep() {
  const { repairMissingCommissionAccruals } = await import("@/lib/commission-accrual-repair");
  return repairMissingCommissionAccruals();
}

/** Exactly what markCommissionsPaid would hand the ambassador. */
function obligationDollars() {
  return db.referralOrders
    .filter((r) => String(r.order_id) === ORDER_ID)
    .reduce((sum, r) => sum + Number(r.commission_amount ?? 0), 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  constraints.uniqueOrderId = true;
  db.orders = [];
  db.referralOrders = [];
  db.commissions = [];
  db.insertAttempts = 0;
  db.rejections = [];
  db.commissionEmails = 0;
  db.alerts = [];
  gate.armed = false;
  gate.waiting = [];
});

describe("the double models the constraint this all rests on", () => {
  it("refuses a second referral_orders row for the same order_id", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    const row = { order_id: ORDER_ID, payment_status: "pending", commission_amount: 27 };
    await supabaseAdmin.from("referral_orders").insert(row).select("id").single();
    const second = await supabaseAdmin.from("referral_orders").insert(row).select("id").single();
    expect(second.error).toMatchObject({ code: "23505" });
    expect(db.referralOrders).toHaveLength(1);
  });

  it("and drops the constraint when the mutation switch says so", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    constraints.uniqueOrderId = false;
    const row = { order_id: ORDER_ID, payment_status: "pending", commission_amount: 27 };
    await supabaseAdmin.from("referral_orders").insert(row).select("id").single();
    const second = await supabaseAdmin.from("referral_orders").insert(row).select("id").single();
    expect(second.error).toBeNull();
    expect(db.referralOrders).toHaveLength(2);
  });
});

describe("webhook and sweep racing on the same paid referred order", () => {
  it("both take the INSERT branch and only ONE commission obligation survives", async () => {
    seedPaidReferredOrder();
    gate.armed = true;

    const webhook = webhookAccrual();
    const repair = sweep();
    // Both are now parked inside the existence probe, each seeing no row.
    await gate.waitFor(2);
    gate.release();
    const [, repaired] = await Promise.all([webhook, repair]);

    // The race really happened: two INSERTs were attempted.
    expect(db.insertAttempts).toBe(2);
    // The database refused the second.
    expect(db.rejections).toEqual(["23505"]);

    // THE INVARIANT.
    expect(db.referralOrders.filter((r) => String(r.order_id) === ORDER_ID)).toHaveLength(1);
    expect(obligationDollars()).toBeCloseTo(27, 2); // 15% of (200 - 20), once.
    expect(db.commissionEmails).toBe(1);

    // The sweep accounts for the loss honestly and does NOT cry wolf.
    expect(repaired.repaired + repaired.converged).toBe(1);
    expect(repaired.failed).toBe(0);
    expect(db.alerts.filter((a) => a.type === "commission_accrual_unrecovered")).toHaveLength(0);
  });

  it("two sweep workers on the same order behave identically", async () => {
    seedPaidReferredOrder();
    gate.armed = true;

    const a = sweep();
    const b = sweep();
    await gate.waitFor(2);
    gate.release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(db.insertAttempts).toBe(2);
    expect(db.rejections).toEqual(["23505"]);
    expect(db.referralOrders).toHaveLength(1);
    expect(obligationDollars()).toBeCloseTo(27, 2);
    expect(db.commissionEmails).toBe(1);
    expect(ra.repaired + rb.repaired).toBe(1);
    expect(ra.converged + rb.converged).toBe(1);
    expect(ra.failed + rb.failed).toBe(0);
    expect(db.alerts).toHaveLength(0);
  });

  it("sequential retries in either order still leave exactly one", async () => {
    seedPaidReferredOrder();
    await webhookAccrual();
    await sweep();
    await webhookAccrual();
    await sweep();
    expect(db.referralOrders).toHaveLength(1);
    expect(obligationDollars()).toBeCloseTo(27, 2);
    expect(db.commissionEmails).toBe(1);
  });

  it("never regresses an already-paid commission back into the payout queue", async () => {
    seedPaidReferredOrder();
    await webhookAccrual();
    db.referralOrders[0].payment_status = "paid";

    await webhookAccrual();
    await sweep();

    expect(db.referralOrders).toHaveLength(1);
    expect(db.referralOrders[0].payment_status).toBe("paid");
    expect(db.commissionEmails).toBe(1);
  });
});

describe("the critical alert still means what it says", () => {
  it("a genuine, non-race failure is reported WITH its diagnosis", async () => {
    seedPaidReferredOrder();
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    const realFrom = supabaseAdmin.from;
    const spy = vi.spyOn(supabaseAdmin, "from").mockImplementation(((table: string) => {
      if (table !== "referral_orders") return realFrom(table);
      const handle = realFrom(table) as unknown as Record<string, unknown>;
      return {
        ...handle,
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              // The 23514 this alert was written for: the lifecycle migration
              // has not been applied and 'pending' is not in the CHECK.
              error: {
                code: "23514",
                message: 'violates check constraint "referral_orders_payment_status_check"',
                details: "Failing row contains (pending).",
              },
            }),
          }),
        }),
      };
    }) as typeof supabaseAdmin.from);

    const result = await sweep();
    spy.mockRestore();

    expect(result.failed).toBe(1);
    expect(result.converged).toBe(0);
    const alert = db.alerts.find((a) => a.type === "commission_accrual_unrecovered");
    expect(alert).toBeDefined();
    const failures = (alert?.context as { failures: Array<{ error: string }> }).failures;
    // Before the fix this was the literal string "[object Object]", so the
    // alert's own instruction ("if this names a check-constraint violation…")
    // could never be acted on.
    expect(failures[0].error).toContain("23514");
    expect(failures[0].error).toContain("referral_orders_payment_status_check");
    expect(failures[0].error).not.toContain("[object Object]");
  });
});
