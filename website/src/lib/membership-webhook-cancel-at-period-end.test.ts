import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// membership.canceled IS NOT ALWAYS TERMINAL.
//
// Our own cancelMembership asks Veyra for `cancel at_period_end` and keeps the
// row active until the paid period runs out — the cancel confirmation tells
// the member exactly that. The webhook handler treated every
// membership.canceled as the end, so a period-end cancel echoed back with
// cancel_at_period_end=true and time still left flipped the row to cancelled
// on the spot: perks off for a period the member had paid for.
//
// A period-end cancel with time left is now recorded the way the app already
// represents a wind-down (cancel_at_period_end=true, status untouched). A
// cancel whose period has ended, or an immediate one, ends access now as
// before.
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

vi.mock("@/lib/billing-provider", () => ({ getBillingProvider: () => ({ chargeCard: vi.fn() }) }));
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

const alerts = vi.hoisted(() => [] as Array<{ type: string; severity: string; context?: Record<string, unknown> }>);
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (input: { type: string; severity: string; context?: Record<string, unknown> }) => { alerts.push(input); },
}));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "88888888-8888-8888-8888-888888888888";
const VEYRA_ID = "veyra_sub_9";
const DAY = 24 * 60 * 60 * 1000;

function seed(row: Row = {}) {
  db.current = createFakeDb();
  db.current.table("customer_memberships").push({
    user_id: USER,
    tier_id: "tier-pro",
    status: "active",
    billing_cycle: "monthly",
    veyra_membership_id: VEYRA_ID,
    cancel_at_period_end: false,
    cancelled_at: null,
    next_billing_at: new Date(Date.now() + 14 * DAY).toISOString(),
    ...row,
  });
}

function membership() {
  return db.current.table("customer_memberships").find((row) => row.user_id === USER)!;
}

async function canceled(data: Record<string, unknown>) {
  const { handleMembershipEvent } = await import("@/lib/membership-webhook");
  return handleMembershipEvent("membership.canceled", { membership_id: VEYRA_ID, ...data });
}

beforeEach(() => {
  vi.resetModules();
  alerts.length = 0;
  seed();
});

describe("membership.canceled with cancel_at_period_end=true and time left", () => {
  it("records a wind-down and keeps access until the period ends", async () => {
    const periodEnd = new Date(Date.now() + 14 * DAY).toISOString();

    const result = await canceled({ cancel_at_period_end: true, current_period_end: periodEnd });

    expect(result.handled).toBe(true);
    expect(membership().status).toBe("active");
    expect(membership().cancel_at_period_end).toBe(true);
    expect(membership().cancelled_at ?? null).toBeNull();
    // Veyra's period end is the authority on when access stops.
    expect(membership().next_billing_at).toBe(periodEnd);
    // The benefits gate agrees: still a member.
    const { isMembershipActive } = await import("@/lib/membership-status");
    expect(isMembershipActive({ status: String(membership().status), nextBillingAt: String(membership().next_billing_at), renewsAt: null })).toBe(true);
  });

  it("falls back to next_renewal_at, then to the local period end, when current_period_end is absent", async () => {
    await canceled({ cancel_at_period_end: true, next_renewal_at: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(membership().status).toBe("active");
    expect(membership().cancel_at_period_end).toBe(true);

    seed();
    await canceled({ cancel_at_period_end: true });
    expect(membership().status).toBe("active");
    expect(membership().cancel_at_period_end).toBe(true);
  });

  it("still records the cancel in the member's billing history", async () => {
    await canceled({ cancel_at_period_end: true, current_period_end: new Date(Date.now() + 14 * DAY).toISOString(), cancellation_reason: "customer request" });

    const events = db.current.table("membership_billing_events");
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("cancel");
    expect(String(events[0].failure_reason)).toMatch(/period end/i);
  });
});

describe("membership.canceled that really ends the membership", () => {
  it("ends access now when the flag is absent (an immediate cancel)", async () => {
    await canceled({});

    expect(membership().status).toBe("cancelled");
    expect(membership().cancelled_at).toBeTruthy();
  });

  it("ends access now when the flag is false", async () => {
    await canceled({ cancel_at_period_end: false, current_period_end: new Date(Date.now() + 14 * DAY).toISOString() });

    expect(membership().status).toBe("cancelled");
  });

  it("ends access now when the period end has already passed", async () => {
    seed({ next_billing_at: new Date(Date.now() - DAY).toISOString() });

    await canceled({ cancel_at_period_end: true, current_period_end: new Date(Date.now() - DAY).toISOString() });

    expect(membership().status).toBe("cancelled");
    expect(membership().cancelled_at).toBeTruthy();
  });

  it("ends access now when the flag is set but no period end can be found anywhere", async () => {
    seed({ next_billing_at: null });

    await canceled({ cancel_at_period_end: true });

    expect(membership().status).toBe("cancelled");
  });
});

describe("membership.payment_failed tells the operator", () => {
  it("raises a warning alert naming the member and the dunning attempt, and does not retry locally", async () => {
    const { handleMembershipEvent } = await import("@/lib/membership-webhook");

    await handleMembershipEvent("membership.payment_failed", { membership_id: VEYRA_ID, amount_cents: 2900, dunning_attempts: 2, next_retry_at: "2026-09-08T00:00:00.000Z" });

    expect(membership().status).toBe("past_due");
    const alert = alerts.find((a) => a.type === "membership_charge_failed");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
    expect(alert?.context).toMatchObject({ userId: USER, veyraMembershipId: VEYRA_ID, dunningAttempts: 2, lane: "veyra" });
  });
});
