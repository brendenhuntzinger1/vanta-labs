import { describe, expect, it } from "vitest";

import { orderConfirmationTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE RECEIPT'S DISCOUNT LINE, WHEN THE ORDER ALSO HAS AN ADD-ON.
//
// orderConfirmationTemplate takes a `discount` and never read it. Every money
// line below Shipping came from ONE residual:
//
//     residual = subtotal + shipping + tax + cardFee − total
//     savings  = max(0,  residual)   -> "Discounts & credits"
//     addOn    = max(0, −residual)   -> "Shipping protection"
//
// That keeps the lines summing to Total, which is the property it was written
// for and worth keeping. But savings and addOn are the two halves of ONE
// number, so an order that has both cancels them against each other and the
// receipt reports the difference as though it were the discount.
//
// A £20 promo on an order that also bought £15 of shipping protection nets to
// £5, and the customer is told they saved five pounds, with no protection line
// at all to explain where the other fifteen went. The figure is not rounded or
// approximate — it is a different number, on the document people keep for their
// records and reconcile against their card statement.
//
// discount_amount is a stored column, passed in by every caller
// (payment-webhook.ts:1468, admin/orders, admin/payments). It was the one
// number on the receipt that did not have to be inferred, and it was inferred.
// ---------------------------------------------------------------------------

/** Pull "Label | value" pairs out of the rendered summary table. */
function summaryLines(html: string) {
  const out: Array<[string, string]> = [];
  const rowRe = /<tr><td style="[^"]*">([^<]+)<\/td><td style="[^"]*">([^<]+)<\/td><\/tr>/g;
  for (const [, label, value] of html.matchAll(rowRe)) {
    out.push([label.replace(/&amp;/g, "&").trim(), value.trim()]);
  }
  return out;
}

const line = (html: string, label: string) =>
  summaryLines(html).find(([l]) => l === label)?.[1];

/**
 * Every money line below the items, signed the way the receipt shows it.
 *
 * Accumulation starts AFTER the Subtotal row on purpose: the item rows share
 * the summary rows' markup, so a regex that takes every <tr> would add each
 * line total a second time and report a mismatch on a receipt that is fine.
 */
function reconciles(html: string, subtotal: number, total: number) {
  // Magnitude only — the sign comes from the leading "-" the receipt prints, so
  // keeping it here too would negate a discount twice and turn it into a charge.
  const num = (v: string | undefined) => (v ? Number(v.replace(/[^0-9.]/g, "")) : 0);
  const lines = summaryLines(html);
  const start = lines.findIndex(([l]) => l === "Subtotal");
  let running = subtotal;
  for (const [label, value] of lines.slice(start + 1)) {
    if (label === "Total") continue;
    running += value.startsWith("-") ? -num(value) : num(value);
  }
  return Math.abs(running - total) < 0.005;
}

describe("the discount on an order confirmation receipt", () => {
  it("shows the real promo discount when the order ALSO bought shipping protection", () => {
    // £20 off, £15 of protection. The residual is +5, and the old code called
    // that "Discounts & credits -$5.00" with no protection row.
    const { html } = orderConfirmationTemplate({
      customerName: "Ada",
      orderId: "VL-1",
      items: [{ name: "BPC-157", quantity: 1, lineTotal: 100 }],
      subtotal: 100,
      shipping: 10,
      discount: 20,
      total: 105,
    });

    expect(line(html, "Discount"), "the promo discount is not shown as itself").toBe("-$20.00");
    expect(line(html, "Shipping protection"), "the add-on vanished into the discount").toBe("$15.00");
    expect(reconciles(html, 100, 105), "the lines no longer sum to the charged total").toBe(true);
  });

  it("still separates a discount from points and store credit", () => {
    // £20 promo plus £10 of points. Both are reductions, but only one of them
    // is the discount, and only the discount is a stored figure.
    const { html } = orderConfirmationTemplate({
      customerName: "Ada",
      orderId: "VL-2",
      items: [{ name: "BPC-157", quantity: 1, lineTotal: 100 }],
      subtotal: 100,
      shipping: 10,
      discount: 20,
      total: 80,
    });

    expect(line(html, "Discount")).toBe("-$20.00");
    expect(line(html, "Credits applied")).toBe("-$10.00");
    expect(reconciles(html, 100, 80)).toBe(true);
  });

  it("shows no discount row when there was no discount", () => {
    const { html } = orderConfirmationTemplate({
      customerName: "Ada",
      orderId: "VL-3",
      items: [{ name: "BPC-157", quantity: 1, lineTotal: 100 }],
      subtotal: 100,
      shipping: 10,
      discount: 0,
      total: 110,
    });

    expect(line(html, "Discount")).toBeUndefined();
    expect(line(html, "Credits applied")).toBeUndefined();
    expect(line(html, "Shipping protection")).toBeUndefined();
    expect(reconciles(html, 100, 110)).toBe(true);
  });

  it("keeps the sum-to-total property across tax and the card fee", () => {
    // The invariant the residual was written for. It must survive the split.
    const { html } = orderConfirmationTemplate({
      customerName: "Ada",
      orderId: "VL-4",
      items: [{ name: "BPC-157", quantity: 2, lineTotal: 200 }],
      subtotal: 200,
      shipping: 12,
      discount: 25,
      tax: 16.5,
      cardProcessingFee: 4.25,
      total: 222.75,
    });

    expect(line(html, "Discount")).toBe("-$25.00");
    expect(reconciles(html, 200, 222.75)).toBe(true);
  });

  it("never reports a discount larger than the order, however the totals arrive", () => {
    // A stale or wrong discount_amount must not print a negative-looking
    // receipt. The residual stays the authority on what was actually taken off.
    const { html } = orderConfirmationTemplate({
      customerName: "Ada",
      orderId: "VL-5",
      items: [{ name: "BPC-157", quantity: 1, lineTotal: 100 }],
      subtotal: 100,
      shipping: 10,
      discount: 999,
      total: 110,
    });

    expect(reconciles(html, 100, 110), "an absurd discount broke the reconciliation").toBe(true);
  });

  it("the plain-text receipt agrees with the HTML one", () => {
    // Some clients only ever render the text part, and a receipt that says two
    // different things is worse than one that says the wrong thing once.
    const { html, text } = orderConfirmationTemplate({
      customerName: "Ada",
      orderId: "VL-6",
      items: [{ name: "BPC-157", quantity: 1, lineTotal: 100 }],
      subtotal: 100,
      shipping: 10,
      discount: 20,
      total: 105,
    });

    expect(line(html, "Discount")).toBe("-$20.00");
    expect(text).toContain("-$20.00");
    expect(text).toContain("$15.00");
  });
});
