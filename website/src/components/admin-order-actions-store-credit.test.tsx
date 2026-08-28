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

  it("states the credit still outstanding", () => {
    expect(render(creditOnly)).toContain("$45.00");
  });

  it("does not offer a cash amount box, which the server would reject", () => {
    // The route refuses any non-zero amount on an order that collected no cash:
    // recording cash returned would drive reported revenue below zero.
    const html = render(creditOnly);
    expect(html).not.toContain("Full remaining");
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

describe("orders that really are finished", () => {
  it("says fully reimbursed when the cash is back and no credit was used", () => {
    const html = render({ amountPaid: 100, refundAmount: 100 });
    expect(html).toContain("Fully reimbursed.");
    expect(html).not.toContain("Record manual reimbursement</button>");
  });

  it("says fully reimbursed once the refund has actually run", () => {
    // payment_status "refunded" is the route's own idempotency guard: the
    // credit and points were handed back by that refund's side effects.
    const html = render({
      initialPaymentStatus: "refunded",
      amountPaid: 0,
      storeCreditRedeemedCents: 4_500,
    });
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
