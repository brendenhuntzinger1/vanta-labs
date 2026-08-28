import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// VL-29 / VL-REV-01 — A MEMBERSHIP CHARGE IS A SALE, SO IT HAS TO BE AN ORDER.
//
// Both renewal lanes recorded a `membership_billing_events` row and stopped
// there. Every revenue surface in this application reads the `orders` table —
// /admin/revenue, the dashboard rollups, the profit engine, analytics, the CSV
// export — and exactly one screen (admin/membership) reads billing events. So a
// member charged $29 every month forever showed up on ONE internal screen and
// nowhere else: recurring revenue was invisible to the owner's actual reporting.
//
// The SIGNUP charge had the same hole, and a wider one: the Veyra token lane in
// startMembershipSignup is the ONLY live way to buy a membership (the hosted
// checkout and manual annual lanes, which do write orders, have no callers left
// — grep them), so no membership purchase reached the orders table at all. Month
// one was as invisible as every month after it.
//
// The rule these tests hold: a membership charge that really took money writes a
// PAID membership order for the amount CAPTURED, exactly once per charge.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/membership-billing");

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));
const authUser = vi.hoisted(() => ({ email: "member@example.test" as string | null, name: "Test Member" }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    const client = db.current.client as unknown as Record<string, unknown>;
    client.auth = {
      admin: {
        getUserById: async () => (authUser.email
          ? { data: { user: { email: authUser.email, user_metadata: { full_name: authUser.name } } }, error: null }
          : { data: { user: null }, error: { message: "no user" } }),
      },
    };
    return client;
  },
  createServerClient: () => db.current.client,
}));

const charge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing-provider", () => ({
  getBillingProvider: () => ({ chargeCard: charge }),
}));

const veyra = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), changePlan: vi.fn() }));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: (...args: unknown[]) => veyra.start(...args),
  cancelVeyraMembership: (...args: unknown[]) => veyra.cancel(...args),
  skipVeyraMembershipCycle: async () => ({ ok: true }),
  updateVeyraMembershipCard: async () => ({ ok: true }),
  changeVeyraMembershipPlan: (...args: unknown[]) => veyra.changePlan(...args),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "44444444-4444-4444-4444-444444444444";
const TIER = "tier-pro";
const OTHER_TIER = "tier-elite";
const VEYRA_ID = "veyra_sub_1";
const DAY = 24 * 60 * 60 * 1000;

function seedTier() {
  db.current.table("membership_tiers").push({
    id: TIER,
    slug: "pro",
    name: "Pro",
    monthly_price_cents: 2900,
    annual_price_cents: 29000,
    intro_price_cents: 0,
    intro_duration_days: 0,
    intro_offer_enabled: false,
    monthly_store_credit_cents: 500,
  });
  db.current.table("membership_tiers").push({
    id: OTHER_TIER,
    slug: "elite",
    name: "Elite",
    monthly_price_cents: 4900,
    annual_price_cents: 49000,
    intro_price_cents: 0,
    intro_duration_days: 0,
    intro_offer_enabled: false,
    monthly_store_credit_cents: 1000,
  });
}

function seedVeyraMember(overrides: Row = {}) {
  db.current.table("customer_memberships").push({
    user_id: USER,
    tier_id: TIER,
    status: "active",
    billing_cycle: "monthly",
    veyra_membership_id: VEYRA_ID,
    cancel_at_period_end: false,
    next_billing_at: new Date(Date.now() + 30 * DAY).toISOString(),
    ...overrides,
  });
}

function orders(): Row[] {
  return db.current.table("orders");
}

function membershipOrders(): Row[] {
  return orders().filter((row) => row.order_type === "membership");
}

async function renewed(data: Record<string, unknown>) {
  const { handleMembershipEvent } = await import("@/lib/membership-webhook");
  return handleMembershipEvent("membership.renewed", {
    membership_id: VEYRA_ID,
    ...data,
  });
}

beforeEach(() => {
  vi.resetModules();
  charge.mockReset();
  charge.mockResolvedValue({ success: true, providerChargeId: "ch_renewal_1" });
  veyra.start.mockReset();
  veyra.cancel.mockReset();
  veyra.changePlan.mockReset();
  veyra.start.mockResolvedValue({ ok: true, membershipId: VEYRA_ID });
  veyra.cancel.mockResolvedValue({ ok: true });
  veyra.changePlan.mockResolvedValue({ ok: true });
  authUser.email = "member@example.test";
  db.current = createFakeDb();
  seedTier();
});

describe("the Veyra renewal webhook books the money as an order", () => {
  it("writes ONE paid membership order for the amount actually captured", async () => {
    seedVeyraMember();

    await renewed({
      amount_cents: 2900,
      amount_charged_cents: 2400, // a discounted renewal: $24 was taken, not $29
      next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });

    expect(membershipOrders()).toHaveLength(1);
    const order = membershipOrders()[0];
    // The CAPTURED amount, never the list price — recording $29 on a $24
    // charge overstates revenue on every discounted renewal.
    expect(Number(order.amount_paid)).toBeCloseTo(24, 2);
    expect(Number(order.subtotal)).toBeCloseTo(24, 2);
    expect(order.payment_status).toBe("paid");
    expect(order.customer_user_id).toBe(USER);
    expect(order.membership_tier_id).toBe(TIER);
    expect(order.membership_cycle).toBe("monthly");
    expect(order.paid_at).toBeTruthy();
  });

  it("makes the renewal visible to every revenue surface", async () => {
    seedVeyraMember();
    await renewed({ amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });

    const order = membershipOrders()[0] as { payment_status: string; order_type: string; amount_paid: number; refund_amount?: number };
    // These three predicates are what every revenue read in the application
    // filters on. If a renewal fails any of them it is invisible again.
    expect(isRevenueOrderStatus(order.payment_status)).toBe(true);
    expect(isSaleOrder(order.order_type)).toBe(true);
    expect(netOrderRevenue(order)).toBeCloseTo(29, 2);
  });

  it("never puts a renewal in the shipping queue", async () => {
    seedVeyraMember();
    await renewed({ amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });

    // A membership is digital: nothing is picked, packed or posted.
    expect(membershipOrders()[0].fulfillment_status).toBe("fulfilled");
  });

  it("records the renewal once, however many times the event is delivered", async () => {
    seedVeyraMember();
    const period = new Date(Date.now() + 30 * DAY).toISOString();

    await renewed({ amount_charged_cents: 2900, next_renewal_at: period });
    await renewed({ amount_charged_cents: 2900, next_renewal_at: period });
    await renewed({ amount_charged_cents: 2900, next_renewal_at: period });

    expect(membershipOrders()).toHaveLength(1);
  });

  it("records the NEXT period as its own order", async () => {
    seedVeyraMember();
    await renewed({ amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });
    await renewed({ amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 60 * DAY).toISOString() });

    expect(membershipOrders()).toHaveLength(2);
    const ids = new Set(membershipOrders().map((row) => row.order_id));
    expect(ids.size).toBe(2);
  });

  it("books nothing when the renewal did not take money", async () => {
    seedVeyraMember();
    const { handleMembershipEvent } = await import("@/lib/membership-webhook");

    await handleMembershipEvent("membership.payment_failed", { membership_id: VEYRA_ID, amount_cents: 2900 });
    await handleMembershipEvent("membership.canceled", { membership_id: VEYRA_ID });
    // A $0 "renewal" is a schedule event, not revenue.
    await renewed({ amount_charged_cents: 0 });

    expect(membershipOrders()).toHaveLength(0);
  });

  it("still advances the membership when the order write fails", async () => {
    // The member's ACCESS must never depend on the bookkeeping row. A failed
    // order insert is an alert, not a lapsed membership.
    seedVeyraMember();
    db.current.injectFailure({ table: "orders", op: "insert", times: 1, message: "orders unavailable" });

    const result = await renewed({ amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });

    expect(result.handled).toBe(true);
    expect(db.current.table("customer_memberships")[0].status).toBe("active");
    expect(db.current.table("membership_billing_events")).toHaveLength(1);
  });
});

describe("the local billing sweep books its renewal as an order too", () => {
  it("writes a paid membership order for a swept renewal charge", async () => {
    // The sweep only ever touches memberships Veyra does NOT own
    // (veyra_membership_id null) — it charges them itself.
    db.current.table("customer_memberships").push({
      user_id: USER,
      tier_id: TIER,
      status: "active",
      billing_cycle: "monthly",
      veyra_membership_id: null,
      cancel_at_period_end: false,
      intro_status: "not_applicable",
      renewal_reminder_sent_at: null,
      next_billing_amount_cents: 2900,
      next_billing_at: new Date(Date.now() - DAY).toISOString(),
    });

    const { runMembershipBillingSweep } = await import("@/lib/membership-billing");
    const result = await runMembershipBillingSweep();

    expect(result.renewalChargesAttempted).toBe(1);
    expect(membershipOrders()).toHaveLength(1);
    expect(Number(membershipOrders()[0].amount_paid)).toBeCloseTo(29, 2);
    expect(membershipOrders()[0].payment_status).toBe("paid");
    expect(membershipOrders()[0].customer_user_id).toBe(USER);
  });

  it("books nothing when the sweep's charge is declined", async () => {
    charge.mockResolvedValue({ success: false, error: "card declined" });
    db.current.table("customer_memberships").push({
      user_id: USER,
      tier_id: TIER,
      status: "active",
      billing_cycle: "monthly",
      veyra_membership_id: null,
      cancel_at_period_end: false,
      intro_status: "not_applicable",
      renewal_reminder_sent_at: null,
      next_billing_amount_cents: 2900,
      next_billing_at: new Date(Date.now() - DAY).toISOString(),
    });

    const { runMembershipBillingSweep } = await import("@/lib/membership-billing");
    await runMembershipBillingSweep();

    expect(membershipOrders()).toHaveLength(0);
  });
});


describe("the FIRST charge is booked as an order too", () => {
  // The Veyra token lane is the only live way to buy a membership: the hosted
  // checkout lane (createMembershipCheckoutSession) and the manual annual lane
  // (createAnnualMembershipManualOrder) both write orders, and both have no
  // callers left. So until this, NO membership purchase reached the orders
  // table — the renewal fix above closed months 2..n and left month 1 open.
  async function signup(input: Partial<{ tierId: string; billingCycle: "monthly" | "annual"; tokenIntentId: string | null }> = {}) {
    const { startMembershipSignup } = await import("@/lib/membership-billing");
    return startMembershipSignup({
      userId: USER,
      tierId: input.tierId ?? TIER,
      billingCycle: input.billingCycle ?? "monthly",
      tokenIntentId: input.tokenIntentId === undefined ? "ti_live_card" : input.tokenIntentId,
    });
  }

  it("writes ONE paid membership order for the money it just took", async () => {
    const result = await signup();

    expect(result).toEqual({ success: true });
    expect(membershipOrders()).toHaveLength(1);
    const order = membershipOrders()[0];
    expect(Number(order.amount_paid)).toBeCloseTo(29, 2);
    expect(order.payment_status).toBe("paid");
    expect(order.customer_user_id).toBe(USER);
    expect(order.membership_tier_id).toBe(TIER);
    expect(order.membership_cycle).toBe("monthly");
    // Digital, like a renewal: nothing is picked, packed or posted.
    expect(order.fulfillment_status).toBe("fulfilled");
  });

  it("makes the signup visible to every revenue surface", async () => {
    await signup();
    const order = membershipOrders()[0] as { payment_status: string; order_type: string; amount_paid: number; refund_amount?: number };

    expect(isRevenueOrderStatus(order.payment_status)).toBe(true);
    expect(isSaleOrder(order.order_type)).toBe(true);
    expect(netOrderRevenue(order)).toBeCloseTo(29, 2);
  });

  it("books the annual price and cycle on an annual signup", async () => {
    await signup({ billingCycle: "annual" });

    expect(membershipOrders()).toHaveLength(1);
    expect(Number(membershipOrders()[0].amount_paid)).toBeCloseTo(290, 2);
    expect(membershipOrders()[0].membership_cycle).toBe("annual");
  });

  it("books nothing when the first charge is declined", async () => {
    veyra.start.mockResolvedValue({ ok: false, kind: "payment_unavailable", message: "card declined" });

    const result = await signup();

    expect(result).toEqual({ success: false });
    // No membership row, and no order either: a failed first payment must leave
    // no trace of a sale that never happened.
    expect(db.current.table("customer_memberships")).toHaveLength(0);
    expect(membershipOrders()).toHaveLength(0);
  });

  it("books the legacy local-provider lane's charge as well", async () => {
    await signup({ tokenIntentId: null });

    expect(charge).toHaveBeenCalledTimes(1);
    expect(membershipOrders()).toHaveLength(1);
    expect(Number(membershipOrders()[0].amount_paid)).toBeCloseTo(29, 2);
  });

  it("books nothing for a tier change, because no money moves", async () => {
    db.current.table("customer_memberships").push({
      user_id: USER, tier_id: OTHER_TIER, status: "active", billing_cycle: "monthly",
      veyra_membership_id: VEYRA_ID, cancel_at_period_end: false,
    });

    const result = await signup({ tierId: TIER });

    expect(result).toEqual({ success: true, changed: true });
    expect(membershipOrders()).toHaveLength(0);
  });

  it("books nothing when an already-active member re-submits", async () => {
    db.current.table("customer_memberships").push({
      user_id: USER, tier_id: TIER, status: "active", billing_cycle: "monthly",
      veyra_membership_id: VEYRA_ID, cancel_at_period_end: false,
    });

    const result = await signup();

    expect(result).toEqual({ success: true, changed: false });
    expect(veyra.start).not.toHaveBeenCalled();
    expect(membershipOrders()).toHaveLength(0);
  });

  it("books ONE order when the same subscription is created twice", async () => {
    // THE ADVERSARIAL CASE. The charge landed and Veyra minted the subscription,
    // but the local membership row did not survive (a crash between the two
    // writes, a retry against a cleared row). The retry sees no membership, so
    // the "already active" guard above does NOT fire — the only thing standing
    // between the store and two orders for one charge is the payment_id key,
    // which is derived from the processor's subscription id.
    await signup();
    db.current.tables.set("customer_memberships", []);
    await signup();

    expect(membershipOrders()).toHaveLength(1);
  });
});
