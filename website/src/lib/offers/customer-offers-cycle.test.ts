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

import { readFileSync } from "node:fs";
import path from "node:path";
import { closeCustomerOfferCycle, reserveCustomerOffer } from "@/lib/offers/customer-offers";

const source = (rel: string) =>
  readFileSync(path.resolve(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("reserveCustomerOffer holds the gift for as long as the lane holds the stock", () => {
  beforeEach(() => {
    state.calls = [];
    state.result = { data: [] as unknown as number, error: null };
    state.throwOnRpc = false;
  });

  it("forwards the caller's hold to the database", async () => {
    await reserveCustomerOffer({ token: "tok-1", orderId: "order-1", email: "Buyer@Example.test", holdSeconds: 86_400 });
    expect(state.calls[0].fn).toBe("customer_offer_reserve");
    expect(state.calls[0].args).toMatchObject({ p_order_id: "order-1", p_email: "buyer@example.test", p_hold_seconds: 86_400 });
  });

  it("leaves the database's own default in place when no hold is named", async () => {
    await reserveCustomerOffer({ token: "tok-1", orderId: "order-1", email: "buyer@example.test" });
    expect(state.calls[0].args).not.toHaveProperty("p_hold_seconds");
  });

  it("the card lane and the manual lane pass the same hold they give the stock and the promotion slot", () => {
    const code = source("payment-service.ts");
    const reserveAt = code.indexOf("reserveCustomerOffer({");
    expect(reserveAt).toBeGreaterThan(0);
    const call = code.slice(reserveAt, code.indexOf("});", reserveAt));
    expect(call).toContain("holdSeconds: isManual ? MANUAL_CLAIM_HOLD_SECONDS : CLAIM_HOLD_SECONDS");
  });

  it("only a SALE closes the retention cycle: a membership plan or a replacement shipment leaves the gifts alone, in both paid lanes", () => {
    const code = source("payment-webhook.ts");
    const calls = code.split("closeCustomerOfferCycle({").length - 1;
    expect(calls).toBe(2);
    const guarded = code.match(/if \(!isMembershipOrder && isSaleOrder\([^)]*\)\) \{\s*await closeCustomerOfferCycle\(\{/g) ?? [];
    expect(guarded).toHaveLength(2);
  });
});

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

// PRICE-03. createCheckoutSession claims the promotion slot, then reserves the
// one-time offer. When the reserve refused, it threw without handing the
// promotion back — bxgy_count_redemptions counted the orphan claim as live for
// the hold window (15 min on card, 24 h on a manual method), so the retry the
// error message asks for found the promotion "exhausted" for that shopper.
describe("a refused offer reserve hands the promotion slot back", () => {
  it("releases the promotion claim before throwing, exactly as the insert-failure branch does", () => {
    const code = source("payment-service.ts");
    const reserveAt = code.indexOf("reserveCustomerOffer({");
    const refusal = code.indexOf("if (!reserved) {", reserveAt);
    expect(refusal).toBeGreaterThan(reserveAt);
    const branch = code.slice(refusal, code.indexOf("throw new Error(", refusal));
    expect(branch).toContain("await releasePromotionRedemption(orderId);");
    // Guarded the same way the claim itself is, so an order with no limited
    // promotion never touches the redemption table.
    expect(branch).toContain("if (quote.appliedPromotionId && quote.appliedPromotionLimits)");
  });
});

// PAY-09. The two failure branches AFTER the order row exists — item insert
// refused, stock reservation refused — must both hand the promotion slot and
// the gift token back and cancel the row, like the insert-failure branch above.
describe("every post-insert failure branch releases the checkout's claims", () => {
  it("item-insert failure and reservation refusal both release claims and cancel the order", () => {
    const code = source("payment-service.ts");
    for (const marker of ["if (itemInsertError) {", "if (!reservation.ok) {"]) {
      const at = code.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      const branch = code.slice(at, code.indexOf("throw new Error(", at));
      expect(branch, marker).toContain("await releaseAbandonedCheckoutClaims(orderId, quote);");
      expect(branch, marker).toContain('payment_status: "canceled"');
    }
    // The helper itself releases both kinds of claim, each guarded like the claim.
    const helperAt = code.indexOf("async function releaseAbandonedCheckoutClaims(");
    const helper = code.slice(helperAt, code.indexOf("export async function createCheckoutSession(", helperAt));
    expect(helper).toContain("if (quote.appliedPromotionId && quote.appliedPromotionLimits)");
    expect(helper).toContain("releasePromotionRedemption(orderId)");
    expect(helper).toContain("if (quote.appliedOffer)");
    expect(helper).toContain("releaseCustomerOffer(orderId)");
  });
});
