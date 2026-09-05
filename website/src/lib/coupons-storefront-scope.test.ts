import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PRICE-05. /api/coupons/featured advertises "the" store-wide coupon. Its lookup
// filtered on active / assigned_email / dates / is_private / redemption cap and
// never read member_scope, so a members-only (or non-members-only) code became
// the public featured code — and validateCoupon then refused it for most of the
// people who saw it. The banner now takes the viewer into account.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/coupons");
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: { coupons: Row[] } = { coupons: [] };

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const rows = () => (table === "coupons" ? db.coupons : []);
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        or() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: rows().map((r) => ({ ...r })), error: null }).then(resolve); },
      };
      return builder;
    },
  },
}));

function coupon(code: string, memberScope: string | null, overrides: Row = {}): Row {
  return {
    code,
    discount_type: "percent",
    discount_value: 10,
    ends_at: null,
    active: true,
    assigned_email: null,
    max_redemptions: null,
    redemptions_count: 0,
    is_private: false,
    member_scope: memberScope,
    ...overrides,
  };
}

beforeEach(() => { db.coupons = []; });

describe("couponScopeAdmitsViewer", () => {
  it("admits everyone to an 'all' code, and to a row written before the column existed", async () => {
    const { couponScopeAdmitsViewer } = await import("@/lib/coupons");
    expect(couponScopeAdmitsViewer("all", { isActiveMember: false })).toBe(true);
    expect(couponScopeAdmitsViewer("all", { isActiveMember: true })).toBe(true);
    expect(couponScopeAdmitsViewer(null, { isActiveMember: false })).toBe(true);
    expect(couponScopeAdmitsViewer(undefined, { isActiveMember: true })).toBe(true);
  });

  it("admits only a member to a members-only code", async () => {
    const { couponScopeAdmitsViewer } = await import("@/lib/coupons");
    expect(couponScopeAdmitsViewer("members", { isActiveMember: true })).toBe(true);
    expect(couponScopeAdmitsViewer("members", { isActiveMember: false })).toBe(false);
  });

  it("admits only a non-member to a non-members-only code", async () => {
    const { couponScopeAdmitsViewer } = await import("@/lib/coupons");
    expect(couponScopeAdmitsViewer("non_members", { isActiveMember: false })).toBe(true);
    expect(couponScopeAdmitsViewer("non_members", { isActiveMember: true })).toBe(false);
  });
});

describe("getStorefrontCoupon honours member_scope for the viewer", () => {
  it("does not publish a members-only code to a guest, and falls through to the next usable code", async () => {
    const { getStorefrontCoupon } = await import("@/lib/coupons");
    // Newest first, as the query orders them.
    db.coupons = [coupon("VIPONLY", "members"), coupon("EVERYONE", "all")];
    const featured = await getStorefrontCoupon({ isActiveMember: false });
    expect(featured?.code).toBe("EVERYONE");
  });

  it("publishes the members-only code to an active member", async () => {
    const { getStorefrontCoupon } = await import("@/lib/coupons");
    db.coupons = [coupon("VIPONLY", "members"), coupon("EVERYONE", "all")];
    const featured = await getStorefrontCoupon({ isActiveMember: true });
    expect(featured?.code).toBe("VIPONLY");
  });

  it("does not publish a non-members-only code to a member", async () => {
    const { getStorefrontCoupon } = await import("@/lib/coupons");
    db.coupons = [coupon("JOINUS", "non_members")];
    expect(await getStorefrontCoupon({ isActiveMember: true })).toBeNull();
    expect((await getStorefrontCoupon({ isActiveMember: false }))?.code).toBe("JOINUS");
  });

  it("with no viewer given, reads as a guest — the audience checkout assumes with no session", async () => {
    const { getStorefrontCoupon } = await import("@/lib/coupons");
    db.coupons = [coupon("VIPONLY", "members")];
    expect(await getStorefrontCoupon()).toBeNull();
  });

  it("the route resolves the viewer's membership and passes it in", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(`${process.cwd()}/src/app/api/coupons/featured/route.ts`, "utf8");
    expect(route).toContain("getMembershipPerks(user.id)");
    expect(route).toContain("getStorefrontCoupon({ isActiveMember })");
  });
});
