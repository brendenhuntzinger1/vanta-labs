import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// VL-11 / MPC-01 — ONE BALANCE, N ORDERS.
//
// Store credit and points were READ when an order was quoted and DEBITED when
// it settled, with nothing claiming them in between. Two checkouts opened at
// once therefore both priced themselves against the same $50, both wrote an
// order with $50 off, and both charged the reduced amount. At settlement the
// ledger debited $50 once — redeemStoreCredit clamps to the live balance — so
// nothing ever looked wrong: the balance never went negative, no alert fired,
// and the store had simply handed out $100 of discount for $50 of liability.
//
// The tests below are written in that shape: two orders, one balance, and an
// assertion about how much DISCOUNT was granted rather than how much ledger was
// debited. A test that only checked the ledger passes on the broken code.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return db.current.client; },
  createServerClient: () => db.current.client,
}));

const USER = "user-1111";
const nowIso = new Date().toISOString();

/** A member with `cents` of store credit and `points` of loyalty points. */
function seed(opts: { cents?: number; points?: number } = {}) {
  db.current = createFakeDb();
  if (opts.cents) {
    db.current.seed("store_credit_ledger", [
      { id: "grant-1", user_id: USER, amount_cents: opts.cents, reason: "membership_monthly_grant", created_at: nowIso },
    ]);
  }
  if (opts.points) {
    db.current.seed("points_ledger", [
      { id: "earn-1", user_id: USER, amount: opts.points, reason: "order_earn", created_at: nowIso },
    ]);
  }
}

/** An order row, so releases and the sweep can read its state. */
function order(orderId: string, patch: Record<string, unknown> = {}) {
  db.current.seed("orders", [{
    order_id: orderId,
    customer_user_id: USER,
    payment_status: "pending_payment",
    store_credit_redeemed_cents: 0,
    points_redeemed: 0,
    created_at: nowIso,
    ...patch,
  }]);
}

async function tender() {
  return import("@/lib/tender-reservation");
}

async function creditBalance(): Promise<number> {
  const { getStoreCreditBalanceCents } = await import("@/lib/store-credit");
  return getStoreCreditBalanceCents(USER);
}

async function pointsBalance(): Promise<number> {
  const { getPointsBalance } = await import("@/lib/membership");
  return getPointsBalance(USER);
}

beforeEach(() => {
  vi.resetModules();
});

describe("the same balance cannot fund two orders", () => {
  it("refuses the second checkout that tries to spend it", async () => {
    seed({ cents: 5000 });
    const { reserveOrderTender } = await tender();

    const first = await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 });
    const second = await reserveOrderTender({ orderId: "order-B", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, shortOf: "store credit" });
    // $50 of credit bought exactly $50 of discount.
    expect(await creditBalance()).toBe(0);
  });

  it("refuses it when both checkouts run at the same instant", async () => {
    // The race as the shopper can actually run it: two tabs, one submit each.
    seed({ cents: 5000 });
    const { reserveOrderTender } = await tender();

    const results = await Promise.all([
      reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 }),
      reserveOrderTender({ orderId: "order-B", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await creditBalance()).toBe(0);
  });

  it("lets a second order spend what the first one left", async () => {
    // The ladder still works: holds are claims on a balance, not a lock on it.
    seed({ cents: 5000 });
    const { reserveOrderTender } = await tender();

    expect((await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 2000, pointsRedeemed: 0 })).ok).toBe(true);
    expect((await reserveOrderTender({ orderId: "order-B", userId: USER, storeCreditCents: 3000, pointsRedeemed: 0 })).ok).toBe(true);
    expect((await reserveOrderTender({ orderId: "order-C", userId: USER, storeCreditCents: 100, pointsRedeemed: 0 })).ok).toBe(false);
    expect(await creditBalance()).toBe(0);
  });

  it("holds points the same way", async () => {
    seed({ points: 400 });
    const { reserveOrderTender } = await tender();

    expect((await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 0, pointsRedeemed: 400 })).ok).toBe(true);
    expect(await reserveOrderTender({ orderId: "order-B", userId: USER, storeCreditCents: 0, pointsRedeemed: 400 }))
      .toEqual({ ok: false, shortOf: "rewards points" });
    expect(await pointsBalance()).toBe(0);
  });

  it("takes both balances or neither", async () => {
    // Credit is available, points are not. The order is priced with both, so
    // holding only the credit would leave it discounted by points nobody has.
    seed({ cents: 5000, points: 100 });
    const { reserveOrderTender } = await tender();

    const result = await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 400 });

    expect(result).toEqual({ ok: false, shortOf: "rewards points" });
    expect(await creditBalance()).toBe(5000);
    expect(await pointsBalance()).toBe(100);
  });

  it("is idempotent for one order, so a resubmit is not a second spend", async () => {
    seed({ cents: 5000 });
    const { reserveOrderTender } = await tender();

    expect((await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 3000, pointsRedeemed: 0 })).ok).toBe(true);
    expect((await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 3000, pointsRedeemed: 0 })).ok).toBe(true);

    expect(await creditBalance()).toBe(2000);
  });

  it("ignores an order with no account and nothing to hold", async () => {
    seed({ cents: 5000 });
    const { reserveOrderTender } = await tender();

    expect(await reserveOrderTender({ orderId: "order-A", userId: null, storeCreditCents: 5000, pointsRedeemed: 0 }))
      .toEqual({ ok: true, shortOf: null });
    expect(await reserveOrderTender({ orderId: "order-B", userId: USER, storeCreditCents: 0, pointsRedeemed: 0 }))
      .toEqual({ ok: true, shortOf: null });
    expect(await creditBalance()).toBe(5000);
  });
});

describe("what the shopper is told when a hold is refused", () => {
  it("reaches them verbatim instead of being swallowed as technical", async () => {
    // The checkout route runs every error message through this sanitiser, and
    // anything it rejects becomes "We couldn't start checkout just now" — which
    // tells a shopper nothing about refreshing a stale total.
    const { describeTenderShortfall } = await tender();
    const { isCustomerSafeMessage } = await import("@/lib/safe-error");

    for (const shortOf of ["store credit", "rewards points", null]) {
      const message = describeTenderShortfall(shortOf);
      expect(isCustomerSafeMessage(message), message).toBe(true);
    }
  });
});

describe("settlement does not spend the balance twice", () => {
  it("leaves the hold alone when the paid webhook redeems", async () => {
    seed({ cents: 5000 });
    const { reserveOrderTender } = await tender();
    const { redeemStoreCredit } = await import("@/lib/store-credit");
    const { redeemPoints } = await import("@/lib/membership");

    await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 });
    // The webhook path, including the retry that used to double-debit.
    await redeemStoreCredit(USER, 5000, "order-A");
    await redeemStoreCredit(USER, 5000, "order-A");
    await redeemPoints(USER, 0, "order-A");

    expect(await creditBalance()).toBe(0);
    expect(db.current.rows("store_credit_ledger").filter((row) => row.order_id === "order-A")).toHaveLength(1);
  });

  it("still debits an order whose hold was released before it paid", async () => {
    // An abandoned checkout that settles late: the hold is gone, so settlement
    // is the ordinary clamped redemption it always was.
    seed({ cents: 5000 });
    const { reserveOrderTender, releaseOrderTender } = await tender();
    const { redeemStoreCredit } = await import("@/lib/store-credit");

    order("order-A", { store_credit_redeemed_cents: 5000 });
    await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 });
    await releaseOrderTender("order-A");
    expect(await creditBalance()).toBe(5000);

    await redeemStoreCredit(USER, 5000, "order-A");
    expect(await creditBalance()).toBe(0);
  });
});

describe("a hold is handed back when the order will never settle", () => {
  it("returns credit and points on a cancelled checkout", async () => {
    seed({ cents: 5000, points: 400 });
    const { reserveOrderTender, releaseOrderTender } = await tender();

    order("order-A", { payment_status: "canceled", store_credit_redeemed_cents: 5000, points_redeemed: 400 });
    await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 400 });
    expect(await creditBalance()).toBe(0);

    await releaseOrderTender("order-A");

    expect(await creditBalance()).toBe(5000);
    expect(await pointsBalance()).toBe(400);
  });

  it("refuses to unspend a paid order", async () => {
    // The hold on a paid order is a real redemption. Deleting it would hand the
    // customer back money they have already spent.
    seed({ cents: 5000 });
    const { reserveOrderTender, releaseOrderTender } = await tender();

    order("order-A", { payment_status: "paid", store_credit_redeemed_cents: 5000 });
    await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 });

    expect(await releaseOrderTender("order-A")).toBe(0);
    expect(await creditBalance()).toBe(0);
  });

  it("leaves no trace in the customer's balance history", async () => {
    // A checkout the shopper walked away from is not an event in their credit
    // history. Posting a hold and a reversal would also double-count on any
    // later refund, which sums the debits.
    seed({ cents: 5000 });
    const { reserveOrderTender, releaseOrderTender } = await tender();

    order("order-A", { payment_status: "canceled", store_credit_redeemed_cents: 5000 });
    await reserveOrderTender({ orderId: "order-A", userId: USER, storeCreditCents: 5000, pointsRedeemed: 0 });
    await releaseOrderTender("order-A");

    expect(db.current.rows("store_credit_ledger").filter((row) => row.order_id === "order-A")).toHaveLength(0);
  });
});

describe("the sweep reclaims what the checkout paths missed", () => {
  const ancient = new Date(Date.now() - 72 * 3_600_000).toISOString();

  async function holdFor(orderId: string, patch: Record<string, unknown>) {
    const { reserveOrderTender } = await tender();
    order(orderId, { store_credit_redeemed_cents: 2000, ...patch });
    await reserveOrderTender({ orderId, userId: USER, storeCreditCents: 2000, pointsRedeemed: 0 });
  }

  it("releases holds on dead and long-abandoned checkouts, and only those", async () => {
    seed({ cents: 20000 });
    await holdFor("order-dead", { payment_status: "canceled" });
    await holdFor("order-declined", { payment_status: "payment_failed" });
    await holdFor("order-abandoned", { payment_status: "pending_payment", created_at: ancient });
    await holdFor("order-inflight", { payment_status: "pending_payment" });
    await holdFor("order-paid", { payment_status: "paid" });

    const { releaseAbandonedTenderHolds } = await tender();
    expect(await releaseAbandonedTenderHolds()).toBe(3);

    const held = db.current.rows("store_credit_ledger")
      .filter((row) => Number(row.amount_cents ?? 0) < 0)
      .map((row) => String(row.order_id))
      .sort();
    expect(held).toEqual(["order-inflight", "order-paid"]);
    expect(await creditBalance()).toBe(20000 - 4000);
  });

  it("releases a manual order left waiting for an admin who never came", async () => {
    // Manual/off-platform payments sit at `awaiting_verification`, not
    // `pending_payment`. One that is never approved would otherwise hold the
    // shopper's own credit for good.
    seed({ cents: 20000 });
    await holdFor("order-manual", { payment_status: "awaiting_verification", created_at: ancient });

    const { releaseAbandonedTenderHolds } = await tender();
    expect(await releaseAbandonedTenderHolds()).toBe(1);
    expect(await creditBalance()).toBe(20000);
  });

  it("never unspends an order that actually took money, whatever its status now reads", async () => {
    // An admin can set a payment status by hand. `paid_at` is the fact that
    // cannot be retyped: money arrived, so the redemption is real.
    seed({ cents: 20000 });
    await holdFor("order-was-paid", {
      payment_status: "canceled", paid_at: nowIso, amount_paid: 120,
    });

    const { releaseAbandonedTenderHolds, releaseOrderTender } = await tender();
    expect(await releaseOrderTender("order-was-paid")).toBe(0);
    expect(await releaseAbandonedTenderHolds()).toBe(0);
    expect(await creditBalance()).toBe(18000);
  });

  it("is safe to run twice", async () => {
    seed({ cents: 20000 });
    await holdFor("order-dead", { payment_status: "canceled" });

    const { releaseAbandonedTenderHolds } = await tender();
    expect(await releaseAbandonedTenderHolds()).toBe(1);
    expect(await releaseAbandonedTenderHolds()).toBe(0);
    expect(await creditBalance()).toBe(20000);
  });
});
