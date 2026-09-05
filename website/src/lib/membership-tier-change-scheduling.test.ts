import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// NO UNPAID HIGHER TIER.
//
// A tier change used to switch the member's perks the moment it was requested
// and reprice only the NEXT charge. Pay for the cheapest tier, upgrade at once,
// enjoy the dearest tier's pricing, store credit and points until the next
// charge — or, on an annual pass, for the rest of the year — for nothing.
// Veyra's `change` endpoint takes an amount and an interval; it offers no
// supported proration or difference charge, so no billing logic is invented:
//
//   annual   refused while the pass is paid up (it never renews, so there is
//            no paid moment to attach the change to);
//   monthly  an upgrade is repriced at Veyra now and parked in
//            pending_tier_id; membership.renewed applies it;
//            a downgrade still applies at once.
// ---------------------------------------------------------------------------

const CHEAP = { id: "tier-core", slug: "core", name: "Core", monthly_price_cents: 2900, annual_price_cents: 29000, intro_price_cents: 0, intro_duration_days: 0, intro_offer_enabled: false, monthly_store_credit_cents: 0 };
const RICH = { id: "tier-elite", slug: "elite", name: "Elite", monthly_price_cents: 9900, annual_price_cents: 99000, intro_price_cents: 0, intro_duration_days: 0, intro_offer_enabled: false, monthly_store_credit_cents: 0 };

const state: {
  membership: Record<string, unknown> | null;
  updates: Record<string, unknown>[];
  events: Record<string, unknown>[];
} = { membership: null, updates: [], events: [] };

const changePlan = vi.fn(async (): Promise<{ ok: true; status?: string } | { ok: false; message: string }> => ({ ok: true, status: "active" }));

vi.unmock("@/lib/membership-billing");
vi.mock("server-only", () => ({}));
vi.mock("@/lib/veyra-membership", () => ({
  changeVeyraMembershipPlan: (...args: unknown[]) => changePlan(...(args as [])),
  startVeyraMembership: vi.fn(),
  cancelVeyraMembership: vi.fn(async () => ({ ok: true })),
  skipVeyraMembershipCycle: vi.fn(async () => ({ ok: true })),
  resumeVeyraMembership: vi.fn(async () => ({ ok: true })),
  updateVeyraMembershipCard: vi.fn(async () => ({ ok: true })),
  isAmexBrand: () => false,
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "membership_tiers") {
      return {
        select: () => ({
          eq: (_c: string, v: string) => ({
            maybeSingle: async () => ({ data: v === RICH.id ? RICH : v === CHEAP.id ? CHEAP : null, error: null }),
          }),
        }),
      };
    }
    if (table === "customer_memberships") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.membership, error: null }) }) }),
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            state.updates.push(payload);
            if (state.membership) Object.assign(state.membership, payload);
            return { error: null };
          },
        }),
      };
    }
    if (table === "membership_billing_events") {
      return { insert: async (row: Record<string, unknown>) => { state.events.push(row); return { error: null }; } };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), in: () => ({ data: [], error: null }) }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      upsert: async () => ({ error: null }),
    };
  };
  return {
    supabaseAdmin: {
      from,
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "m@example.test", user_metadata: { full_name: "A Member" } } }, error: null }) } },
    },
  };
});

async function change(tierId: string, billingCycle: "monthly" | "annual") {
  const { startMembershipSignup } = await import("@/lib/membership-billing");
  return startMembershipSignup({ userId: "user-1", tierId, billingCycle, tokenIntentId: "ti_fresh" } as never) as Promise<{
    success: boolean; changed?: boolean; scheduledFor?: string | null; error?: string;
  }>;
}

const IN_A_MONTH = new Date(Date.now() + 30 * 86_400_000).toISOString();
const IN_TEN_MONTHS = new Date(Date.now() + 300 * 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  changePlan.mockResolvedValue({ ok: true, status: "active" });
  state.updates = [];
  state.events = [];
});

describe("an annual member changing tier", () => {
  it("is refused while the paid year is running — no Veyra call, no perk change", async () => {
    state.membership = { user_id: "user-1", tier_id: CHEAP.id, status: "active", billing_cycle: "annual", cancel_at_period_end: true, veyra_membership_id: "v_1", next_billing_at: IN_TEN_MONTHS, renews_at: IN_TEN_MONTHS };
    const result = await change(RICH.id, "annual");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/annual Core pass runs through/);
    expect(changePlan).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
    expect(state.membership?.tier_id).toBe(CHEAP.id);
    expect(state.events.map((e) => [e.event_type, e.status])).toEqual([["tier_change", "failed"]]);
  });

  it("may pick a new tier once the pass has lapsed (falls through to the normal rejoin)", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    state.membership = { user_id: "user-1", tier_id: CHEAP.id, status: "active", billing_cycle: "annual", cancel_at_period_end: true, veyra_membership_id: "v_1", next_billing_at: past, renews_at: past };
    const result = await change(RICH.id, "annual");
    // Not the annual refusal: whatever the rejoin lane decides, the member was
    // not told their lapsed pass still blocks them.
    expect(result.error ?? "").not.toMatch(/pass runs through/);
  });
});

describe("a monthly member upgrading", () => {
  beforeEach(() => {
    state.membership = { user_id: "user-1", tier_id: CHEAP.id, status: "active", billing_cycle: "monthly", cancel_at_period_end: false, veyra_membership_id: "v_1", next_billing_at: IN_A_MONTH, renews_at: IN_A_MONTH, next_billing_amount_cents: 2900 };
  });

  it("reprices Veyra now but keeps the current perks until the renewal that pays for them", async () => {
    const result = await change(RICH.id, "monthly");
    expect(result).toMatchObject({ success: true, changed: true, scheduledFor: IN_A_MONTH });
    expect(changePlan).toHaveBeenCalledWith("v_1", expect.objectContaining({ amountCents: 9900 }));
    expect(state.membership?.tier_id).toBe(CHEAP.id);
    expect(state.membership?.pending_tier_id).toBe(RICH.id);
    expect(state.membership?.pending_tier_effective_at).toBe(IN_A_MONTH);
    expect(state.membership?.next_billing_amount_cents).toBe(9900);
    expect(state.events.map((e) => e.event_type)).toEqual(["tier_change_scheduled"]);
  });

  it("schedules nothing when Veyra refuses the reprice", async () => {
    changePlan.mockResolvedValue({ ok: false, message: "processor unavailable" });
    const result = await change(RICH.id, "monthly");
    expect(result.success).toBe(false);
    expect(state.membership?.pending_tier_id).toBeUndefined();
    expect(state.membership?.tier_id).toBe(CHEAP.id);
  });
});

describe("a monthly member downgrading", () => {
  it("applies at once and clears any upgrade still waiting", async () => {
    state.membership = { user_id: "user-1", tier_id: RICH.id, status: "active", billing_cycle: "monthly", cancel_at_period_end: false, veyra_membership_id: "v_1", next_billing_at: IN_A_MONTH, renews_at: IN_A_MONTH, pending_tier_id: RICH.id, pending_tier_effective_at: IN_A_MONTH };
    const result = await change(CHEAP.id, "monthly");
    expect(result).toMatchObject({ success: true, changed: true });
    expect((result as { scheduledFor?: unknown }).scheduledFor).toBeUndefined();
    expect(changePlan).toHaveBeenCalledWith("v_1", expect.objectContaining({ amountCents: 2900 }));
    expect(state.membership?.tier_id).toBe(CHEAP.id);
    expect(state.membership?.pending_tier_id).toBeNull();
    expect(state.membership?.next_billing_amount_cents).toBe(2900);
  });
});
