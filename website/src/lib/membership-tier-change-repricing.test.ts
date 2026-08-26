import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// D-05 — THE UPGRADE THAT MOVES THE PERKS BUT NOT THE PRICE.
//
// startMembershipSignup handles an upgrade/downgrade by updating tier_id and
// next_billing_amount_cents in customer_memberships, recording a tier_change
// event, and reconciling store credit. It never tells Veyra.
//
// Veyra owns the subscription. It has a `change` endpoint — veyra-membership.ts's
// own comment lists it, verified 2026-08-03 — and this codebase does not wrap it.
// So the member's perks switch to the new tier immediately while their card keeps
// being billed the OLD tier's amount, forever. Every subsequent
// membership.renewed webhook carries the old price.
//
// This is the same failure shape that file's own header calls out for pause,
// cancel and card updates: local-only state for a subscription somebody else
// owns. Those three were fixed. The tier change was not.
// ---------------------------------------------------------------------------

const CHEAP_TIER = {
  id: "tier-cheap",
  name: "Core",
  monthly_price_cents: 2900,
  annual_price_cents: null,
  intro_price_cents: 0,
  monthly_store_credit_cents: 0,
};

const RICH_TIER = {
  id: "tier-rich",
  name: "Elite",
  monthly_price_cents: 9900,
  annual_price_cents: null,
  intro_price_cents: 0,
  monthly_store_credit_cents: 0,
};

const state: {
  membership: Record<string, unknown> | null;
  membershipUpdates: Record<string, unknown>[];
  billingEvents: Record<string, unknown>[];
} = { membership: null, membershipUpdates: [], billingEvents: [] };

type LifecycleResult = { ok: true; status?: string } | { ok: false; message: string };

const changeVeyraMembershipPlan = vi.fn(
  async (): Promise<LifecycleResult> => ({ ok: true, status: "active" }),
);

// vitest.setup.ts replaces this whole module with two stubs, so nothing in the
// repo can exercise startMembershipSignup - the function that takes membership
// money - until it is unmocked. See D-06.
vi.unmock("@/lib/membership-billing");

vi.mock("server-only", () => ({}));
vi.mock("@/lib/veyra-membership", () => ({
  changeVeyraMembershipPlan,
  startVeyraMembership: vi.fn(),
  isAmexBrand: () => false,
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/retry-queue", () => ({ enqueueFailedEmail: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "membership_tiers") {
      return {
        select: () => ({
          eq: (_c: string, v: string) => ({
            maybeSingle: async () => ({
              data: v === RICH_TIER.id ? RICH_TIER : v === CHEAP_TIER.id ? CHEAP_TIER : null,
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "customer_memberships") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.membership, error: null }) }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            state.membershipUpdates.push(payload);
            if (state.membership) Object.assign(state.membership, payload);
            return { error: null };
          },
        }),
      };
    }
    if (table === "membership_billing_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.billingEvents.push(row);
          return { error: null };
        },
      };
    }
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      upsert: async () => ({ error: null }),
    };
  };
  return {
    supabaseAdmin: {
      from,
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: { email: "member@example.test", user_metadata: { full_name: "A Member" } } },
            error: null,
          }),
        },
      },
    },
  };
});

async function upgrade() {
  const { startMembershipSignup } = await import("@/lib/membership-billing");
  return startMembershipSignup({
    userId: "user-1",
    tierId: RICH_TIER.id,
    billingCycle: "monthly",
    tokenIntentId: "ti_fresh_capture",
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  changeVeyraMembershipPlan.mockResolvedValue({ ok: true, status: "active" });
  state.membershipUpdates = [];
  state.billingEvents = [];
  state.membership = {
    user_id: "user-1",
    tier_id: CHEAP_TIER.id,
    status: "active",
    billing_cycle: "monthly",
    cancel_at_period_end: false,
    veyra_membership_id: "veyra_mem_123",
    next_billing_amount_cents: CHEAP_TIER.monthly_price_cents,
  };
});

describe("upgrading to a more expensive tier", () => {
  it("tells Veyra to reprice the subscription it actually bills", async () => {
    await upgrade();
    expect(changeVeyraMembershipPlan).toHaveBeenCalledTimes(1);
    const [membershipId, payload] = changeVeyraMembershipPlan.mock.calls[0] as unknown as [
      string,
      { amountCents: number },
    ];
    expect(membershipId).toBe("veyra_mem_123");
    expect(payload.amountCents).toBe(RICH_TIER.monthly_price_cents);
  });

  it("does not move the member onto the new tier when Veyra refuses the reprice", async () => {
    changeVeyraMembershipPlan.mockResolvedValue({ ok: false, message: "processor unavailable" });

    const result = (await upgrade()) as { success: boolean };
    expect(result.success).toBe(false);

    // Perks must not switch while the card is still billed the old price.
    expect(state.membership?.tier_id).toBe(CHEAP_TIER.id);
    expect(state.membership?.next_billing_amount_cents).toBe(CHEAP_TIER.monthly_price_cents);
  });

  it("records the failed reprice as a failed attempt, never as a succeeded tier change", async () => {
    changeVeyraMembershipPlan.mockResolvedValue({ ok: false, message: "nope" });
    await upgrade();

    const tierChanges = state.billingEvents.filter((e) => e.event_type === "tier_change");
    // The attempt IS worth recording — a member who tried to upgrade and could
    // not needs to be explicable — but never as a success.
    expect(tierChanges).toHaveLength(1);
    expect(tierChanges[0]?.status).toBe("failed");
    expect(state.billingEvents.some((e) => e.status === "succeeded")).toBe(false);
  });

  it("still changes tier locally when there is no processor subscription to reprice", async () => {
    // Charged once, nothing at Veyra: there is no ongoing subscription billing
    // the old price, so nothing to keep in sync.
    state.membership!.veyra_membership_id = null;

    const result = (await upgrade()) as { success: boolean };
    expect(result.success).toBe(true);
    expect(changeVeyraMembershipPlan).not.toHaveBeenCalled();
    expect(state.membership?.tier_id).toBe(RICH_TIER.id);
  });
});
