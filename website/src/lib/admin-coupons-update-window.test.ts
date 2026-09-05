import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The start/end window was validated on CREATE only. An edit could move the
// start past the end and save a coupon that can never be redeemed while the
// list showed it as scheduled. update now runs the same check, against the
// EFFECTIVE pair — so editing one date alone cannot slip past it either.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  coupon: {
    id: "c-1", code: "SPRING", discount_type: "percent", discount_value: 10,
    starts_at: "2026-09-01T00:00:00.000Z", ends_at: "2026-09-30T00:00:00.000Z",
    max_redemptions: null, active: true, member_scope: "all", created_at: "2026-08-01T00:00:00.000Z",
  } as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { ...db.coupon }, error: null }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        db.updates.push(payload);
        Object.assign(db.coupon, payload);
        return {
          eq: () => ({
            select: () => ({ single: async () => ({ data: { ...db.coupon }, error: null }) }),
          }),
        };
      },
    }),
  },
}));

const { updateAdminCoupon } = await import("@/lib/admin-coupons");

beforeEach(() => {
  db.updates = [];
  db.coupon.starts_at = "2026-09-01T00:00:00.000Z";
  db.coupon.ends_at = "2026-09-30T00:00:00.000Z";
});

describe("updateAdminCoupon: the schedule window", () => {
  it("refuses a start after the end when both are in the request, and writes nothing", async () => {
    await expect(
      updateAdminCoupon("c-1", { startsAt: "2026-10-05T00:00:00.000Z", endsAt: "2026-10-01T00:00:00.000Z" }),
    ).rejects.toThrow("Start date must be before end date");
    expect(db.updates).toEqual([]);
  });

  it("refuses moving ONLY the start past the stored end", async () => {
    await expect(updateAdminCoupon("c-1", { startsAt: "2026-10-15T00:00:00.000Z" })).rejects.toThrow(
      "Start date must be before end date",
    );
    expect(db.updates).toEqual([]);
  });

  it("refuses moving ONLY the end before the stored start", async () => {
    await expect(updateAdminCoupon("c-1", { endsAt: "2026-08-15T00:00:00.000Z" })).rejects.toThrow(
      "Start date must be before end date",
    );
    expect(db.updates).toEqual([]);
  });

  it("accepts a valid window, and clearing one end", async () => {
    await expect(updateAdminCoupon("c-1", { startsAt: "2026-09-10T00:00:00.000Z" })).resolves.toMatchObject({
      startsAt: "2026-09-10T00:00:00.000Z",
    });
    await expect(updateAdminCoupon("c-1", { endsAt: null })).resolves.toMatchObject({ endsAt: null });
    // With no end, any start is fine.
    await expect(updateAdminCoupon("c-1", { startsAt: "2027-01-01T00:00:00.000Z" })).resolves.toBeTruthy();
  });

  it("leaves an unrelated edit alone", async () => {
    await expect(updateAdminCoupon("c-1", { active: false })).resolves.toMatchObject({ active: false });
    expect(db.updates).toHaveLength(1);
  });
});
