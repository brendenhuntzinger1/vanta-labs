import { pointsToDollars } from "@/lib/points-math";

/**
 * WHY THIS EXISTS: the profit floor is measured BEFORE non-cash tender.
 *
 * guardProductCost runs against the gross basket (quote-order.ts), so an order
 * can clear the store's minimum-margin floor on merchandise and then settle for
 * far less cash once store credit and points are applied — a Vanta Black
 * membership grants $75 of credit a month, so a heavily credit-funded order is
 * an ordinary event, not an exotic one.
 *
 * That ordering was reviewed and DELIBERATELY LEFT ALONE: the credit was paid
 * for when it was granted, so the cash arrived earlier, and moving the floor to
 * cash-collected would start refusing exactly the orders where a member spends
 * the benefit they are paying for. The decision was to watch the population
 * first and set policy from real numbers.
 *
 * So this is observability, not a guard. It changes nothing about whether an
 * order is accepted.
 *
 * THE RULE IS STRUCTURAL, NOT A DOLLAR THRESHOLD, DELIBERATELY. Any cash figure
 * picked here would be invented policy wearing the store's name — and the one
 * configured number that looked apt, `minProfitDollars`, defaults to 0 and is
 * unset in production, so hanging the rule on it would mean the alert never
 * fires. "Non-cash tender exceeded the cash collected" needs no threshold, is
 * true or false from the order row alone, and captures the case worth seeing:
 * as cash approaches zero it always fires.
 */
export interface CreditFundedOrderInput {
  orderId: string;
  amountPaid: number;
  storeCreditRedeemedCents: number;
  pointsRedeemed: number;
}

export interface CreditFundedOrderNotice {
  type: "order_mostly_credit_funded";
  severity: "warning";
  message: string;
  context: {
    orderId: string;
    cashCollected: number;
    creditApplied: number;
    storeCreditDollars: number;
    pointsDollars: number;
  };
}

/** The notice for this order, or null when there is nothing worth reporting. */
export function creditFundedOrderNotice(
  input: CreditFundedOrderInput,
): CreditFundedOrderNotice | null {
  const storeCreditDollars = Math.max(0, Number(input.storeCreditRedeemedCents ?? 0)) / 100;
  // The SAME conversion the profit engine and the invoice use. A local copy of
  // "100" here is how the two screens started disagreeing about one order.
  const pointsDollars = Math.max(0, pointsToDollars(Math.max(0, Number(input.pointsRedeemed ?? 0))));
  const creditApplied = Math.round((storeCreditDollars + pointsDollars) * 100) / 100;
  if (creditApplied <= 0) return null;

  const cashCollected = Math.max(0, Number(input.amountPaid ?? 0));
  // STRICTLY GREATER. An order split exactly half and half is not the case this
  // exists to surface, and firing on it would double the noise for nothing.
  if (creditApplied <= cashCollected) return null;

  return {
    type: "order_mostly_credit_funded",
    severity: "warning",
    message:
      `Order ${input.orderId} was funded more by store credit and points ($${creditApplied.toFixed(2)}) `
      + `than by cash ($${cashCollected.toFixed(2)}). The profit floor is measured before non-cash tender, `
      + "so this order cleared it on merchandise margin. Recorded for review, not a fault.",
    context: {
      orderId: input.orderId,
      cashCollected: Math.round(cashCollected * 100) / 100,
      creditApplied,
      storeCreditDollars: Math.round(storeCreditDollars * 100) / 100,
      pointsDollars: Math.round(pointsDollars * 100) / 100,
    },
  };
}
