import { describe, expect, it } from "vitest";
import { creditFundedOrderNotice } from "@/lib/credit-funded-order-notice";

// The profit floor is measured before store credit and points are applied.
// That ordering was deliberately left alone; this notice is how the owner sees
// the population it affects before setting policy on it.
describe("creditFundedOrderNotice", () => {
  const base = { orderId: "order-1", amountPaid: 0, storeCreditRedeemedCents: 0, pointsRedeemed: 0 };

  it("says nothing about an ordinary cash order", () => {
    expect(creditFundedOrderNotice({ ...base, amountPaid: 117 })).toBeNull();
  });

  it("says nothing when credit was applied but cash still carried the order", () => {
    // $20 of credit against $97 collected: the case the owner expects to be common.
    expect(creditFundedOrderNotice({ ...base, amountPaid: 97, storeCreditRedeemedCents: 2000 })).toBeNull();
  });

  it("reports an order the credit paid for more than the customer did", () => {
    const notice = creditFundedOrderNotice({ ...base, amountPaid: 25, storeCreditRedeemedCents: 7500 });

    expect(notice).not.toBeNull();
    expect(notice!.type).toBe("order_mostly_credit_funded");
    expect(notice!.severity).toBe("warning");
    expect(notice!.context.creditApplied).toBe(75);
    expect(notice!.context.cashCollected).toBe(25);
  });

  it("reports the near-zero-cash case this exists for", () => {
    const notice = creditFundedOrderNotice({ ...base, amountPaid: 0.5, storeCreditRedeemedCents: 7500 });
    expect(notice).not.toBeNull();
    expect(notice!.message).toContain("$0.50");
  });

  // A membership grants credit monthly; points are the other half of the same
  // question and must be valued by the SAME rule the profit engine uses.
  it("counts points at the shared redemption rate, not a local copy of 100", () => {
    // 1000 points === $10.00 via pointsToDollars.
    const notice = creditFundedOrderNotice({ ...base, amountPaid: 4, pointsRedeemed: 1000 });
    expect(notice).not.toBeNull();
    expect(notice!.context.pointsDollars).toBe(10);
    expect(notice!.context.creditApplied).toBe(10);
  });

  it("adds credit and points together before comparing", () => {
    // $6 credit + $5 points = $11 against $10 cash: neither alone exceeds it.
    const notice = creditFundedOrderNotice({
      ...base, amountPaid: 10, storeCreditRedeemedCents: 600, pointsRedeemed: 500,
    });
    expect(notice).not.toBeNull();
    expect(notice!.context.creditApplied).toBe(11);
  });

  // Firing on an exact split doubles the noise and surfaces nothing.
  it("stays quiet on an exact half-and-half split", () => {
    expect(creditFundedOrderNotice({ ...base, amountPaid: 50, storeCreditRedeemedCents: 5000 })).toBeNull();
  });

  it("treats missing and negative values as no tender rather than throwing", () => {
    expect(creditFundedOrderNotice({ ...base, amountPaid: 10, storeCreditRedeemedCents: -500 })).toBeNull();
    expect(creditFundedOrderNotice({
      ...base, amountPaid: undefined as unknown as number, storeCreditRedeemedCents: 100,
    })).not.toBeNull();
  });
});
