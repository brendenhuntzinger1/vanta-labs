import { describe, expect, it } from "vitest";

import { orderConfirmationTemplate } from "@/lib/email/templates";
import { DEFAULT_CARD_PROCESSING_FEE } from "@/lib/payment-methods";

// ---------------------------------------------------------------------------
// ONE CHARGE, ONE NAME.
//
// Reproduced on VL-284C17AD. The same 3% surcharge was called three different
// things on three surfaces the same customer sees within a minute of paying:
//
//     checkout screen      "Service Fee (3%)"
//     receipt email        "Card processing fee"
//     confirmation page    "Shipping protection"   (see order-summary-card-fee)
//
// The confirmation page is fixed in order-summary-breakdown.ts. This pins the
// receipt to the same name the checkout screen and the invoice already use --
// `DEFAULT_CARD_PROCESSING_FEE.label`, which is also the label an operator sees
// in Admin -> Payments.
//
// It is the line most likely to trigger a "what is this charge?" support email
// or a chargeback, so the wording is load-bearing, not cosmetic.
// ---------------------------------------------------------------------------

const FEE_LABEL = DEFAULT_CARD_PROCESSING_FEE.label;

/** The order actually walked through the browser during the checkout audit. */
const VL_284C17AD = {
  customerName: "Jordan Vance",
  orderId: "VL-284C17AD",
  items: [{ name: "BPC-157 10mg (5mg)", quantity: 8, lineTotal: 344.96 }],
  subtotal: 344.96,
  shipping: 0,
  discount: 0,
  tax: 0,
  cardProcessingFee: 10.35,
  total: 355.31,
};

describe("the receipt calls the card surcharge what every other surface calls it", () => {
  it("uses the canonical fee label in both HTML and text parts", () => {
    const template = orderConfirmationTemplate(VL_284C17AD);

    expect(template.html).toContain(FEE_LABEL);
    expect(template.text).toContain(FEE_LABEL);
  });

  it("no longer invents 'Card processing fee' as a second name", () => {
    const template = orderConfirmationTemplate(VL_284C17AD);

    expect(template.html).not.toMatch(/card processing fee/i);
    expect(template.text).not.toMatch(/card processing fee/i);
  });

  it("does not describe the fee as shipping protection on a declined-cover order", () => {
    const template = orderConfirmationTemplate(VL_284C17AD);

    // Protection was declined on this order. The residual is zero, so no
    // protection line may appear at all.
    expect(template.text).not.toMatch(/shipping protection/i);
    expect(template.html).not.toMatch(/Shipping protection/);
  });

  it("still states the fee amount and a total that reconciles", () => {
    const template = orderConfirmationTemplate(VL_284C17AD);

    expect(template.text).toContain("$10.35");
    expect(template.text).toContain("Total: $355.31");
  });

  it("omits the fee line when no fee was charged", () => {
    const template = orderConfirmationTemplate({
      ...VL_284C17AD,
      cardProcessingFee: 0,
      total: 344.96,
    });

    expect(template.html).not.toContain(FEE_LABEL);
    expect(template.text).not.toContain(FEE_LABEL);
  });

  it("keeps protection and the fee as separate named lines when both apply", () => {
    // Protection ($13.80) folds into the total as the negative residual; the
    // fee is its own recorded column. Both must be named, and named apart.
    const template = orderConfirmationTemplate({
      ...VL_284C17AD,
      cardProcessingFee: 10.76,
      total: 369.52,
    });

    expect(template.text).toMatch(/Shipping protection: \$13\.80/);
    expect(template.text).toContain(`${FEE_LABEL}: $10.76`);
    expect(template.text).toContain("Total: $369.52");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL
//
// These assertions must fail against the old template. The old string is
// asserted explicitly here so that if someone reverts the label, this control
// is what tells them the three-names bug is back rather than the suite going
// quietly green.
// ---------------------------------------------------------------------------
describe("negative control: the canonical label is genuinely different from the old one", () => {
  it("the label under test is not the string the receipt used to print", () => {
    expect(FEE_LABEL.toLowerCase()).not.toBe("card processing fee");
    expect(FEE_LABEL).toBe("Service Fee");
  });

  it("a template still printing the old name would fail the naming assertions", () => {
    const legacyHtml = `<tr><td>Card processing fee</td><td>$10.35</td></tr>`;

    // Exactly the assertion made above, applied to the old output.
    expect(() => expect(legacyHtml).not.toMatch(/card processing fee/i)).toThrow();
    expect(legacyHtml).not.toContain(FEE_LABEL);
  });
});
