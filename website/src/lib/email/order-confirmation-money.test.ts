import { describe, expect, it } from "vitest";

import { orderConfirmationTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE NUMBERS IN THE RECEIPT.
//
// The confirmation email is the document a customer checks against their card
// statement, and it is the one they forward to support when the two disagree.
// Ten test files render this template while proving something else — a
// commission, an inventory latch, a webhook dedupe — and not one of them looks
// at the money.
//
// So the discount line, the shipping line and the arithmetic between them have
// never been asserted anywhere. The template's own comment claims the invariant
// that matters:
//
//     "ALWAYS sum to Total, whether the order had discounts, an add-on, or both"
//
// which is exactly the sort of claim that stays true right up until someone adds
// a fee. This checks it.
//
// WHY A DERIVED RESIDUAL IS WORTH PINNING. The template computes a residual —
//
//     subtotal + shipping + tax + cardFee − total
//
// — and splits what is left over after the promo discount into "Credits
// applied" when it is a reduction and "Shipping protection" when it is a
// charge. That is a good design for the parts that have no field of their own
// (points and store credit both reduce the total), and it means a mistake
// anywhere upstream surfaces here as a wrong number rather than a missing line.
//
// The promo discount is NOT one of those parts any more, and the label below
// changed with it. It used to share the residual's single "Discounts & credits"
// row, which meant an order carrying both a discount and shipping protection
// netted them together and printed the difference as the discount — $20 off
// against $15 of protection reported as "you saved $5". `discount` is a stored
// column every caller already passes, so it is now shown as itself and the
// residual covers only the remainder. Every assertion here is unchanged; only
// the row it reads is renamed.
// ---------------------------------------------------------------------------

const ITEMS = [
  { name: "Ipamorelin 5mg", quantity: 2, lineTotal: 118 },
  { name: "BPC-157 10mg", quantity: 1, lineTotal: 59 },
];

/** Every money figure the template rendered, as it appears to the customer. */
function moneyLines(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, label, value] of html.matchAll(
    /<td style="[^"]*">([A-Za-z][^<]*?)<\/td><td style="[^"]*">(-?\$[\d,]+\.\d{2})<\/td>/g,
  )) {
    out[label.replace(/&amp;/g, "&").trim()] = value;
  }
  return out;
}

const base = {
  customerName: "Journey Customer",
  orderId: "VL-1001",
  items: ITEMS,
  subtotal: 177,
  shipping: 15,
  tax: 0,
  cardProcessingFee: 0,
};

describe("an order with no discount", () => {
  const email = orderConfirmationTemplate({ ...base, discount: 0, total: 192 });
  const lines = moneyLines(email.html);

  it("shows the shipping the customer was charged", () => {
    expect(lines.Shipping).toBe("$15.00");
  });

  it("shows no discount line at all, rather than a zero one", () => {
    // A "-$0.00" line reads as a failed discount and generates a support email.
    expect(lines).not.toHaveProperty("Discount");
    expect(email.html).not.toContain("-$0.00");
  });

  it("totals what the customer paid", () => {
    expect(lines.Total).toBe("$192.00");
  });
});

describe("an order with a discount", () => {
  // $20 off: subtotal 177 + shipping 15 − 20 = 172.
  const email = orderConfirmationTemplate({ ...base, discount: 20, total: 172 });
  const lines = moneyLines(email.html);

  it("shows the discount as a reduction, not as a charge", () => {
    expect(lines.Discount).toBe("-$20.00");
  });

  it("still shows the full subtotal and shipping beside it", () => {
    expect(lines.Subtotal).toBe("$177.00");
    expect(lines.Shipping).toBe("$15.00");
  });

  it("the lines sum to the total", () => {
    const n = (v: string) => Number(v.replace(/[$,]/g, ""));
    expect(n(lines.Subtotal) + n(lines.Shipping) + n(lines.Discount))
      .toBeCloseTo(n(lines.Total), 2);
  });

  it("repeats the figures in the plain-text part", () => {
    // Gmail filed a message as spam and stripped its links on 2026-08-29; the
    // text part is what a stripped-down client shows.
    expect(email.text).toContain("172.00");
    expect(email.text).toMatch(/20\.00/);
  });
});

describe("an order with tax and a card fee as well", () => {
  // 177 + 15 + 12.50 tax + 4 fee − 20 discount = 188.50.
  const email = orderConfirmationTemplate({
    ...base, tax: 12.5, cardProcessingFee: 4, discount: 20, total: 188.5,
  });
  const lines = moneyLines(email.html);

  it("shows every component the customer was charged", () => {
    expect(lines["Sales tax"]).toBe("$12.50");
    expect(Object.keys(lines).some((k) => /fee/i.test(k))).toBe(true);
    expect(lines.Discount).toBe("-$20.00");
  });

  it("still sums to the total, which is the whole claim", () => {
    const n = (v: string) => Number(v.replace(/[$,]/g, ""));
    const fee = Number(
      (Object.entries(lines).find(([k]) => /fee/i.test(k))?.[1] ?? "$0.00").replace(/[$,]/g, ""),
    );
    expect(n(lines.Subtotal) + n(lines.Shipping) + n(lines["Sales tax"]) + fee
      + n(lines.Discount)).toBeCloseTo(n(lines.Total), 2);
  });
});

describe("an order with shipping protection", () => {
  // An ADD-ON rather than a reduction: it is folded into the total and stored
  // in no column of its own, so the residual goes negative.
  const email = orderConfirmationTemplate({ ...base, discount: 0, total: 198.99 });
  const lines = moneyLines(email.html);

  it("shows the add-on as a charge, not as a negative discount", () => {
    expect(lines["Shipping protection"]).toBe("$6.99");
    expect(lines).not.toHaveProperty("Discount");
  });

  it("sums to the total", () => {
    const n = (v: string) => Number(v.replace(/[$,]/g, ""));
    expect(n(lines.Subtotal) + n(lines.Shipping) + n(lines["Shipping protection"]))
      .toBeCloseTo(n(lines.Total), 2);
  });
});

describe("the line items themselves", () => {
  const email = orderConfirmationTemplate({ ...base, discount: 0, total: 192 });

  it("lists every item with its quantity and line total", () => {
    for (const item of ITEMS) {
      expect(email.html).toContain(`${item.name} × ${item.quantity}`);
      expect(email.html).toContain(`$${item.lineTotal.toFixed(2)}`);
    }
  });

  it("quotes the order number the customer holds", () => {
    expect(email.subject).toContain("VL-1001");
    expect(email.text).toContain("VL-1001");
  });
});

// ---------------------------------------------------------------------------
// EMAIL-02. Store credit / points AND shipping protection on the same order.
//
// The residual can only print the NET of the two. $20 of store credit against
// $6.99 of protection nets to $13.01, so the receipt said "Credits applied
// -$13.01" and showed no protection line: two false figures on the document a
// customer reconciles against their card statement, still summing to Total.
// Both are stored on the order row, so a caller that reads the row now passes
// them and each prints as itself. The residual remains the fallback.
// ---------------------------------------------------------------------------
describe("an order with store credit AND shipping protection", () => {
  const n = (v: string) => Number(v.replace(/[$,]/g, ""));
  // Subtotal 177 + shipping 15 − $20 credit + $6.99 protection = 178.99.
  const email = orderConfirmationTemplate({ ...base, discount: 0, total: 178.99, creditsApplied: 20, shippingProtectionFee: 6.99 });
  const lines = moneyLines(email.html);

  it("prints the credit the customer actually applied, not the net of credit and protection", () => {
    expect(lines["Credits applied"]).toBe("-$20.00");
  });

  it("prints the protection the customer actually paid, instead of omitting it", () => {
    expect(lines["Shipping protection"]).toBe("$6.99");
  });

  it("the lines still sum to the total", () => {
    expect(n(lines.Subtotal) + n(lines.Shipping) - n(lines["Credits applied"].replace("-", "")) + n(lines["Shipping protection"]))
      .toBeCloseTo(n(lines.Total), 2);
  });

  it("repeats both figures in the plain-text part", () => {
    expect(email.text).toContain("Credits applied: -$20.00");
    expect(email.text).toContain("Shipping protection: $6.99");
  });

  it("with a promo discount as well, all three print as themselves", () => {
    // 177 + 15 − 17.70 discount − 20 credit + 6.99 protection = 161.29
    const three = moneyLines(orderConfirmationTemplate({ ...base, discount: 17.7, total: 161.29, creditsApplied: 20, shippingProtectionFee: 6.99 }).html);
    expect(three.Discount).toBe("-$17.70");
    expect(three["Credits applied"]).toBe("-$20.00");
    expect(three["Shipping protection"]).toBe("$6.99");
    expect(n(three.Subtotal) + n(three.Shipping) - 17.7 - 20 + 6.99).toBeCloseTo(n(three.Total), 2);
  });

  it("a caller with neither figure gets the old inference — the fallback is unchanged", () => {
    const inferred = moneyLines(orderConfirmationTemplate({ ...base, discount: 0, total: 178.99 }).html);
    // Net of the two, exactly as before: the residual cannot know better.
    expect(inferred["Credits applied"]).toBe("-$13.01");
    expect(inferred).not.toHaveProperty("Shipping protection");
  });

  it("an inconsistent row still sums to Total: the leftover is folded rather than lost", () => {
    // The row claims $20 credit and $6.99 protection but the total implies $5 more came off.
    const folded = moneyLines(orderConfirmationTemplate({ ...base, discount: 0, total: 173.99, creditsApplied: 20, shippingProtectionFee: 6.99 }).html);
    expect(folded["Shipping protection"]).toBe("$6.99");
    expect(n(folded.Subtotal) + n(folded.Shipping) - n(folded["Credits applied"].replace("-", "")) + n(folded["Shipping protection"]))
      .toBeCloseTo(n(folded.Total), 2);
  });
});

describe("the figures every caller reads off the order row", () => {
  it("converts store credit from cents and points from a count, and passes the protection fee through", async () => {
    const { receiptAdjustmentsFromOrder } = await import("@/lib/email/order-confirmation-render");
    expect(receiptAdjustmentsFromOrder({ store_credit_redeemed_cents: 1500, points_redeemed: 500, shipping_protection_fee: 6.99 }))
      .toEqual({ creditsApplied: 20, shippingProtectionFee: 6.99 });
    expect(receiptAdjustmentsFromOrder({})).toEqual({ creditsApplied: 0, shippingProtectionFee: 0 });
  });

  it("both webhook lanes, the admin resend and the from-record renderer all pass them", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");
    const webhook = read("src/lib/payment-webhook.ts");
    expect((webhook.match(/receiptAdjustmentsFromOrder\(/g) ?? []).length).toBe(2);
    expect(webhook).toContain("shipping_protection_fee, amount_paid");
    expect(read("src/app/api/admin/payments/[orderId]/route.ts")).toContain("...receiptAdjustmentsFromOrder(order)");
    expect(read("src/lib/email/order-confirmation-render.ts")).toContain("...receiptAdjustmentsFromOrder(order)");
  });
});
