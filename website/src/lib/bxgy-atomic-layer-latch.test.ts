import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB-03 — THE "ATOMIC LAYER IS MISSING" LATCH ONLY TRUSTS A DEFINITIVE ANSWER.
//
// noteMissingAtomicLayer flipped a module-level flag that was never reset, and
// it flipped on PGRST202 — PostgREST's "could not find the function", which it
// also answers for a moment after any migration or reload while its schema cache
// is stale. One such blip left that lambda withholding every limited promotion,
// and claiming none, until it was recycled. Now only Postgres saying the object
// does not exist (42883 / 42P01) latches; anything else is honoured for that
// call and re-checked on the next.
// ---------------------------------------------------------------------------

const rpc = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getHomepageControlConfig: async () => ({}),
  upsertControlValue: async () => {},
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }),
  },
}));

const PGRST202 = { data: null, error: { code: "PGRST202", message: "Could not find the function public.bxgy_count_redemptions" } };
const UNDEFINED_FUNCTION = { data: null, error: { code: "42883", message: "function bxgy_count_redemptions(uuid, text, integer) does not exist" } };
const COUNT = (n: number) => ({ data: n, error: null });

const LIMITED = [{ id: "promo-1", maxRedemptions: 100, perCustomerLimit: null }] as never;

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a transient PGRST202", () => {
  it("withholds limited promotions for THAT call only, and counts again on the next", async () => {
    rpc.mockResolvedValueOnce(PGRST202).mockResolvedValue(COUNT(3));
    const { getPromotionUsage } = await import("@/lib/bxgy-promotions");

    const during = await getPromotionUsage(LIMITED);
    expect(during.limitsEnforceable).toBe(false);

    const after = await getPromotionUsage(LIMITED);
    expect(after.limitsEnforceable).toBe(true);
    expect(after.exhaustedIds).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not switch claiming off for the rest of the process", async () => {
    rpc.mockResolvedValueOnce(PGRST202).mockResolvedValue({ data: false, error: null });
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    const input = { promotionId: "promo-1", orderId: "o-1", maxRedemptions: 1, perCustomerLimit: null };
    expect(await claimPromotionRedemption(input)).toBe(true); // could not reach the layer: fail open, as before
    expect(await claimPromotionRedemption(input)).toBe(false); // the layer is back and says the cap is reached
  });

  it("reports limits enforceable again once the layer answers", async () => {
    rpc.mockResolvedValueOnce(PGRST202).mockResolvedValue(COUNT(0));
    const { areUsageLimitsEnforceable } = await import("@/lib/bxgy-promotions");

    expect(await areUsageLimitsEnforceable()).toBe(false);
    expect(await areUsageLimitsEnforceable()).toBe(true);
  });
});

describe("a definitive 42883 undefined_function", () => {
  it("latches for the process — the migration has not been run, and that does not heal", async () => {
    rpc.mockResolvedValueOnce(UNDEFINED_FUNCTION).mockResolvedValue(COUNT(0));
    const { getPromotionUsage, areUsageLimitsEnforceable } = await import("@/lib/bxgy-promotions");

    expect((await getPromotionUsage(LIMITED)).limitsEnforceable).toBe(false);
    expect((await getPromotionUsage(LIMITED)).limitsEnforceable).toBe(false);
    expect(await areUsageLimitsEnforceable()).toBe(false);
    // No further round trips once it is known to be missing.
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("any other error", () => {
  it("is a bad minute, not a missing layer: the promotion keeps running and nothing latches", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })
      .mockResolvedValue(COUNT(0));
    const { getPromotionUsage } = await import("@/lib/bxgy-promotions");

    const during = await getPromotionUsage(LIMITED);
    expect(during.limitsEnforceable).toBe(true);
    expect(during.exhaustedIds).toEqual([]);
    expect((await getPromotionUsage(LIMITED)).limitsEnforceable).toBe(true);
  });
});
