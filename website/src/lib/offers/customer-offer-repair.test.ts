import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SWEEP REDEEMS WHAT A DEAD WEBHOOK LEFT MERELY RESERVED.
//
// Only offers whose reserving order actually PAID are touched; an unpaid hold
// is a live checkout and stays alone. A paid reserver the RPC still refuses is
// reported, because the redemption record is what an operator will be missing.
// ---------------------------------------------------------------------------

const state = {
  offers: [] as Array<{ id: string; reserved_order_id: string | null }>,
  paidOrders: [] as string[],
  offersError: null as null | { message: string },
};
const redeem = vi.fn(async (_orderId: string) => true);
const alerts: Array<Record<string, unknown>> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/offers/customer-offers", () => ({ redeemCustomerOffer: (id: string) => redeem(id) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async (a: Record<string, unknown>) => { alerts.push(a); } }));
vi.mock("@/lib/supabase-server", () => {
  const chain = (table: string) => {
    let requestedIds: string[] = [];
    const b: Record<string, unknown> = {};
    for (const op of ["select", "not", "is", "order", "limit", "eq"]) b[op] = () => b;
    b.in = (col: string, values: string[]) => { if (col === "order_id") requestedIds = values; return b; };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === "customer_offers") return Promise.resolve({ data: state.offersError ? null : state.offers, error: state.offersError }).then(resolve);
      if (table === "orders") return Promise.resolve({ data: requestedIds.filter((id) => state.paidOrders.includes(id)).map((order_id) => ({ order_id })), error: null }).then(resolve);
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return b;
  };
  return { supabaseAdmin: { from: (table: string) => chain(table) } };
});

import { repairUnredeemedPaidOffers } from "@/lib/offers/customer-offer-repair";

beforeEach(() => {
  vi.clearAllMocks();
  redeem.mockResolvedValue(true);
  alerts.length = 0;
  state.offers = [];
  state.paidOrders = [];
  state.offersError = null;
});

describe("repairUnredeemedPaidOffers", () => {
  it("redeems the offer held by an order that paid, and leaves an unpaid hold alone", async () => {
    state.offers = [
      { id: "offer-paid", reserved_order_id: "order-paid" },
      { id: "offer-live", reserved_order_id: "order-in-checkout" },
    ];
    state.paidOrders = ["order-paid"];
    const result = await repairUnredeemedPaidOffers();
    expect(result).toEqual({ checked: 2, redeemed: 1, failed: 0 });
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(redeem).toHaveBeenCalledWith("order-paid");
    expect(alerts).toHaveLength(0);
  });

  it("alerts when a paid reserver still cannot be marked redeemed", async () => {
    state.offers = [{ id: "offer-1", reserved_order_id: "order-paid" }];
    state.paidOrders = ["order-paid"];
    redeem.mockResolvedValue(false);
    const result = await repairUnredeemedPaidOffers();
    expect(result).toEqual({ checked: 1, redeemed: 0, failed: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "customer_offer_redeem_failed", severity: "warning", context: { orderId: "order-paid", offerId: "offer-1" } });
  });

  it("does nothing, and does not throw, when the table cannot be read", async () => {
    state.offersError = { message: 'relation "customer_offers" does not exist' };
    await expect(repairUnredeemedPaidOffers()).resolves.toEqual({ checked: 0, redeemed: 0, failed: 0 });
    expect(redeem).not.toHaveBeenCalled();
  });

  it("is a clean no-op with nothing reserved", async () => {
    await expect(repairUnredeemedPaidOffers()).resolves.toEqual({ checked: 0, redeemed: 0, failed: 0 });
  });
});
