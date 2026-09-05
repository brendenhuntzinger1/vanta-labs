import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// THE RENEWAL IS THE MOMENT AN UPGRADE IS PAID FOR.
//
// A monthly upgrade is repriced at Veyra and parked in pending_tier_id
// (membership-billing.ts). membership.renewed is the first charge at the new
// price, so that is when the member moves onto the tier — never before, and
// exactly once.
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
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "77777777-7777-7777-7777-777777777777";
const VEYRA_ID = "veyra_sub_up";
const DAY = 24 * 60 * 60 * 1000;

function seed(row: Row = {}) {
  db.current = createFakeDb();
  db.current.table("customer_memberships").push({
    user_id: USER,
    tier_id: "tier-core",
    status: "active",
    billing_cycle: "monthly",
    veyra_membership_id: VEYRA_ID,
    cancel_at_period_end: false,
    next_billing_at: new Date(Date.now() + 1 * DAY).toISOString(),
    pending_tier_id: null,
    pending_tier_effective_at: null,
    ...row,
  });
}
function membership() {
  return db.current.table("customer_memberships").find((row) => row.user_id === USER)!;
}
async function renewed(data: Record<string, unknown> = {}) {
  const { handleMembershipEvent } = await import("@/lib/membership-webhook");
  return handleMembershipEvent("membership.renewed", {
    membership_id: VEYRA_ID,
    amount_charged_cents: 9900,
    next_renewal_at: new Date(Date.now() + 31 * DAY).toISOString(),
    ...data,
  });
}

beforeEach(() => {
  vi.resetModules();
});

describe("membership.renewed with an upgrade waiting", () => {
  it("moves the member onto the pending tier and clears the schedule", async () => {
    const effective = new Date(Date.now() + 1 * DAY).toISOString();
    seed({ pending_tier_id: "tier-elite", pending_tier_effective_at: effective });
    const result = await renewed();
    expect(result.handled).toBe(true);
    expect(membership().tier_id).toBe("tier-elite");
    expect(membership().pending_tier_id ?? null).toBeNull();
    expect(membership().pending_tier_effective_at ?? null).toBeNull();
    expect(membership().status).toBe("active");
  });

  it("books the renewal against the tier that was actually paid for", async () => {
    seed({ pending_tier_id: "tier-elite" });
    await renewed();
    const events = db.current.table("membership_billing_events").filter((e) => e.event_type === "renewal");
    expect(events).toHaveLength(1);
    expect(events[0].tier_id).toBe("tier-elite");
  });

  it("leaves the tier alone when nothing is scheduled", async () => {
    seed();
    await renewed();
    expect(membership().tier_id).toBe("tier-core");
    expect(membership().pending_tier_id ?? null).toBeNull();
  });
});
