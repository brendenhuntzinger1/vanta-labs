import { cardProcessingFeeNotice, type CardProcessingFeeConfig } from "@/lib/payment-methods";

/**
 * HOW THE CART TALKS ABOUT A TOTAL THAT ISN'T FINISHED YET.
 *
 * The cart called its number "Final total" unconditionally while two known
 * charges were still to come: sales tax ("Calculated at checkout", stated) and
 * the card service fee (3%, stated NOWHERE on the cart or the product page).
 * Reproduced: a cart reading "Final total $344.96" became $355.31 at checkout
 * once the address was entered and the 3% fee appeared.
 *
 * THE CHARGE IS NOT CHANGED BY ANY OF THIS. DEFAULT_CARD_PROCESSING_FEE is the
 * store owner's deliberate setting and quote-order.ts remains the only place a
 * fee is ever computed or applied. What changes here is only what the shopper
 * is told, and when — a total is described as final only when nothing further
 * will be added to it, and any outstanding charge is named up front instead of
 * appearing at the last step.
 *
 * Whether to keep, resize or drop the surcharge — and how card-network rules on
 * debit surcharging bear on it — is a business and legal decision. Nothing here
 * makes that decision.
 */

export interface PendingCharges {
  /** True while sales tax is still "calculated at checkout". */
  taxPending: boolean;
  /** True when a card service fee will be added to a card order. */
  cardFeeApplies: boolean;
}

export function cartTotalLabel(pending: PendingCharges): string {
  return pending.taxPending || pending.cardFeeApplies ? "Estimated total" : "Final total";
}

/**
 * One sentence naming every charge still to be added, or "" when there is
 * none. Uses the operator's own wording for the fee when they have set it.
 */
export function pendingChargeNotice(input: {
  cardFee: CardProcessingFeeConfig | null;
  taxPending: boolean;
}): string {
  const parts: string[] = [];

  const fee = input.cardFee;
  if (fee && fee.enabled && fee.percentage > 0) {
    parts.push(cardProcessingFeeNotice(fee));
  }

  if (input.taxPending) {
    parts.push("Sales tax is calculated at checkout.");
  }

  return parts.join(" ");
}
