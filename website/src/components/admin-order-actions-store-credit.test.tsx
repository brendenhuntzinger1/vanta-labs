import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { AdminOrderActions } from "@/components/admin-order-actions";

// ---------------------------------------------------------------------------
// LF-01 — "FULLY REIMBURSED" ON AN ORDER THAT WAS NEVER REIMBURSED AT ALL.
//
// Store credit and points are TENDER. The refund route knows it: it computes
// `nonCashTender` from store_credit_redeemed_cents and points_redeemed, and it
// deliberately accepts a refund on an order whose cash `amount_paid` is zero,
// because that is the ONLY way the customer's credit ever comes back.
//
// The panel that has to call it did not know it. It gated the entire control on
//
//     remaining = amountPaid - refundAmount  >  0
//
// which is a statement about CASH. An order the customer settled entirely with
// store credit has amount_paid 0, so `remaining` is 0 on the very first view,
// the whole control was replaced with the words "Fully reimbursed." in
// reassuring green, and there was no button anywhere in the admin that could
// return the credit. The customer's money sat in a column nobody could reach,
// and the screen said the matter was closed.
//
// Rendered through react-dom/server rather than grepped, so a control whose
// condition is broken cannot pass on the strength of its string still existing
// in the file.
// ---------------------------------------------------------------------------

const BASE = {
  orderId: "VL-1001",
  initialFulfillmentStatus: "paid",
  initialTrackingNumber: null,
  canRefund: true,
};

function render(props: Partial<Parameters<typeof AdminOrderActions>[0]>) {
  return renderToStaticMarkup(
    <AdminOrderActions
      {...BASE}
      initialPaymentStatus={props.initialPaymentStatus ?? "paid"}
      amountPaid={props.amountPaid ?? 0}
      refundAmount={props.refundAmount ?? 0}
      storeCreditRedeemedCents={props.storeCreditRedeemedCents ?? 0}
      pointsRedeemed={props.pointsRedeemed ?? 0}
      {...props}
    />,
  );
}

describe("an order settled entirely with store credit", () => {
  const creditOnly = { amountPaid: 0, refundAmount: 0, storeCreditRedeemedCents: 4_500 };

  it("does not claim it has been fully reimbursed", () => {
    expect(render(creditOnly)).not.toContain("Fully reimbursed.");
  });

  it("offers the control that returns the credit", () => {
    const html = render(creditOnly);
    expect(html).toContain("Return store credit");
  });

  it("states the credit still outstanding in the tender summary", () => {
    const html = render(creditOnly);
    expect(html).toContain("Store credit &amp; points");
    expect(html).toContain("$45.00");
  });

  it("does not offer a cash amount box, which the server would reject", () => {
    // The route refuses any non-zero amount on an order that collected no cash:
    // recording cash returned would drive reported revenue below zero.
    const html = render(creditOnly);
    expect(html).not.toContain("Full remaining");
  });
});

describe("what the control promises about store credit", () => {
  // STORE CREDIT EXPIRES AT THE MONTH BOUNDARY. refundStoreCreditForOrder only
  // re-credits redemptions newer than the start of the current month, and when
  // none qualify it returns false and writes nothing — silently, since
  // runRefundEffect alerts on a throw and not on a false. A return authorised a
  // few weeks after the sale routinely crosses that boundary.
  //
  // The first version of this panel put the amount on the button — "Return
  // store credit & points ($45.00)" — which is a promise that money will move.
  // On an expired order it will not. That is the same defect class this whole
  // phase exists to close, introduced by the control that closes it.
  const creditOnly = { amountPaid: 0, refundAmount: 0, storeCreditRedeemedCents: 4_500 };

  it("does not put an amount on the button, because the amount may not move", () => {
    const html = render(creditOnly);
    expect(html).toContain("Return store credit &amp; points");
    expect(html).not.toContain("Return store credit &amp; points ($45.00)");
  });

  it("states the month rule wherever non-cash tender is outstanding", () => {
    expect(render(creditOnly)).toContain("only returnable in the month it was spent");
  });

  it("states the rule on a cash order that also used credit", () => {
    const html = render({ amountPaid: 120, refundAmount: 0, storeCreditRedeemedCents: 4_500 });
    expect(html).toContain("only returnable in the month it was spent");
  });

  it("says nothing about credit expiry on an order that used none", () => {
    const html = render({ amountPaid: 120, refundAmount: 0 });
    expect(html).not.toContain("only returnable in the month it was spent");
  });

  it("names the order's date as a UTC calendar date, the same clock the rule uses", () => {
    // isRefundableRedemption compares against startOfCurrentMonthIso(), which is
    // built from Date.UTC. Rendering the date in the viewer's locale timezone
    // named a different month either side of a boundary — an order paid
    // 2026-09-01T03:00Z displays as 8/31/2026 to an admin in UTC-7, who then
    // tells the customer their still-live credit has expired. An unambiguous
    // ISO calendar date cannot drift.
    const html = render({ ...creditOnly, orderPlacedIso: "2026-09-01T03:00:00.000Z" });
    expect(html).toContain("2026-09-01");
    expect(html).not.toContain("8/31/2026");
  });

  it("does not ask how the money was sent when no money is being sent", () => {
    // The method select defaults to "zelle" and is posted with the refund, so a
    // credit-only return wrote an audit row asserting the owner paid by Zelle —
    // on the same screen that says "there is nothing for you to send".
    const html = render(creditOnly);
    expect(html).not.toContain("How you sent it");
  });

  it("still asks how the money was sent on a cash refund", () => {
    expect(render({ amountPaid: 120, refundAmount: 0 })).toContain("How you sent it");
  });
});

describe("an order settled with points", () => {
  it("offers the control for a points-only redemption", () => {
    // 750 points = $7.50 at the one exported redemption rate.
    const html = render({ amountPaid: 0, refundAmount: 0, pointsRedeemed: 750 });
    expect(html).not.toContain("Fully reimbursed.");
    expect(html).toContain("$7.50");
  });
});

describe("an order that has not been paid yet", () => {
  // THE TENDER COLUMNS ARE WRITTEN AT ORDER CREATION, NOT AT PAYMENT.
  // quote-order.ts:1088-1090 writes points_redeemed and
  // store_credit_redeemed_cents alongside payment_status 'pending_payment';
  // the credit is not actually debited until redeemStoreCredit runs in the
  // payment-success webhook. So amount_paid === 0 does NOT mean "settled with
  // credit" — on an unpaid order it means nothing has been settled at all.
  //
  // Gating on cash alone therefore offered a "Return store credit & points"
  // button on a fully credit-funded order that was still awaiting payment, and
  // the route would have taken it: it guards on payment_status === 'refunded'
  // and on nonCashTender, never on the order being paid. That marks an unpaid
  // order refunded and blocks the payment that was still coming.
  const unpaidCreditOrder = {
    initialPaymentStatus: "pending_payment",
    amountPaid: 0,
    refundAmount: 0,
    storeCreditRedeemedCents: 4_500,
  };

  it("offers no return control, because nothing has been tendered", () => {
    const html = render(unpaidCreditOrder);
    expect(html).not.toContain("Return store credit");
  });

  it("does not claim the order was settled with credit", () => {
    expect(render(unpaidCreditOrder)).not.toContain("It was settled with");
  });

  it("says why, rather than showing the green all-clear", () => {
    const html = render(unpaidCreditOrder);
    expect(html).not.toContain("Fully reimbursed.");
    expect(html).toContain("has not been paid");
  });

  it("is equally silent on an order awaiting payment verification", () => {
    const html = render({ ...unpaidCreditOrder, initialPaymentStatus: "awaiting_verification" });
    expect(html).not.toContain("Return store credit");
  });
});

describe("orders that really are finished", () => {
  it("says fully reimbursed when the cash is back and no credit was used", () => {
    const html = render({ amountPaid: 100, refundAmount: 100 });
    expect(html).toContain("Fully reimbursed.");
    expect(html).not.toContain("Record manual reimbursement</button>");
  });

  it("does NOT claim the credit came back just because the order says refunded", () => {
    // payment_status 'refunded' is written by the route's compare-and-set claim
    // BEFORE the side effects run, and independently of what they return.
    // refundStoreCreditForOrder returns false without throwing when the
    // redemption predates the current month, runRefundEffect only alerts on a
    // throw, and the repair sweep skips it too — so an emerald "Fully
    // reimbursed." here is the same unearned all-clear LF-01 exists to remove,
    // on an order where the customer's balance never moved.
    const html = render({
      initialPaymentStatus: "refunded",
      amountPaid: 0,
      storeCreditRedeemedCents: 4_500,
    });
    expect(html).not.toContain("Fully reimbursed.");
    expect(html).toContain("Recorded as refunded");
  });

  it("still says fully reimbursed on a plain cash order with no tender to trace", () => {
    const html = render({ initialPaymentStatus: "refunded", amountPaid: 100, refundAmount: 100 });
    expect(html).toContain("Fully reimbursed.");
  });
});

describe("ordinary cash orders are unchanged", () => {
  it("still offers the amount box with the remaining balance", () => {
    const html = render({ amountPaid: 120, refundAmount: 20 });
    expect(html).toContain("Full remaining ($100.00)");
    expect(html).not.toContain("Fully reimbursed.");
  });

  it("still refuses the control to a role that cannot refund", () => {
    const html = render({ amountPaid: 0, storeCreditRedeemedCents: 4_500, canRefund: false });
    expect(html).toContain("does not have permission to issue refunds");
    expect(html).not.toContain("Return store credit");
  });
});
