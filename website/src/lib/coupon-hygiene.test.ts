import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EXPIRED GENERATED COUPONS ARE CLOSED; OLD ABANDONED CARTS ARE EXPIRED.
//
// Production held 339 cart-recovery coupons, all past their ends_at, all still
// active = true, because nothing ever flipped them. The sweep step below is the
// thing that does — and only for codes the system minted itself.
// ---------------------------------------------------------------------------

type Call = { table: string; op: string; args: unknown[] };
const calls: Call[] = [];
const responses: Record<string, { data: unknown; error: unknown }> = {};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const chain = (table: string) => {
    const state: Call[] = [];
    const builder: Record<string, unknown> = {};
    const record = (op: string) => (...args: unknown[]) => {
      const call = { table, op, args };
      state.push(call);
      calls.push(call);
      return builder;
    };
    for (const op of ["update", "in", "eq", "not", "lt", "select"]) builder[op] = record(op);
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const response = responses[table] ?? { data: [], error: null };
      return Promise.resolve(response).then(resolve, reject);
    };
    return builder;
  };
  return { supabaseAdmin: { from: (table: string) => chain(table) } };
});

import { ABANDONED_CART_EXPIRY_MS, runCouponHygiene } from "@/lib/coupon-hygiene";

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(responses)) delete responses[key];
});

const NOW = new Date("2026-09-05T12:00:00.000Z");

describe("runCouponHygiene", () => {
  it("deactivates only generated coupons that are active and past their end", async () => {
    responses.coupons = { data: [{ id: "c1" }, { id: "c2" }], error: null };
    responses.abandoned_carts = { data: [], error: null };
    const result = await runCouponHygiene(NOW);
    expect(result.couponsDeactivated).toBe(2);

    const coupon = calls.filter((c) => c.table === "coupons");
    expect(coupon.map((c) => c.op)).toEqual(["update", "in", "eq", "not", "lt", "select"]);
    expect(coupon[0].args).toEqual([{ active: false }]);
    expect(coupon[1].args).toEqual(["source", ["cart_recovery"]]);
    expect(coupon[2].args).toEqual(["active", true]);
    expect(coupon[3].args).toEqual(["ends_at", "is", null]);
    expect(coupon[4].args).toEqual(["ends_at", NOW.toISOString()]);
  });

  it("expires abandoned carts still active once the 96h recovery window has closed", async () => {
    responses.coupons = { data: [], error: null };
    responses.abandoned_carts = { data: [{ id: "cart-1" }], error: null };
    const result = await runCouponHygiene(NOW);
    expect(result.cartsExpired).toBe(1);

    const carts = calls.filter((c) => c.table === "abandoned_carts");
    expect(carts.map((c) => c.op)).toEqual(["update", "eq", "lt", "select"]);
    expect(carts[0].args).toEqual([{ status: "expired" }]);
    expect(carts[1].args).toEqual(["status", "active"]);
    expect(carts[2].args).toEqual(["last_updated_at", new Date(NOW.getTime() - ABANDONED_CART_EXPIRY_MS).toISOString()]);
    expect(ABANDONED_CART_EXPIRY_MS).toBe(96 * 60 * 60 * 1000);
  });

  it("surfaces a database refusal instead of reporting a clean tick", async () => {
    responses.coupons = { data: null, error: new Error("permission denied") };
    await expect(runCouponHygiene(NOW)).rejects.toThrow("permission denied");
  });
});
