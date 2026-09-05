import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// "KEEP MY MEMBERSHIP" HAS TO REACH THE PROCESSOR.
//
// cancelMembership tells Veyra `cancel at_period_end`. resumeMembership then
// cleared the local cancel_at_period_end flag and stopped: the member read
// "Your membership will renew as normal. Nothing was charged." while Veyra
// still ended the subscription at period end. Nothing renewed, and the perks
// lapsed a few days later on a row that still said active.
//
// The rule is the one every other lifecycle call in membership-billing.ts
// already follows: tell Veyra FIRST, and only change local state if Veyra
// accepted. A refusal is an honest error, never a restored membership.
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

vi.mock("@/lib/billing-provider", () => ({
  getBillingProvider: () => ({ chargeCard: vi.fn(async () => ({ success: true })) }),
}));

const veyra = vi.hoisted(() => ({
  resume: vi.fn<(id: string) => Promise<{ ok: boolean; message?: string; nextRenewalAt?: string | null }>>(),
}));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(async () => ({ ok: true, membershipId: "vey" })),
  cancelVeyraMembership: vi.fn(async () => ({ ok: true })),
  skipVeyraMembershipCycle: vi.fn(async () => ({ ok: true })),
  updateVeyraMembershipCard: vi.fn(async () => ({ ok: true })),
  changeVeyraMembershipPlan: vi.fn(async () => ({ ok: true })),
  resumeVeyraMembership: (id: string) => veyra.resume(id),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "66666666-6666-6666-6666-666666666666";
const DAY = 24 * 60 * 60 * 1000;

function seed(row: Row) {
  db.current = createFakeDb();
  db.current.table("customer_memberships").push({ user_id: USER, tier_id: "tier-pro", ...row });
}

function membership() {
  return db.current.table("customer_memberships").find((row) => row.user_id === USER);
}

function events() {
  return db.current.table("membership_billing_events").map((row) => String(row.event_type));
}

async function resume() {
  const { resumeMembership } = await import("@/lib/membership-billing");
  return resumeMembership(USER);
}

const windingDown = () => ({
  status: "active",
  billing_cycle: "monthly",
  veyra_membership_id: "veyra_sub_1",
  cancel_at_period_end: true,
  cancelled_at: null,
  next_billing_at: new Date(Date.now() + 12 * DAY).toISOString(),
});

beforeEach(() => {
  vi.resetModules();
  veyra.resume.mockReset();
  veyra.resume.mockResolvedValue({ ok: true, nextRenewalAt: null });
});

describe("undoing a cancel-at-period-end on a processor-billed membership", () => {
  it("asks Veyra to restore renewal, then clears the wind-down locally", async () => {
    seed(windingDown());

    const result = await resume();

    expect(veyra.resume).toHaveBeenCalledWith("veyra_sub_1");
    expect(result.status).toBe("active");
    expect(membership()?.cancel_at_period_end).toBe(false);
    expect(membership()?.status).toBe("active");
    expect(events()).toEqual(["resume"]);
  });

  it("changes NOTHING and says so when Veyra refuses", async () => {
    veyra.resume.mockResolvedValue({ ok: false, message: "provider unavailable" });
    seed(windingDown());
    const before = { ...membership() };

    await expect(resume()).rejects.toThrow(/couldn't restore your membership/i);

    expect(membership()).toEqual(before);
    expect(membership()?.cancel_at_period_end).toBe(true);
    expect(events()).toEqual([]);
  });

  it("adopts the next charge date Veyra reports after restoring", async () => {
    const veyraDate = new Date(Date.now() + 9 * DAY).toISOString();
    veyra.resume.mockResolvedValue({ ok: true, nextRenewalAt: veyraDate });
    seed(windingDown());

    const result = await resume();

    expect(result.nextBillingAt).toBe(veyraDate);
    expect(membership()?.next_billing_at).toBe(veyraDate);
  });

  it("keeps the locally-stored date when Veyra reports none", async () => {
    const row = windingDown();
    seed(row);

    const result = await resume();

    expect(result.nextBillingAt).toBe(row.next_billing_at);
  });
});

describe("resuming other kinds of row", () => {
  it("does not call Veyra for a paused membership that is not ending — there is nothing to un-skip", async () => {
    seed({ status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_sub_1", cancel_at_period_end: false, next_billing_at: new Date(Date.now() + 40 * DAY).toISOString() });

    const result = await resume();

    expect(veyra.resume).not.toHaveBeenCalled();
    expect(result.status).toBe("active");
    expect(membership()?.status).toBe("active");
  });

  it("restores renewal at Veyra AND un-pauses a member who paused and then cancelled", async () => {
    // cancelMembership on a paused row leaves it paused and sets
    // cancel_at_period_end. Resuming that row has to undo both, and the
    // wind-down half lives at Veyra.
    seed({ status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_sub_1", cancel_at_period_end: true, next_billing_at: new Date(Date.now() + 40 * DAY).toISOString() });

    await resume();

    expect(veyra.resume).toHaveBeenCalledWith("veyra_sub_1");
    expect(membership()?.status).toBe("active");
    expect(membership()?.cancel_at_period_end).toBe(false);
  });

  it("leaves a paused-and-cancelled member paused when Veyra refuses to restore renewal", async () => {
    veyra.resume.mockResolvedValue({ ok: false, message: "no" });
    seed({ status: "paused", billing_cycle: "monthly", veyra_membership_id: "veyra_sub_1", cancel_at_period_end: true, next_billing_at: new Date(Date.now() + 40 * DAY).toISOString() });

    await expect(resume()).rejects.toThrow(/couldn't restore/i);

    expect(membership()?.status).toBe("paused");
    expect(membership()?.cancel_at_period_end).toBe(true);
  });

  it("clears the wind-down locally, with no processor call, for a locally-billed membership", async () => {
    seed({ ...windingDown(), veyra_membership_id: null });

    await resume();

    expect(veyra.resume).not.toHaveBeenCalled();
    expect(membership()?.cancel_at_period_end).toBe(false);
  });

  it("refuses to 'resume' an annual pass — its wind-down is the product, not a cancellation", async () => {
    seed({ status: "active", billing_cycle: "annual", veyra_membership_id: "veyra_annual", cancel_at_period_end: true, next_billing_at: new Date(Date.now() + 300 * DAY).toISOString() });

    await expect(resume()).rejects.toThrow(/don't auto-renew/i);

    expect(veyra.resume).not.toHaveBeenCalled();
    expect(membership()?.cancel_at_period_end).toBe(true);
  });

  it("still refuses a membership that is active and renewing", async () => {
    seed({ status: "active", billing_cycle: "monthly", veyra_membership_id: "veyra_sub_1", cancel_at_period_end: false });

    await expect(resume()).rejects.toThrow(/already active/i);
    expect(veyra.resume).not.toHaveBeenCalled();
  });
});
