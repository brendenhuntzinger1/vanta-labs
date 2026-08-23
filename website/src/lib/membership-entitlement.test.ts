import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PERKS STOP WHEN THE PAYMENT STOPS.
//
// getMembershipPerks is the single place the rest of the store asks "what is
// this customer entitled to?". Checkout reads memberDiscountPercent from it,
// shipping reads freeShipping, points read pointsPerDollar, store credit reads
// the balance.
//
// The invariant: an expired, cancelled or past-due membership must yield the
// SAME perks as no membership at all -- zero discount, no free shipping,
// free-tier points, no store credit. Anything else is a customer keeping paid
// benefits they have stopped paying for, indefinitely.
//
// There are two independent guards, and this file proves the load-bearing one:
//
//   1. getMembershipPerks zeroes every perk when isMembershipActive is false.
//   2. profit-engine additionally refuses membership pricing unless isMember.
//
// Guard 2 alone stays green when removed BECAUSE guard 1 already zeroed the
// percent -- which is exactly why guard 1 needs its own test rather than being
// assumed.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/membership");

const state: {
  membership: Record<string, unknown> | null;
  tier: Record<string, unknown>;
  freeTier: Record<string, unknown>;
  storeCreditCents: number;
} = {
  membership: null,
  tier: {},
  freeTier: {},
  storeCreditCents: 0,
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store-credit", () => ({
  getStoreCreditBalanceCents: async () => state.storeCreditCents,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      async maybeSingle() {
        if (table === "customer_memberships") return { data: state.membership, error: null };
        if (table === "membership_tiers") return { data: state.freeTier, error: null };
        return { data: null, error: null };
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        if (table === "membership_tiers") return Promise.resolve({ data: [state.freeTier], error: null }).then(resolve);
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

const PAID_TIER = {
  id: "tier-paid",
  slug: "plus",
  name: "Vanta Plus",
  member_discount_percent: 15,
  free_shipping: true,
  points_per_dollar: 3,
  store_credit_min_order_cents: 5000,
};

const FREE_TIER = {
  id: "tier-free",
  slug: "free",
  name: "Free",
  member_discount_percent: 0,
  free_shipping: false,
  points_per_dollar: 1,
  store_credit_min_order_cents: 0,
};

const DAY = 24 * 60 * 60 * 1000;

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-1",
    tier_id: PAID_TIER.id,
    status: "active",
    // Comfortably inside the paid period.
    next_billing_at: new Date(Date.now() + 20 * DAY).toISOString(),
    renews_at: new Date(Date.now() + 20 * DAY).toISOString(),
    membership_tiers: PAID_TIER,
    ...overrides,
  };
}

async function perks() {
  const { getMembershipPerks } = await import("@/lib/membership");
  return getMembershipPerks("user-1");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  state.membership = membershipRow();
  state.freeTier = FREE_TIER;
  state.storeCreditCents = 2500;
});

describe("an active paying member", () => {
  it("receives the tier's discount, free shipping and points rate", async () => {
    const p = await perks();
    expect(p.isActiveMember).toBe(true);
    expect(p.memberDiscountPercent).toBe(15);
    expect(p.freeShipping).toBe(true);
    expect(p.pointsPerDollar).toBe(3);
  });

  it("receives their store credit balance", async () => {
    expect((await perks()).storeCreditBalanceCents).toBe(2500);
  });

  it("is still entitled while trialing", async () => {
    state.membership = membershipRow({ status: "trialing" });
    expect((await perks()).isActiveMember).toBe(true);
  });
});

describe("a membership that has stopped paying", () => {
  const lapsed: Array<[string, Record<string, unknown>]> = [
    ["cancelled", { status: "cancelled" }],
    ["past_due", { status: "past_due" }],
    ["expired", { status: "expired" }],
    ["disabled", { status: "disabled" }],
    ["an unknown status", { status: "something_else" }],
  ];

  for (const [label, overrides] of lapsed) {
    it(`grants NOTHING for a ${label} membership`, async () => {
      state.membership = membershipRow(overrides);
      const p = await perks();
      expect(p.isActiveMember).toBe(false);
      expect(p.memberDiscountPercent).toBe(0);
      expect(p.freeShipping).toBe(false);
      expect(p.storeCreditMinOrderCents).toBe(0);
    });
  }

  it("grants NOTHING once the paid period has clearly ended, whatever the status says", async () => {
    // The date guard exists precisely so a stalled billing sweep cannot leave
    // a customer on paid perks forever: the row still says "active".
    state.membership = membershipRow({
      status: "active",
      next_billing_at: new Date(Date.now() - 90 * DAY).toISOString(),
      renews_at: new Date(Date.now() - 90 * DAY).toISOString(),
    });
    const p = await perks();
    expect(p.isActiveMember).toBe(false);
    expect(p.memberDiscountPercent).toBe(0);
    expect(p.freeShipping).toBe(false);
  });

  it("drops to the FREE tier points rate, never the old paid rate", async () => {
    state.membership = membershipRow({ status: "cancelled" });
    expect((await perks()).pointsPerDollar).toBe(1);
  });

  it("cannot spend store credit once lapsed", async () => {
    state.membership = membershipRow({ status: "cancelled" });
    expect((await perks()).storeCreditBalanceCents).toBe(0);
  });
});

describe("someone with no membership at all", () => {
  it("gets the same nothing a lapsed member gets", async () => {
    state.membership = null;
    const p = await perks();
    expect(p.isActiveMember).toBe(false);
    expect(p.memberDiscountPercent).toBe(0);
    expect(p.freeShipping).toBe(false);
  });
});

describe("the free tier is not a paid membership", () => {
  it("grants no member discount even while 'active'", async () => {
    // A free-tier row is active, but it must not read as a paying member --
    // otherwise the free tier silently becomes a paid one.
    state.membership = membershipRow({ tier_id: FREE_TIER.id, membership_tiers: FREE_TIER });
    const p = await perks();
    expect(p.memberDiscountPercent).toBe(0);
    expect(p.isActiveMember).toBe(false);
  });
});
