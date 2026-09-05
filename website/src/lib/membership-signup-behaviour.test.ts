import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// THE FUNCTION THAT TAKES MEMBERSHIP MONEY, ACTUALLY RUN.
//
// vitest.setup.ts globally vi.mock()s @/lib/membership-billing down to two
// no-op exports, so startMembershipSignup — the entire paid-membership signup
// path — had ZERO behavioural coverage in a 3,600-test suite. Everything that
// reaches it saw the stub.
//
// That stub is load-bearing for other suites (it keeps membership out of
// checkout tests), so it stays. This file unmocks it deliberately and drives
// the real function, with only the OUTSIDE edges replaced: the card processor,
// the Veyra client, and email. The database is the stateful fake, so what the
// function writes can be read back and checked.
//
// The invariants below are the ones the source itself calls out as previously
// broken, or as load-bearing:
//
//   * A FAILED first charge must leave NO membership row. It used to upsert
//     "past_due" with a tier name, an access-until date and a next-billing date
//     the account had never paid for.
//   * `veyra_membership_id` is "THE load-bearing write" — every sweep query
//     skips a row that has one. Drop it and the member is billed twice a month,
//     once by Veyra's cron and once by ours.
//   * Annual does not auto-renew: the processor is told to stop, and the local
//     row must say the same thing.
//   * A member who is already active must not be charged twice — UNLESS they
//     hold no processor subscription or are winding down, in which case
//     returning success traps them forever with no charge and no explanation.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/membership-billing");

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));
const authUser = vi.hoisted(() => ({ email: "member@example.test" as string | null, name: "Test Member" }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    const client = db.current.client as unknown as Record<string, unknown>;
    // getAuthUserContact reads auth.admin.getUserById, which the fake has no
    // notion of. Supplied here rather than stubbed away, so the "Veyra needs an
    // email" branch can be driven by removing it.
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

const veyra = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), changePlan: vi.fn(async (_id: string, _plan: { amountCents: number; interval: string }) => ({ ok: true })) }));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: (...args: unknown[]) => veyra.start(...args),
  cancelVeyraMembership: (...args: unknown[]) => veyra.cancel(...args),
  skipVeyraMembershipCycle: async () => ({ ok: true }),
  updateVeyraMembershipCard: async () => ({ ok: true }),
  // D-05: a tier change repriced the local row and never told the processor,
  // so the perks moved and the charge did not — Veyra went on billing the old
  // tier for ever. The change is now pushed to the subscription too, which is
  // why this suite has to know about it.
  changeVeyraMembershipPlan: (id: string, plan: { amountCents: number; interval: string }) => veyra.changePlan(id, plan),
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

const alerts = vi.hoisted(() => [] as Array<{ type: string; severity: string }>);
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (input: { type: string; severity: string }) => { alerts.push(input); },
}));

vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "33333333-3333-3333-3333-333333333333";
const TIER = "tier-pro";
const OTHER_TIER = "tier-elite";

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
  authUser.email = "member@example.test";
  charge.mockResolvedValue({ success: true, providerChargeId: "ch_1" });
  veyra.start.mockResolvedValue({ ok: true, membershipId: "veyra_sub_1" });
  veyra.cancel.mockResolvedValue({ ok: true });
  seed();
});

describe("a membership exists only if the money actually moved", () => {
  it("writes an active membership when the charge succeeds", async () => {
    const result = await signup();

    expect(result).toEqual({ success: true });
    expect(membership()?.status).toBe("active");
    expect(membership()?.tier_id).toBe(TIER);
    expect(billingEvents()).toHaveLength(1);
    expect(billingEvents()[0].status).toBe("succeeded");
    expect(billingEvents()[0].amount_cents).toBe(2900);
  });

  it("leaves NO membership row at all when the first charge fails", async () => {
    // THE DEFECT the source names: this used to upsert status "past_due" with a
    // tier name, a renews_at and a next_billing_at, so the account displayed a
    // membership it had never paid for.
    charge.mockResolvedValue({ success: false, error: "card declined" });

    const result = await signup();

    expect(result).toEqual({ success: false });
    expect(membership()).toBeUndefined();
    expect(emails.map((e) => e.subject).join(" ")).not.toMatch(/welcome/i);
  });

  it("charges the annual price for an annual signup, not the monthly one", async () => {
    await signup({ billingCycle: "annual" });
    expect(billingEvents()[0].amount_cents).toBe(29000);
  });

  it("sends the welcome and the receipt only on a real charge", async () => {
    await signup();
    expect(emails).toHaveLength(2);

    emails.length = 0;
    charge.mockResolvedValue({ success: false, error: "declined" });
    seed();
    await signup();
    expect(emails.filter((e) => /welcome|receipt/i.test(e.subject))).toHaveLength(0);
  });
});

describe("the write that stops the member being billed twice", () => {
  it("records the processor's subscription id on the Veyra lane", async () => {
    // "THE load-bearing write. Non-null makes every sweep query skip this row."
    // Without it Veyra's cron and our sweep both bill the same member.
    await signup({ tokenIntentId: "ti_123" });

    expect(veyra.start).toHaveBeenCalledTimes(1);
    expect(membership()?.veyra_membership_id).toBe("veyra_sub_1");
    expect(charge).not.toHaveBeenCalled();
  });

  it("leaves it null on the legacy lane, so our own sweep still owns renewal", async () => {
    // The negative control: the field must reflect which lane ran, not be
    // unconditionally set or unconditionally null.
    await signup({ tokenIntentId: null });

    expect(veyra.start).not.toHaveBeenCalled();
    expect(charge).toHaveBeenCalledTimes(1);
    expect(membership()?.veyra_membership_id ?? null).toBeNull();
  });

  it("creates no membership when Veyra refuses the card", async () => {
    veyra.start.mockResolvedValue({ ok: false, kind: "payment_unavailable", message: "declined" });

    const result = await signup({ tokenIntentId: "ti_123" });

    expect(result).toEqual({ success: false });
    expect(membership()).toBeUndefined();
  });

  it("refuses to charge a card it cannot attach to anyone", async () => {
    // An orphaned recurring subscription at the processor is worse than a
    // failed signup, so a missing email must stop it BEFORE the charge.
    authUser.email = null;

    const result = await signup({ tokenIntentId: "ti_123" });

    expect(result).toEqual({ success: false });
    expect(veyra.start).not.toHaveBeenCalled();
    expect(membership()).toBeUndefined();
  });
});

describe("an annual membership is a one-year pass, not a subscription", () => {
  it("tells the processor to stop at period end, and says so locally", async () => {
    await signup({ billingCycle: "annual", tokenIntentId: "ti_123" });

    expect(veyra.cancel).toHaveBeenCalledWith("veyra_sub_1", true);
    expect(membership()?.cancel_at_period_end).toBe(true);
    // Nothing further is owed, so no next amount may be promised.
    expect(membership()?.next_billing_amount_cents ?? 0).toBe(0);
  });

  it("does not stop renewal on a monthly membership", async () => {
    await signup({ billingCycle: "monthly", tokenIntentId: "ti_123" });

    expect(veyra.cancel).not.toHaveBeenCalled();
    expect(membership()?.cancel_at_period_end).toBe(false);
    expect(membership()?.next_billing_amount_cents).toBe(2900);
  });

  it("raises a critical alert — and still honours the year — if the processor refuses to stop", async () => {
    // The customer paid; they are entitled to the year. The risk is an unwanted
    // charge twelve months out, so this must alert rather than fail the signup.
    veyra.cancel.mockResolvedValue({ ok: false, message: "not supported" });

    const result = await signup({ billingCycle: "annual", tokenIntentId: "ti_123" });

    expect(result).toEqual({ success: true });
    expect(membership()?.status).toBe("active");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "membership_annual_autorenew_not_stopped", severity: "critical" });
  });
});

describe("signing up again", () => {
  it("does not charge a member who already has a working subscription", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_sub_1", cancel_at_period_end: false });

    const result = await signup({ tokenIntentId: "ti_123" });

    expect(result).toEqual({ success: true, changed: false });
    expect(veyra.start).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    expect(billingEvents()).toHaveLength(0);
  });

  it("DOES charge a member whose membership has no processor subscription", async () => {
    // Charged once, nothing at the processor, so it can never renew. Silently
    // returning success left them trapped: no charge, no card presented, and
    // nothing in their history to explain it. Buying again is the only repair.
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: null, cancel_at_period_end: false });

    const result = await signup({ tokenIntentId: "ti_123" });

    expect(result).toEqual({ success: true });
    expect(veyra.start).toHaveBeenCalledTimes(1);
    expect(membership()?.veyra_membership_id).toBe("veyra_sub_1");
  });

  it("DOES charge a member who is winding down", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: true });

    const result = await signup({ tokenIntentId: "ti_123" });

    expect(result).toEqual({ success: true });
    expect(veyra.start).toHaveBeenCalledTimes(1);
    expect(membership()?.cancel_at_period_end).toBe(false);
  });

  it("schedules an upgrade for the renewal that pays for it instead of charging again", async () => {
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_sub_1", cancel_at_period_end: false });

    const result = await signup({ tierId: OTHER_TIER, tokenIntentId: "ti_123" });

    expect(result).toMatchObject({ success: true, changed: true });
    // An UPGRADE no longer switches the perks at once (that made the dearer
    // tier free until the next charge); it is parked until membership.renewed.
    expect(membership()?.tier_id).toBe(TIER);
    expect(membership()?.pending_tier_id).toBe(OTHER_TIER);
    expect(veyra.start).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    // Repriced to the NEW tier: leaving the old price here would undercharge an
    // upgrade and overcharge a downgrade on the next cycle.
    expect(membership()?.next_billing_amount_cents).toBe(4900);
    // D-05: the local row is not the only place the price lives. The
    // subscription at the processor has to be moved too, or the next cycle
    // charges the OLD tier for ever while the member enjoys the new perks.
    expect(veyra.changePlan).toHaveBeenCalledWith("veyra_sub_1", expect.objectContaining({ amountCents: 4900 }));
    expect(billingEvents().map((e) => e.event_type)).toEqual(["tier_change_scheduled"]);
  });
});

// ---------------------------------------------------------------------------
// RE-SUBSCRIBING MUST NOT LEAVE THE OLD SUBSCRIPTION BILLING.
//
// The same-tier branch above falls through to "create a REAL subscription"
// whenever the local row is not active/trialing — paused, past_due, cancelled
// locally. Nothing cancelled the subscription Veyra was still holding under
// the previous veyra_membership_id before a second one was minted and the
// column overwritten, so the member was billed twice a month and the first
// subscription was no longer referenced anywhere it could be found.
// ---------------------------------------------------------------------------
describe("re-subscribing while the processor still holds a subscription", () => {
  for (const status of ["paused", "past_due"]) {
    it(`cancels the old Veyra subscription BEFORE minting a new one (${status})`, async () => {
      seed({ tier_id: TIER, status, billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });
      veyra.start.mockResolvedValue({ ok: true, membershipId: "veyra_new" });

      const result = await signup({ tokenIntentId: "tok_resubscribe" });

      expect(result.success).toBe(true);
      expect(veyra.cancel).toHaveBeenCalledWith("veyra_old", false);
      expect(veyra.cancel.mock.invocationCallOrder[0]).toBeLessThan(veyra.start.mock.invocationCallOrder[0]);
      expect(membership()?.veyra_membership_id).toBe("veyra_new");
    });
  }

  it("refuses to mint a second subscription when the old one cannot be cancelled", async () => {
    seed({ tier_id: TIER, status: "past_due", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: false });
    veyra.cancel.mockResolvedValue({ ok: false, message: "provider unavailable" });

    const result = await signup({ tokenIntentId: "tok_resubscribe" });

    expect(result.success).toBe(false);
    expect(veyra.start).not.toHaveBeenCalled();
    expect(membership()?.veyra_membership_id).toBe("veyra_old");
  });

  it("does not touch a subscription that is already winding down at the processor", async () => {
    // cancel_at_period_end means Veyra already agreed to stop; a second cancel
    // would cut the days the member paid for.
    seed({ tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_old", cancel_at_period_end: true });
    veyra.start.mockResolvedValue({ ok: true, membershipId: "veyra_new" });

    const result = await signup({ tokenIntentId: "tok_resubscribe" });

    expect(result.success).toBe(true);
    expect(veyra.cancel).not.toHaveBeenCalledWith("veyra_old", expect.anything());
  });
});
