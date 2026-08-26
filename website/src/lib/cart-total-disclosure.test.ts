import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cartTotalLabel, pendingChargeNotice } from "@/lib/cart-total-disclosure";
import { DEFAULT_CARD_PROCESSING_FEE } from "@/lib/payment-methods";

// ---------------------------------------------------------------------------
// "FINAL TOTAL" MUST MEAN FINAL.
//
// Reproduced in the browser. The cart page showed:
//
//     Subtotal        $344.96
//     Sales tax       Calculated at checkout
//     Final total     $344.96          <-- called final
//
// ...and no fee was mentioned anywhere on the cart or the product page. After
// the shipping address was entered, checkout added:
//
//     Service Fee (3%)  +$10.35
//     TOTAL             $355.31
//
// So a number labelled "Final total" grew by 3% at the last step. The fee is a
// real, deliberate business charge (DEFAULT_CARD_PROCESSING_FEE, enabled at 3%
// by the store owner) and is NOT changed here — only disclosed. What was wrong
// was calling a total final while a known, mandatory charge was still to come.
//
// SCOPE: this fixes the LABEL and the DISCLOSURE. Whether to keep, reduce or
// remove the surcharge — and how it interacts with card-network rules on debit
// surcharging — is a business and legal decision, deliberately left open.
// ---------------------------------------------------------------------------

describe("a total is only called final when nothing further will be added", () => {
  it("is an estimate while the card fee is still to come — the reproduced case", () => {
    expect(cartTotalLabel({ taxPending: true, cardFeeApplies: true })).toBe("Estimated total");
  });

  it("is an estimate while tax alone is still to be calculated", () => {
    expect(cartTotalLabel({ taxPending: true, cardFeeApplies: false })).toBe("Estimated total");
  });

  it("is an estimate when only the card fee is outstanding", () => {
    expect(cartTotalLabel({ taxPending: false, cardFeeApplies: true })).toBe("Estimated total");
  });

  it("is final only when nothing is outstanding", () => {
    expect(cartTotalLabel({ taxPending: false, cardFeeApplies: false })).toBe("Final total");
  });
});

describe("the outstanding charges are named, not just hinted at", () => {
  it("names the fee, its size and that it applies to card payments", () => {
    const notice = pendingChargeNotice({
      cardFee: DEFAULT_CARD_PROCESSING_FEE,
      taxPending: true,
    });

    expect(notice).toContain("3%");
    expect(notice).toContain(DEFAULT_CARD_PROCESSING_FEE.label);
    expect(notice).toMatch(/card/i);
  });

  it("mentions tax when tax is still to be calculated", () => {
    const notice = pendingChargeNotice({
      cardFee: DEFAULT_CARD_PROCESSING_FEE,
      taxPending: true,
    });

    expect(notice).toMatch(/tax/i);
  });

  it("says nothing about a fee the store does not charge", () => {
    const notice = pendingChargeNotice({
      cardFee: { ...DEFAULT_CARD_PROCESSING_FEE, enabled: false },
      taxPending: true,
    });

    expect(notice).not.toMatch(/3%/);
    expect(notice).not.toContain(DEFAULT_CARD_PROCESSING_FEE.label);
    expect(notice).toMatch(/tax/i);
  });

  it("is empty when there is genuinely nothing left to add", () => {
    expect(
      pendingChargeNotice({
        cardFee: { ...DEFAULT_CARD_PROCESSING_FEE, enabled: false },
        taxPending: false,
      }),
    ).toBe("");
  });

  it("honours an operator's own wording for the fee", () => {
    const notice = pendingChargeNotice({
      cardFee: { ...DEFAULT_CARD_PROCESSING_FEE, noticeText: "Card orders carry a 3% handling charge." },
      taxPending: false,
    });

    expect(notice).toContain("Card orders carry a 3% handling charge.");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL
//
// The old cart hard-coded "Final total" in every state and disclosed no fee at
// all. Both are modelled so the assertions above are proven to discriminate.
// ---------------------------------------------------------------------------
describe("negative control: the old cart called an incomplete total final", () => {
  const legacyLabel = () => "Final total";
  const legacyNotice = () => "";

  it("the old label is wrong in exactly the reproduced state", () => {
    const state = { taxPending: true, cardFeeApplies: true };

    expect(legacyLabel()).toBe("Final total");
    expect(cartTotalLabel(state)).not.toBe(legacyLabel());
  });

  it("the old cart disclosed no fee where the new one does", () => {
    expect(legacyNotice()).toBe("");
    expect(
      pendingChargeNotice({ cardFee: DEFAULT_CARD_PROCESSING_FEE, taxPending: true }),
    ).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// SOURCE CONTRACT
// ---------------------------------------------------------------------------
const read = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8");

describe("source contract: the cart no longer hard-codes a final total", () => {
  const cart = read("src/app/cart/cart-client.tsx");

  it("the cart total label is derived rather than the literal 'Final total'", () => {
    expect(cart).not.toMatch(/<span>Final total<\/span>/);
    expect(cart).toMatch(/cartTotalLabel/);
  });

  it("the cart renders the outstanding-charge disclosure", () => {
    expect(cart).toMatch(/pendingChargeNotice/);
  });

  it("the business charge itself is untouched — the cart only discloses it", () => {
    // The cart must not compute or apply a fee; quote-order remains the only
    // place a charge is decided.
    expect(cart).not.toMatch(/calculateCardProcessingFee/);
  });
});
