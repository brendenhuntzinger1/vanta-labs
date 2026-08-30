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
// WHY A DERIVED DISCOUNT IS WORTH PINNING. The template does not receive a
// discount figure. It computes a residual —
//
//     subtotal + shipping + tax + cardFee − total
//
// — and shows a positive residual as "Discounts & credits" and a negative one
// as "Shipping protection". That is a good design (points, store credit and a
// promo code all reduce the total without each needing a field), and it means
// a mistake anywhere upstream surfaces here as a wrong number rather than a
// missing line.
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
    expect(lines).not.toHaveProperty("Discounts & credits");
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
    expect(lines["Discounts & credits"]).toBe("-$20.00");
  });

  it("still shows the full subtotal and shipping beside it", () => {
    expect(lines.Subtotal).toBe("$177.00");
    expect(lines.Shipping).toBe("$15.00");
  });

  it("the lines sum to the total", () => {
    const n = (v: string) => Number(v.replace(/[$,]/g, ""));
    expect(n(lines.Subtotal) + n(lines.Shipping) + n(lines["Discounts & credits"]))
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
    expect(lines["Discounts & credits"]).toBe("-$20.00");
  });

  it("still sums to the total, which is the whole claim", () => {
    const n = (v: string) => Number(v.replace(/[$,]/g, ""));
    const fee = Number(
      (Object.entries(lines).find(([k]) => /fee/i.test(k))?.[1] ?? "$0.00").replace(/[$,]/g, ""),
    );
    expect(n(lines.Subtotal) + n(lines.Shipping) + n(lines["Sales tax"]) + fee
      + n(lines["Discounts & credits"])).toBeCloseTo(n(lines.Total), 2);
  });
});

describe("an order with shipping protection", () => {
  // An ADD-ON rather than a reduction: it is folded into the total and stored
  // in no column of its own, so the residual goes negative.
  const email = orderConfirmationTemplate({ ...base, discount: 0, total: 198.99 });
  const lines = moneyLines(email.html);

  it("shows the add-on as a charge, not as a negative discount", () => {
    expect(lines["Shipping protection"]).toBe("$6.99");
    expect(lines).not.toHaveProperty("Discounts & credits");
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
