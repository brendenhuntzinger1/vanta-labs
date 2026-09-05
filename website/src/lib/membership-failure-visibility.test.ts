import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// A FAILED RENEWAL IS REPORTED, AND A STUCK MEMBER IS NOT FORGOTTEN.
//
// The sweep's handleChargeFailure wrote a billing event, flipped the row to
// past_due, emailed the member, and told nobody else — a renewal failure was
// a row on one admin screen. And a past_due row leaves every window the sweep
// looks at (it charges `active` rows only), so nothing ever looked at it
// again: no retry, no report, for ever.
//
// What is added, and what is deliberately NOT:
//
//   * every failed charge raises a warning alert (system_alerts + Sentry);
//   * members past_due for over a week are reported once a day, listing who;
//   * there is NO local retry. A retried charge keyed to the same period would
//     replay the same decline on an idempotent provider and risk a second
//     capture on one that is not, and the only lane with a live processor
//     (Veyra) already owns its own retries through dunning.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/membership-billing");

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    const client = db.current.client as unknown as Record<string, unknown>;
    client.auth = {
      admin: { getUserById: async () => ({ data: { user: { email: "m@example.test", user_metadata: {} } }, error: null }) },
    };
    return client;
  },
  createServerClient: () => db.current.client,
}));

const charge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing-provider", () => ({ getBillingProvider: () => ({ chargeCard: charge }) }));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(),
  cancelVeyraMembership: vi.fn(async () => ({ ok: true })),
  skipVeyraMembershipCycle: vi.fn(async () => ({ ok: true })),
  updateVeyraMembershipCard: vi.fn(async () => ({ ok: true })),
  changeVeyraMembershipPlan: vi.fn(async () => ({ ok: true })),
  resumeVeyraMembership: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));

const alerts = vi.hoisted(() => [] as Array<{ type: string; severity: string; message: string; context?: Record<string, unknown>; dedupeWindowMs?: number }>);
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (input: { type: string; severity: string; message: string; context?: Record<string, unknown>; dedupeWindowMs?: number }) => { alerts.push(input); },
}));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const DAY = 24 * 60 * 60 * 1000;

function member(row: Row): Row {
  return {
    user_id: "user-due",
    tier_id: "tier-pro",
    status: "active",
    billing_cycle: "monthly",
    intro_status: "converted",
    veyra_membership_id: null,
    cancel_at_period_end: false,
    renewal_reminder_sent_at: null,
    next_billing_amount_cents: 2900,
    next_billing_at: new Date(Date.now() - DAY).toISOString(),
    updated_at: new Date(Date.now() - 2 * DAY).toISOString(),
    ...row,
  };
}

function seedTier() {
  db.current.table("membership_tiers").push({ id: "tier-pro", slug: "pro", name: "Pro", monthly_price_cents: 2900, annual_price_cents: 29000, intro_price_cents: 0, intro_duration_days: 0, intro_offer_enabled: false, monthly_store_credit_cents: 0 });
}

async function sweep() {
  const { runMembershipBillingSweep } = await import("@/lib/membership-billing");
  return runMembershipBillingSweep();
}

beforeEach(() => {
  vi.resetModules();
  alerts.length = 0;
  charge.mockReset();
  charge.mockResolvedValue({ success: false, error: "card_declined" });
  db.current = createFakeDb();
  seedTier();
});

describe("a renewal that declines in the sweep", () => {
  it("moves the member to past_due AND raises a warning alert the operator can act on", async () => {
    db.current.table("customer_memberships").push(member({}));

    await sweep();

    const row = db.current.table("customer_memberships")[0];
    expect(row.status).toBe("past_due");
    const alert = alerts.find((a) => a.type === "membership_charge_failed");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
    expect(alert?.context).toMatchObject({ userId: "user-due", eventType: "renewal", amountCents: 2900, demotedToPastDue: true });
    expect(alert?.message).toMatch(/no local retry/i);
  });

  it("does not alert on a renewal that succeeds", async () => {
    charge.mockResolvedValue({ success: true, providerChargeId: "ch_ok" });
    db.current.table("customer_memberships").push(member({}));

    await sweep();

    expect(alerts.filter((a) => a.type === "membership_charge_failed")).toHaveLength(0);
  });
});

describe("members stuck past_due", () => {
  it("are never charged again by the sweep", async () => {
    db.current.table("customer_memberships").push(member({ status: "past_due", updated_at: new Date(Date.now() - 10 * DAY).toISOString() }));

    await sweep();

    expect(charge).not.toHaveBeenCalled();
  });

  it("are reported once a day, with who they are and which lane bills them", async () => {
    db.current.table("customer_memberships").push(
      member({ user_id: "user-local", status: "past_due", updated_at: new Date(Date.now() - 10 * DAY).toISOString() }),
      member({ user_id: "user-veyra", status: "past_due", veyra_membership_id: "vey_1", updated_at: new Date(Date.now() - 8 * DAY).toISOString() }),
    );

    const result = await sweep();

    expect(result.pastDueStalled).toBe(2);
    const alert = alerts.find((a) => a.type === "membership_past_due_stalled");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
    expect(alert?.dedupeWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(alert?.context).toMatchObject({ count: 2, veyraOwned: 1 });
    expect(alert?.context?.userIds).toEqual(expect.arrayContaining(["user-local", "user-veyra"]));
  });

  it("are not reported while the processor's dunning window is still fresh", async () => {
    db.current.table("customer_memberships").push(member({ status: "past_due", veyra_membership_id: "vey_1", updated_at: new Date(Date.now() - 2 * DAY).toISOString() }));

    const result = await sweep();

    expect(result.pastDueStalled).toBe(0);
    expect(alerts.find((a) => a.type === "membership_past_due_stalled")).toBeUndefined();
  });

  it("does not report members who are not past_due", async () => {
    db.current.table("customer_memberships").push(
      member({ user_id: "user-paused", status: "paused", next_billing_at: new Date(Date.now() + 20 * DAY).toISOString(), updated_at: new Date(Date.now() - 30 * DAY).toISOString() }),
      member({ user_id: "user-cancelled", status: "cancelled", next_billing_at: null, updated_at: new Date(Date.now() - 30 * DAY).toISOString() }),
    );

    const result = await sweep();

    expect(result.pastDueStalled).toBe(0);
  });
});
