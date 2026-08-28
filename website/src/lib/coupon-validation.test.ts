import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE DISCOUNT GATE.
//
// validateCoupon is the single server-side decision about whether money comes
// off an order. Every rule the owner sets in the admin -- expiry, redemption
// limit, member-only, assigned to one email, first-order-only -- is enforced
// here and nowhere else.
//
// WHY THIS FILE EXISTS
//
// EIGHT separate guards could each be deleted with all 2,773 existing tests
// green:
//
//   - the welcome offer's "first orders only" check (a returning customer
//     reuses it forever)
//   - the welcome offer's in-flight check (stack it across simultaneous tabs)
//   - the redemption limit
//   - the in-flight component of that limit (open N tabs before any pays)
//   - the expiry date
//   - the active flag
//   - the assigned-email restriction
//   - the member-only / non-member audience scope
//
// Every one of them is money leaving the business. None of them was proven.
// ---------------------------------------------------------------------------

const state: {
  welcome: { enabled: boolean; percent: number; code: string };
  coupon: Record<string, unknown> | null;
  priorPaidOrder: boolean;
  priorWelcomeUse: boolean;
  liveUses: number;
} = {
  welcome: { enabled: false, percent: 15, code: "WELCOME15" },
  coupon: null,
  priorPaidOrder: false,
  priorWelcomeUse: false,
  liveUses: 0,
};

// Every filter the `orders` reads applied, in order, so a test can assert HOW
// the guard matched and not only what it decided.
let ordersFilters: Array<Array<[string, string, unknown]>> = [];

// The suite-wide setup replaces @/lib/coupons with a stub whose validateCoupon
// always returns null. That stub is exactly why the eight guards below were
// invisible: the real function never ran in any test. Unmock it here so this
// file exercises the genuine implementation.
vi.unmock("@/lib/coupons");

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({ getWelcomeOffer: async () => state.welcome }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "orders") {
      return {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          const filters: Array<[string, string, unknown]> = [];
          ordersFilters.push(filters);
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
            ilike(c: string, v: unknown) { filters.push(["ilike", c, v]); return b; },
            not(c: string, op: string, v: unknown) { filters.push([`not.${op}`, c, v]); return b; },
            limit() { return b; },
            async maybeSingle() {
              const wantsPaid = filters.some(([op, c, v]) => op === "eq" && c === "payment_status" && v === "paid");
              if (wantsPaid) return { data: state.priorPaidOrder ? { id: "o1" } : null, error: null };
              // The welcome-code in-flight lookup.
              return { data: state.priorWelcomeUse ? { id: "o2" } : null, error: null };
            },
            then(resolve: (v: { count: number; error: null }) => unknown) {
              // The counting query for the redemption limit.
              void opts;
              return Promise.resolve({ count: state.liveUses, error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }
    if (table === "coupons") {
      return {
        select: () => ({
          ilike: () => ({ maybeSingle: async () => ({ data: state.coupon, error: null }) }),
        }),
      };
    }
    return { select: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  };
  return { supabaseAdmin: { from } };
});

async function validate(
  code: string,
  subtotal = 200,
  email?: string,
  context?: { isActiveMember?: boolean },
) {
  const { validateCoupon } = await import("@/lib/coupons");
  return validateCoupon(code, subtotal, email, context);
}

function coupon(overrides: Record<string, unknown> = {}) {
  return {
    code: "SAVE20",
    discount_type: "percent",
    discount_value: 20,
    starts_at: null,
    ends_at: null,
    max_redemptions: null,
    redemptions_count: 0,
    active: true,
    assigned_email: null,
    member_scope: "all",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.welcome = { enabled: false, percent: 15, code: "WELCOME15" };
  state.coupon = coupon();
  state.priorPaidOrder = false;
  state.priorWelcomeUse = false;
  state.liveUses = 0;
  ordersFilters = [];
});

describe("an ordinary valid coupon", () => {
  it("applies the discount", async () => {
    const result = await validate("SAVE20");
    expect(result?.discountAmount).toBe(40);
  });

  it("matches case-insensitively", async () => {
    const result = await validate("save20");
    expect(result?.discountAmount).toBe(40);
  });
});

describe("a coupon the owner has switched off or timed out", () => {
  it("refuses an inactive coupon", async () => {
    state.coupon = coupon({ active: false });
    await expect(validate("SAVE20")).rejects.toThrow(/invalid/i);
  });

  it("refuses an expired coupon", async () => {
    state.coupon = coupon({ ends_at: "2020-01-01T00:00:00.000Z" });
    await expect(validate("SAVE20")).rejects.toThrow(/expired/i);
  });

  it("refuses a coupon that has not started yet", async () => {
    state.coupon = coupon({ starts_at: "2999-01-01T00:00:00.000Z" });
    await expect(validate("SAVE20")).rejects.toThrow(/not active yet/i);
  });

  it("refuses an unknown code", async () => {
    state.coupon = null;
    await expect(validate("NOSUCHCODE")).rejects.toThrow(/invalid/i);
  });
});

describe("the redemption limit", () => {
  it("allows a redemption below the limit", async () => {
    state.coupon = coupon({ max_redemptions: 5, redemptions_count: 4 });
    state.liveUses = 4;
    await expect(validate("SAVE20")).resolves.toBeTruthy();
  });

  it("refuses once the settled count reaches the limit", async () => {
    state.coupon = coupon({ max_redemptions: 5, redemptions_count: 5 });
    await expect(validate("SAVE20")).rejects.toThrow(/redemption limit/i);
  });

  it("counts IN-FLIGHT orders too, so N tabs cannot beat a one-time code", async () => {
    // The classic abuse: open the code in several tabs before any of them
    // pays. redemptions_count only moves after settlement, so counting live
    // orders is the only thing that stops it.
    state.coupon = coupon({ max_redemptions: 1, redemptions_count: 0 });
    state.liveUses = 1;
    await expect(validate("SAVE20")).rejects.toThrow(/redemption limit/i);
  });

  it("takes the LARGER of the settled and in-flight counts", async () => {
    state.coupon = coupon({ max_redemptions: 3, redemptions_count: 3 });
    state.liveUses = 0;
    await expect(validate("SAVE20")).rejects.toThrow(/redemption limit/i);
  });
});

describe("a coupon tied to one customer", () => {
  it("refuses a different email", async () => {
    state.coupon = coupon({ assigned_email: "owner@example.test" });
    await expect(validate("SAVE20", 200, "someone-else@example.test")).rejects.toThrow(/different email/i);
  });

  it("accepts the assigned email regardless of casing", async () => {
    state.coupon = coupon({ assigned_email: "Owner@Example.test" });
    await expect(validate("SAVE20", 200, "owner@example.test")).resolves.toBeTruthy();
  });

  it("refuses when no email is supplied at all", async () => {
    state.coupon = coupon({ assigned_email: "owner@example.test" });
    await expect(validate("SAVE20", 200, undefined)).rejects.toThrow(/different email/i);
  });
});

describe("audience scope", () => {
  it("refuses a members-only coupon for a non-member", async () => {
    state.coupon = coupon({ member_scope: "members" });
    await expect(validate("SAVE20", 200, undefined, { isActiveMember: false })).rejects.toThrow(/exclusive to active members/i);
  });

  it("allows a members-only coupon for a member", async () => {
    state.coupon = coupon({ member_scope: "members" });
    await expect(validate("SAVE20", 200, undefined, { isActiveMember: true })).resolves.toBeTruthy();
  });

  it("refuses a non-members coupon for a member", async () => {
    state.coupon = coupon({ member_scope: "non_members" });
    await expect(validate("SAVE20", 200, undefined, { isActiveMember: true })).rejects.toThrow(/for non-members/i);
  });
});

describe("the welcome offer is for first orders only", () => {
  beforeEach(() => {
    state.welcome = { enabled: true, percent: 15, code: "WELCOME15" };
  });

  it("applies for a genuinely new customer", async () => {
    const result = await validate("WELCOME15", 200, "new@example.test");
    expect(result?.discountAmount).toBe(30);
  });

  it("REFUSES a customer who already has a paid order", async () => {
    state.priorPaidOrder = true;
    // Otherwise the welcome discount becomes a permanent standing discount for
    // every returning customer.
    await expect(validate("WELCOME15", 200, "returning@example.test")).rejects.toThrow(/first orders only/i);
  });

  it("REFUSES a customer whose earlier unpaid order already carries the code", async () => {
    state.priorWelcomeUse = true;
    // Closes the stacking loophole: several simultaneous unpaid orders all
    // carrying the code before any of them settles.
    await expect(validate("WELCOME15", 200, "stacker@example.test")).rejects.toThrow(/first orders only/i);
  });

  it("does not apply when the owner has switched the offer off", async () => {
    state.welcome = { enabled: false, percent: 15, code: "WELCOME15" };
    state.coupon = null;
    await expect(validate("WELCOME15", 200, "new@example.test")).rejects.toThrow(/invalid/i);
  });

  it("does not apply at zero percent", async () => {
    state.welcome = { enabled: true, percent: 0, code: "WELCOME15" };
    state.coupon = null;
    await expect(validate("WELCOME15", 200, "new@example.test")).rejects.toThrow(/invalid/i);
  });
});

// ---------------------------------------------------------------------------
// HOW the guards match, not just what they decide.
//
// Both `orders` reads used to match the coupon with ILIKE. There is nothing to
// fold — normalizeCouponCode has already uppercased the code and stripped
// everything outside [A-Z0-9-], so no wildcard can survive it — but ILIKE is
// not indexable, so Postgres could only apply it as a filter over every
// coupon-bearing order. The redemption-limit read runs on the create-session
// path for every checkout carrying a limited coupon, which is exactly when a
// promo is live and order volume is at its highest.
//
// These assert the predicate itself, because a test on the DECISION passes
// either way: `=` and ILIKE agree on every value the app can store.
// ---------------------------------------------------------------------------
describe("the coupon_code predicate is indexable", () => {
  const couponCodeFilters = () =>
    ordersFilters.flat().filter(([, column]) => column === "coupon_code");

  it("matches the redemption-limit count with equality, not ILIKE", async () => {
    state.coupon = coupon({ max_redemptions: 5 });
    state.liveUses = 1;

    await validate("SAVE20");

    const applied = couponCodeFilters();
    expect(applied).toContainEqual(["eq", "coupon_code", "SAVE20"]);
    expect(applied.map(([op]) => op)).not.toContain("ilike");
  });

  it("matches the welcome-offer in-flight lookup with equality, not ILIKE", async () => {
    state.welcome = { enabled: true, percent: 15, code: "WELCOME15" };
    state.coupon = null;

    await validate("WELCOME15", 200, "new@example.test");

    const applied = couponCodeFilters();
    expect(applied).toContainEqual(["eq", "coupon_code", "WELCOME15"]);
    expect(applied.map(([op]) => op)).not.toContain("ilike");
  });
});
