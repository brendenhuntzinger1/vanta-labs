import { describe, expect, it } from "vitest";
import { expectedOrderTotal, isTotalMismatch } from "@/lib/reconciliation-math";

// ---------------------------------------------------------------------------
// BLOCK F — is reconciliation-math.expectedOrderTotal the same formula
// quote-order actually charges?
//
// It is the FOURTH independent hand-written copy of the amount_paid formula
// (after quote-order.ts, the client preview and the express lane), and it is
// the one that decides whether an order gets flagged as broken. If it drifts
// from the real one, the reconciliation screen is either blind or crying wolf,
// and either way it is the screen the owner trusts when they already think
// something is wrong.
//
// Nothing can import quoteOrder here — it pulls in the whole checkout stack —
// so the charged formula is TRANSCRIBED below from src/lib/quote-order.ts,
// with the line numbers, and the two are compared over a large deterministic
// sweep of orders. The transcription is the thing to check when this test is
// read; it is deliberately staged and clamped exactly like the original rather
// than simplified.
// ---------------------------------------------------------------------------

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * quote-order.ts, as written:
 *
 *   741  totalBeforePoints = roundMoney(subtotal + shipping + taxAmount - discountAmount)
 *   751  storeCreditRedeemedCents = max(0, min(balance, round(totalBeforePoints * 100)))
 *   753  storeCreditDiscount      = roundMoney(storeCreditRedeemedCents / 100)
 *   754  totalAfterCredit         = roundMoney(max(0, totalBeforePoints - storeCreditDiscount))
 *   770  pointsDiscountAmount     = roundMoney(min(requestedDollars, totalAfterCredit))
 *   777  expectedTotal            = roundMoney(max(0, totalAfterCredit - pointsDiscountAmount) + shippingProtectionFee)
 *   810  finalTotal               = roundMoney(expectedTotal + cardFee.amount)
 *
 * The clamps are load-bearing: at quote time a redemption can never exceed the
 * balance due, so the customer is never charged a negative amount.
 */
function chargedTotal(o: {
  subtotal: number; shipping: number; tax: number; discount: number;
  storeCredit: number; pointsDollars: number; protection: number; cardFee: number;
}): number {
  const totalBeforePoints = round2(o.subtotal + o.shipping + o.tax - o.discount);
  const storeCreditDiscount = round2(Math.min(o.storeCredit, Math.max(0, totalBeforePoints)));
  const totalAfterCredit = round2(Math.max(0, totalBeforePoints - storeCreditDiscount));
  const pointsDiscountAmount = round2(Math.min(o.pointsDollars, totalAfterCredit));
  const expectedTotal = round2(Math.max(0, totalAfterCredit - pointsDiscountAmount) + o.protection);
  return round2(expectedTotal + o.cardFee);
}

/**
 * A deterministic sweep of orders CHECKOUT CAN ACTUALLY PRODUCE.
 *
 * The discount is capped at the subtotal by the shared rulebook —
 * profit-engine.resolveCustomerDiscount returns
 * `round(Math.min(subtotal, bestEffective))` (profit-engine.ts:221, and the
 * stacking branch at :215) — so `subtotal + shipping + tax − discount` can
 * never go negative on a real order. Generating discounts above the subtotal
 * would manufacture a divergence the system cannot reach, which is worse than
 * finding none.
 */
function* orders() {
  const subtotals = [0, 0.01, 9.99, 33.33, 49.95, 100, 249.99, 1000.05, 12345.67];
  const shippings = [0, 5.95, 12.34];
  const taxes = [0, 0.07, 8.25, 41.66];
  const discountFractions = [0, 0.001, 0.5, 1];
  const protections = [0, 2.99, 14.95];
  for (const subtotal of subtotals)
    for (const shipping of shippings)
      for (const tax of taxes)
        for (const fraction of discountFractions)
          for (const protection of protections) {
            const discount = round2(subtotal * fraction);
            // The card fee is charged on the post-protection total, and stored
            // on the order — reconciliation reads the stored value.
            const base = round2(round2(subtotal + shipping + tax - discount) + protection);
            const cardFee = round2(base * 0.035);
            yield { subtotal, shipping, tax, discount, protection, cardFee };
          }
}

describe("expectedOrderTotal vs the total quote-order actually charges", () => {
  it("agrees to the cent on every order with no redemption", () => {
    const divergences: string[] = [];
    for (const o of orders()) {
      const charged = chargedTotal({ ...o, storeCredit: 0, pointsDollars: 0 });
      const expected = expectedOrderTotal({
        subtotal: o.subtotal, shipping: o.shipping, tax: o.tax, cardFee: o.cardFee,
        discount: o.discount, storeCredit: 0, pointsDollars: 0, shippingProtection: o.protection,
      });
      if (Math.abs(charged - expected) > 0.0001) {
        divergences.push(`${JSON.stringify(o)} charged=${charged} expected=${expected}`);
      }
    }
    expect(divergences).toEqual([]);
  });

  it("agrees to the cent when store credit and points are redeemed", () => {
    const divergences: string[] = [];
    for (const o of orders()) {
      for (const storeCredit of [0, 0.01, 5, 25.5]) {
        for (const pointsDollars of [0, 0.01, 1.23, 40]) {
          // Only orders whose redemption was actually affordable — that is the
          // set quote-order can produce, because it clamps to the balance due.
          const totalBeforePoints = round2(o.subtotal + o.shipping + o.tax - o.discount);
          if (storeCredit + pointsDollars > totalBeforePoints) continue;
          const charged = chargedTotal({ ...o, storeCredit, pointsDollars });
          const expected = expectedOrderTotal({
            subtotal: o.subtotal, shipping: o.shipping, tax: o.tax, cardFee: o.cardFee,
            discount: o.discount, storeCredit, pointsDollars, shippingProtection: o.protection,
          });
          if (Math.abs(charged - expected) > 0.0001) {
            divergences.push(`${JSON.stringify({ ...o, storeCredit, pointsDollars })} charged=${charged} expected=${expected}`);
          }
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // WHERE THE TWO PART COMPANY — AND WHY IT IS LATENT, NOT LIVE.
  //
  // quote-order clamps at every stage, so the charged total can never fall
  // below the protection fee plus the card fee. expectedOrderTotal subtracts
  // flat, so it CAN produce a negative expected total.
  //
  // At quote time the clamp never binds: a redemption is capped at the balance
  // due, and the discount is capped at the subtotal. So this divergence needs a
  // stored order whose components were changed AFTER insert — and no writer
  // that does that has been found (see BLOCK-F.md, finding F-08). It is kept
  // here as a characterisation of the difference, not as a live defect: the
  // point is that the two formulas are not the same function, so the next
  // writer that touches those columns turns this into a false flag.
  // -------------------------------------------------------------------------
  it("diverges once a stored redemption exceeds the recomputed total", () => {
    const o = { subtotal: 20, shipping: 0, tax: 0, discount: 15, protection: 0, cardFee: 0 };
    const storeCredit = 20; // recorded when the subtotal was still $20 and the discount $0

    const charged = chargedTotal({ ...o, storeCredit, pointsDollars: 0 });
    const expected = expectedOrderTotal({
      subtotal: o.subtotal, shipping: o.shipping, tax: o.tax, cardFee: o.cardFee,
      discount: o.discount, storeCredit, pointsDollars: 0, shippingProtection: o.protection,
    });

    expect(charged).toBe(0);
    expect(expected).toBe(-15);
    // A $0 order against a NEGATIVE expected total reads as an overpayment.
    expect(isTotalMismatch(0, expected, 0)).toBe(true);
  });

});
