import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE JS HALF OF "A PAID ORDER CLOSES THE RETENTION CYCLE".
//
// customer-offers.test.ts (under sql/) proves customer_offer_close_cycle
// against a real Postgres. This pins the wrapper's contract: it normalises the
// address the way every other caller does, it never throws into the paid
// side-effects path, and it reports how many gifts died so the log says so.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  result: { data: 2 as number | null, error: null as null | { message: string } },
  throwOnRpc: false,
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (state.throwOnRpc) throw new Error("connection reset");
      state.calls.push({ fn, args });
      return state.result;
    }),
    from: () => { throw new Error("close-cycle must not touch the table directly"); },
  },
}));

import { closeCustomerOfferCycle } from "@/lib/offers/customer-offers";

describe("closeCustomerOfferCycle", () => {
  beforeEach(() => {
    state.calls = [];
    state.result = { data: 2, error: null };
    state.throwOnRpc = false;
  });

  it("calls the SQL function with the order id and the lower-cased address", async () => {
    const closed = await closeCustomerOfferCycle({ orderId: " order-1 ", email: "  Buyer@Example.TEST " });
    expect(closed).toBe(2);
    expect(state.calls).toEqual([
      { fn: "customer_offer_close_cycle", args: { p_order_id: "order-1", p_email: "buyer@example.test" } },
    ]);
  });

  it("does nothing without an order id or an address", async () => {
    expect(await closeCustomerOfferCycle({ orderId: "", email: "buyer@example.test" })).toBe(0);
    expect(await closeCustomerOfferCycle({ orderId: "order-1", email: null })).toBe(0);
    expect(await closeCustomerOfferCycle({ orderId: "order-1", email: undefined })).toBe(0);
    expect(state.calls).toHaveLength(0);
  });

  it("reports zero and never throws when the database refuses", async () => {
    state.result = { data: null, error: { message: "function does not exist" } };
    await expect(closeCustomerOfferCycle({ orderId: "order-1", email: "buyer@example.test" })).resolves.toBe(0);
  });

  it("reports zero and never throws when the client itself blows up", async () => {
    state.throwOnRpc = true;
    await expect(closeCustomerOfferCycle({ orderId: "order-1", email: "buyer@example.test" })).resolves.toBe(0);
  });

  it("treats a non-numeric answer as nothing closed", async () => {
    state.result = { data: "weird" as unknown as number, error: null };
    expect(await closeCustomerOfferCycle({ orderId: "order-1", email: "buyer@example.test" })).toBe(0);
  });
});
