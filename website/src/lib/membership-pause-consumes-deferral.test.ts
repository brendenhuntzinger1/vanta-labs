import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// PAUSE → RESUME IS A SKIP, AND IT IS CAPPED LIKE ONE.
//
// Veyra has no pause endpoint: pauseMembership defers the next charge one cycle
// (skip_cycle) and resumeMembership sets the row back to active with that
// deferred date intact. So one round trip bought a cycle of perks with no
// charge — exactly what "Skip next charge" grants, once per paid period — but
// with NO cap, because the once-per-period rule counted only `skip` rows and
// pause writes `pause`. Pause, resume, pause, resume … pushed the charge out a
// cycle every time while the member kept full perks and the monthly store
// credit grant.
//
// Now a pause spends the same single deferral a skip does, in the shared rule
// (membership-status.ts DEFERRAL_EVENT_TYPES), with the same date guard as
// defence in depth. A member can still pause once per paid period; a renewal
// starts a new period and restores the entitlement.
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

vi.mock("@/lib/billing-provider", () => ({
  getBillingProvider: () => ({ chargeCard: vi.fn(async () => ({ success: true })) }),
}));

const skipCycle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(async () => ({ ok: true, membershipId: "vey" })),
  cancelVeyraMembership: vi.fn(async () => ({ ok: true })),
  skipVeyraMembershipCycle: (...args: unknown[]) => skipCycle(...args),
  updateVeyraMembershipCard: vi.fn(async () => ({ ok: true })),
  changeVeyraMembershipPlan: vi.fn(async () => ({ ok: true })),
  resumeVeyraMembership: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "77777777-7777-7777-7777-777777777777";
const DAY = 24 * 60 * 60 * 1000;

function seed(row: Row, paidDaysAgo = 10) {
  db.current = createFakeDb();
  db.current.table("customer_memberships").push({
    user_id: USER,
    tier_id: "tier-pro",
    status: "active",
    billing_cycle: "monthly",
    cancel_at_period_end: false,
    next_billing_at: new Date(Date.now() + (30 - paidDaysAgo) * DAY).toISOString(),
    ...row,
  });
  db.current.table("membership_billing_events").push({
    user_id: USER, tier_id: "tier-pro", event_type: "renewal", amount_cents: 2900, status: "succeeded",
    created_at: new Date(Date.now() - paidDaysAgo * DAY).toISOString(),
  });
}

function membership() {
  return db.current.table("customer_memberships").find((row) => row.user_id === USER)!;
}

async function lib() {
  return import("@/lib/membership-billing");
}

beforeEach(() => {
  vi.resetModules();
  skipCycle.mockReset();
  // Veyra defers one cycle from the current date, as observed live.
  skipCycle.mockImplementation(async () => ({
    ok: true,
    nextRenewalAt: new Date(new Date(membership().next_billing_at as string).getTime() + 30 * DAY).toISOString(),
  }));
});

describe("the pause → resume loop on a processor-billed membership", () => {
  it("accepts ONE pause per paid period, then refuses the next with a reason", async () => {
    seed({ veyra_membership_id: "vey_1" });
    const { pauseMembership, resumeMembership } = await lib();

    await pauseMembership(USER);
    await resumeMembership(USER);
    expect(membership().status).toBe("active");

    await expect(pauseMembership(USER)).rejects.toThrow(/already deferred a charge this cycle/i);

    // One deferral at the processor, not two — and the row is still active.
    expect(skipCycle).toHaveBeenCalledTimes(1);
    expect(membership().status).toBe("active");
  });

  it("cannot push the charge out more than one cycle however many times it loops", async () => {
    seed({ veyra_membership_id: "vey_1" });
    const { pauseMembership, resumeMembership } = await lib();
    const originalNext = new Date(membership().next_billing_at as string).getTime();

    for (let i = 0; i < 4; i += 1) {
      try { await pauseMembership(USER); } catch { /* refused after the first */ }
      if (membership().status === "paused") await resumeMembership(USER);
    }

    const finalNext = new Date(membership().next_billing_at as string).getTime();
    expect(finalNext - originalNext).toBe(30 * DAY);
  });

  it("spends the same entitlement as Skip: a pause blocks a skip, and a skip blocks a pause", async () => {
    seed({ veyra_membership_id: "vey_1" });
    const { pauseMembership, resumeMembership, skipNextBilling } = await lib();

    await pauseMembership(USER);
    await resumeMembership(USER);
    await expect(skipNextBilling(USER)).rejects.toThrow(/already skipped/i);

    seed({ veyra_membership_id: "vey_1" });
    await skipNextBilling(USER);
    await expect(pauseMembership(USER)).rejects.toThrow(/already deferred/i);
    expect(membership().status).toBe("active");
  });

  it("allows a pause again once a new paid period has begun", async () => {
    seed({ veyra_membership_id: "vey_1" });
    const { pauseMembership, resumeMembership } = await lib();

    await pauseMembership(USER);
    await resumeMembership(USER);
    await expect(pauseMembership(USER)).rejects.toThrow(/already deferred/i);

    // The deferred renewal is charged: a new paid period. Dated a second on,
    // as it would be — the ledger is read newest first and a same-millisecond
    // tie with the pause row above would say nothing about the rule.
    db.current.table("membership_billing_events").push({
      user_id: USER, tier_id: "tier-pro", event_type: "renewal", amount_cents: 2900, status: "succeeded",
      created_at: new Date(Date.now() + 1000).toISOString(),
    });
    membership().next_billing_at = new Date(Date.now() + 25 * DAY).toISOString();

    await expect(pauseMembership(USER)).resolves.toMatchObject({ status: "paused" });
  });

  it("refuses a pause when the next charge is already a full cycle out, even with an empty ledger", async () => {
    // Defence in depth: a deferral that arrived some other way (a processor
    // side skip, a hand-edited date) must not be extended by a pause.
    seed({ veyra_membership_id: "vey_1", next_billing_at: new Date(Date.now() + 31 * DAY).toISOString() });
    db.current.table("membership_billing_events").length = 0;
    const { pauseMembership } = await lib();

    await expect(pauseMembership(USER)).rejects.toThrow(/already deferred/i);
    expect(skipCycle).not.toHaveBeenCalled();
  });

  it("refuses BEFORE touching the processor", async () => {
    seed({ veyra_membership_id: "vey_1" });
    db.current.table("membership_billing_events").push({
      user_id: USER, tier_id: "tier-pro", event_type: "pause", amount_cents: 0, status: "succeeded",
      created_at: new Date().toISOString(),
    });
    const { pauseMembership } = await lib();

    await expect(pauseMembership(USER)).rejects.toThrow(/already deferred/i);
    expect(skipCycle).not.toHaveBeenCalled();
  });
});

describe("the same cap on a locally-billed membership", () => {
  it("accepts one pause per paid period", async () => {
    seed({ veyra_membership_id: null });
    const { pauseMembership, resumeMembership } = await lib();

    await pauseMembership(USER);
    await resumeMembership(USER);
    await expect(pauseMembership(USER)).rejects.toThrow(/already deferred/i);
  });
});

describe("skipUsedThisPaidPeriod — the shared rule now counts a pause", () => {
  const paid = { eventType: "renewal", status: "succeeded", amountCents: 2900 };
  const pause = { eventType: "pause", status: "succeeded", amountCents: 0 };
  const skip = { eventType: "skip", status: "succeeded", amountCents: 0 };

  it("is true once a pause sits after the last paid event", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([pause, paid])).toBe(true);
    expect(skipUsedThisPaidPeriod([{ eventType: "resume", status: "succeeded", amountCents: 0 }, pause, paid])).toBe(true);
  });

  it("is false again once a new paid event sits on top of the pause", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([paid, pause, paid])).toBe(false);
  });

  it("still counts a skip, and does not count a failed pause", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([skip, paid])).toBe(true);
    expect(skipUsedThisPaidPeriod([{ eventType: "pause", status: "failed", amountCents: 0 }, paid])).toBe(false);
  });

  it("names both deferral types in one place", async () => {
    const { DEFERRAL_EVENT_TYPES } = await import("@/lib/membership-status");
    expect([...DEFERRAL_EVENT_TYPES].sort()).toEqual(["pause", "skip"]);
  });
});
