import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// RE-SUBSCRIBING AND CHANGING TIER MUST NEVER DOUBLE BILL, MINT A SECOND
// PROCESSOR SUBSCRIPTION, OR TAKE AWAY WHAT THE MEMBER ALREADY PAID FOR.
//
// Three holes in startMembershipSignup's fall-through lane, all found by the
// production audit:
//
//   * An ANNUAL member confirming their own tier again was charged a second
//     full, non-refundable year and had the months already paid for reset —
//     every annual row carries cancel_at_period_end by design, and the branch
//     read that as "winding down, let them buy again".
//   * A DECLINED new attempt ran the sweep's handleChargeFailure, whose
//     unconditional UPDATE flipped an existing, still-paid row to past_due —
//     perks off, "Payment needed", a payment-failed email for a renewal that
//     was never due.
//   * After the prior subscription was cancelled at Veyra and the new charge
//     declined, the row still named the closed subscription, so the member's
//     next attempt tried to cancel it again and was refused for ever.
//
// Same harness as membership-signup-behaviour.test.ts: the real module, the
// fake database, and only the outside edges replaced.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/membership-billing");

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    const client = db.current.client as unknown as Record<string, unknown>;
    client.auth = {
      admin: {
        getUserById: async () => ({
          data: { user: { email: "member@example.test", user_metadata: { full_name: "Test Member" } } },
          error: null,
        }),
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
  changeVeyraMembershipPlan: (...args: unknown[]) => veyra.changePlan(...args),
  skipVeyraMembershipCycle: async () => ({ ok: true }),
  updateVeyraMembershipCard: async () => ({ ok: true }),
  resumeVeyraMembership: async () => ({ ok: true }),
}));

const emails = vi.hoisted(() => [] as Array<{ to: string; subject: string }>);
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string }) => { emails.push(input); return { success: true }; },
}));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: async (input: { to: string; subject?: string }) => {
    emails.push({ to: input.to, subject: input.subject ?? "marketing" });
    return { success: true };
  },
}));

const alerts = vi.hoisted(() => [] as Array<{ type: string; severity: string; context?: Record<string, unknown> }>);
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (input: { type: string; severity: string; context?: Record<string, unknown> }) => { alerts.push(input); },
}));

vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "55555555-5555-5555-5555-555555555555";
const TIER = "tier-pro";
const OTHER_TIER = "tier-elite";
const DAY = 24 * 60 * 60 * 1000;

function seed(existing?: Row) {
  db.current = createFakeDb();
  db.current.table("membership_tiers").push(
    { id: TIER, slug: "pro", name: "Pro", monthly_price_cents: 2900, annual_price_cents: 29000, intro_price_cents: 0, intro_duration_days: 0, intro_offer_enabled: false, monthly_store_credit_cents: 500 },
    { id: OTHER_TIER, slug: "elite", name: "Elite", monthly_price_cents: 4900, annual_price_cents: 49000, intro_price_cents: 0, intro_duration_days: 0, intro_offer_enabled: false, monthly_store_credit_cents: 1000 },
  );
  if (existing) db.current.table("customer_memberships").push({ user_id: USER, ...existing });
}

function membership() {
  return db.current.table("customer_memberships").find((row) => row.user_id === USER);
}

function billingEvents() {
  return db.current.table("membership_billing_events");
}

async function signup(input: Partial<{ tierId: string; billingCycle: "monthly" | "annual"; tokenIntentId: string | null }> = {}) {
  const { startMembershipSignup } = await import("@/lib/membership-billing");
  return startMembershipSignup({
    userId: USER,
    tierId: input.tierId ?? TIER,
    billingCycle: input.billingCycle ?? "monthly",
    tokenIntentId: input.tokenIntentId,
  });
}

beforeEach(() => {
  vi.resetModules();
  emails.length = 0;
  alerts.length = 0;
  charge.mockReset();
  veyra.start.mockReset();
  veyra.cancel.mockReset();
  veyra.changePlan.mockReset();
  charge.mockResolvedValue({ success: true, providerChargeId: "ch_1" });
  veyra.start.mockResolvedValue({ ok: true, membershipId: "veyra_new" });
  veyra.cancel.mockResolvedValue({ ok: true });
  veyra.changePlan.mockResolvedValue({ ok: true });
  seed();
});

// ===========================================================================
// An annual member re-confirming their own tier
// ===========================================================================

describe("an annual member confirming the tier they already hold", () => {
  const paidUpAnnual = () => ({
    tier_id: TIER,
    status: "active",
    billing_cycle: "annual",
    veyra_membership_id: "veyra_annual",
    // By design: a one-year pass that never auto-renews.
    cancel_at_period_end: true,
    started_at: new Date(Date.now() - 60 * DAY).toISOString(),
    next_billing_at: new Date(Date.now() + 305 * DAY).toISOString(),
    renews_at: new Date(Date.now() + 305 * DAY).toISOString(),
  });

  it("is refused while the paid year is still running, and nothing is charged", async () => {
    seed(paidUpAnnual());
    const before = { ...membership() };

    await expect(signup({ billingCycle: "annual", tokenIntentId: "ti_again" })).rejects.toThrow(/already hold an annual Pro membership/i);

    expect(veyra.start).not.toHaveBeenCalled();
    expect(veyra.cancel).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    expect(billingEvents()).toHaveLength(0);
    expect(emails).toHaveLength(0);
    // The paid term is untouched — not reset to "now + 365d".
    expect(membership()).toEqual(before);
  });

  it("is refused even when the second confirmation picks the monthly cycle", async () => {
    // Same tier, still paid through: the cycle chosen on the second click does
    // not change what they already hold.
    seed(paidUpAnnual());

    await expect(signup({ billingCycle: "monthly", tokenIntentId: "ti_again" })).rejects.toThrow(/already hold an annual/i);
    expect(veyra.start).not.toHaveBeenCalled();
  });

  it("tells the member when their access runs to, in words the route may show", async () => {
    seed(paidUpAnnual());
    const { isCustomerSafeMessage } = await import("@/lib/safe-error");

    const error = await signup({ billingCycle: "annual", tokenIntentId: "ti_again" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/through/);
    expect(isCustomerSafeMessage((error as Error).message)).toBe(true);
  });

  it("is a genuine rejoin once the year has lapsed", async () => {
    seed({
      ...paidUpAnnual(),
      next_billing_at: new Date(Date.now() - 10 * DAY).toISOString(),
      renews_at: new Date(Date.now() - 10 * DAY).toISOString(),
    });

    const result = await signup({ billingCycle: "annual", tokenIntentId: "ti_again" });

    expect(result.success).toBe(true);
    expect(veyra.start).toHaveBeenCalledTimes(1);
    expect(membership()?.veyra_membership_id).toBe("veyra_new");
  });

  it("does not stop the SAME guard letting a monthly member who is winding down back in", async () => {
    // The annual rule is about annual. A monthly member who cancelled at period
    // end still has the deliberate "buy again is the way back" path.
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: true, next_billing_at: new Date(Date.now() + 10 * DAY).toISOString() });

    const result = await signup({ tokenIntentId: "ti_again" });

    expect(result.success).toBe(true);
    expect(veyra.start).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// A declined re-subscription
// ===========================================================================

describe("a declined re-subscription attempt", () => {
  beforeEach(() => {
    veyra.start.mockResolvedValue({ ok: false, kind: "payment_unavailable", message: "declined" });
  });

  it("leaves a member who is winding down exactly as they were — still active, still paid through", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: true, next_billing_at: new Date(Date.now() + 10 * DAY).toISOString() });

    const result = await signup({ tokenIntentId: "ti_declined" });

    expect(result.success).toBe(false);
    expect(membership()?.status).toBe("active");
    expect(membership()?.cancel_at_period_end).toBe(true);
    expect(membership()?.veyra_membership_id).toBe("veyra_old");
    // The failure is on the record, but it is not a demotion.
    expect(billingEvents().every((event) => event.status === "failed")).toBe(true);
    expect(alerts.find((alert) => alert.type === "membership_charge_failed")?.context?.demotedToPastDue).toBe(false);
  });

  it("does not demote a member charged once with no processor subscription", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: null, cancel_at_period_end: false, next_billing_at: new Date(Date.now() + 20 * DAY).toISOString() });

    const result = await signup({ tokenIntentId: "ti_declined" });

    expect(result.success).toBe(false);
    expect(membership()?.status).toBe("active");
  });

  it("keeps a paused member paused, and drops the reference to the subscription that was closed", async () => {
    seed({ tier_id: TIER, status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });

    const result = await signup({ tokenIntentId: "ti_declined" });

    expect(result.success).toBe(false);
    // The prior subscription WAS cancelled (the existing cancel-before-mint
    // rule), so the row must stop naming it...
    expect(veyra.cancel).toHaveBeenCalledWith("veyra_old", false);
    expect(membership()?.veyra_membership_id ?? null).toBeNull();
    // ...and nothing about what the member holds changes.
    expect(membership()?.status).toBe("paused");
  });

  it("keeps a past_due member past_due rather than 'recovering' them into anything", async () => {
    seed({ tier_id: TIER, status: "past_due", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });

    await signup({ tokenIntentId: "ti_declined" });

    expect(membership()?.status).toBe("past_due");
    expect(membership()?.veyra_membership_id ?? null).toBeNull();
  });

  it("lets the next attempt succeed without trying to cancel the closed subscription again", async () => {
    // THE TRAP. With the closed id still on the row, attempt two ran
    // cancelVeyraMembership on a subscription Veyra had already ended; a
    // refusal there refused the signup — for a member trying to pay.
    seed({ tier_id: TIER, status: "past_due", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });
    await signup({ tokenIntentId: "ti_declined" });
    expect(veyra.cancel).toHaveBeenCalledTimes(1);

    veyra.cancel.mockResolvedValue({ ok: false, message: "already cancelled" });
    veyra.start.mockResolvedValue({ ok: true, membershipId: "veyra_new" });

    const retry = await signup({ tokenIntentId: "ti_second_card" });

    expect(retry.success).toBe(true);
    expect(veyra.cancel).toHaveBeenCalledTimes(1);
    expect(membership()?.status).toBe("active");
    expect(membership()?.veyra_membership_id).toBe("veyra_new");
  });

  it("does not drop the reference when the prior subscription was NOT closed", async () => {
    veyra.cancel.mockResolvedValue({ ok: false, message: "provider unavailable" });
    seed({ tier_id: TIER, status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });

    const result = await signup({ tokenIntentId: "ti_declined" });

    expect(result.success).toBe(false);
    expect(veyra.start).not.toHaveBeenCalled();
    expect(membership()?.veyra_membership_id).toBe("veyra_old");
  });

  it("still leaves NO row for a first-time signup that declines", async () => {
    seed();

    const result = await signup({ tokenIntentId: "ti_declined" });

    expect(result.success).toBe(false);
    expect(membership()).toBeUndefined();
  });
});

// ===========================================================================
// Tier changes
// ===========================================================================

describe("changing tier can never leave two subscriptions billing", () => {
  it("cancels the old subscription BEFORE minting one for the new tier when the member is paused", async () => {
    seed({ tier_id: TIER, status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });

    const result = await signup({ tierId: OTHER_TIER, tokenIntentId: "ti_change" });

    expect(result.success).toBe(true);
    expect(veyra.cancel).toHaveBeenCalledWith("veyra_old", false);
    expect(veyra.cancel.mock.invocationCallOrder[0]).toBeLessThan(veyra.start.mock.invocationCallOrder[0]);
    expect(veyra.start).toHaveBeenCalledTimes(1);
    expect(membership()?.tier_id).toBe(OTHER_TIER);
    expect(membership()?.veyra_membership_id).toBe("veyra_new");
  });

  it("refuses the tier change when the old subscription cannot be cancelled", async () => {
    veyra.cancel.mockResolvedValue({ ok: false, message: "provider unavailable" });
    seed({ tier_id: TIER, status: "past_due", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });

    const result = await signup({ tierId: OTHER_TIER, tokenIntentId: "ti_change" });

    expect(result.success).toBe(false);
    expect(veyra.start).not.toHaveBeenCalled();
    expect(membership()?.tier_id).toBe(TIER);
    expect(membership()?.veyra_membership_id).toBe("veyra_old");
  });

  it("reprices an active subscription in place — no second subscription, no second charge", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_sub", cancel_at_period_end: false, next_billing_at: new Date(Date.now() + 20 * DAY).toISOString() });

    const result = await signup({ tierId: OTHER_TIER, tokenIntentId: "ti_change" });

    expect(result).toEqual({ success: true, changed: true });
    expect(veyra.changePlan).toHaveBeenCalledWith("veyra_sub", expect.objectContaining({ amountCents: 4900 }));
    expect(veyra.start).not.toHaveBeenCalled();
    expect(veyra.cancel).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    expect(membership()?.veyra_membership_id).toBe("veyra_sub");
  });

  it("reprices in place for a monthly member who is winding down, too", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_sub", cancel_at_period_end: true, next_billing_at: new Date(Date.now() + 10 * DAY).toISOString() });

    const result = await signup({ tierId: OTHER_TIER, tokenIntentId: "ti_change" });

    expect(result).toEqual({ success: true, changed: true });
    expect(veyra.start).not.toHaveBeenCalled();
    expect(membership()?.veyra_membership_id).toBe("veyra_sub");
  });

  it("refuses the legacy lane when a live processor subscription exists, instead of orphaning it", async () => {
    // No card token means no Veyra call — and the upsert would have written
    // veyra_membership_id: null, leaving Veyra billing a subscription nothing
    // points at while our own sweep started billing the same member.
    seed({ tier_id: TIER, status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });

    const result = await signup({ tierId: OTHER_TIER, tokenIntentId: null });

    expect(result.success).toBe(false);
    expect(charge).not.toHaveBeenCalled();
    expect(veyra.cancel).not.toHaveBeenCalled();
    expect(membership()?.veyra_membership_id).toBe("veyra_old");
    expect(membership()?.status).toBe("paused");
  });
});
