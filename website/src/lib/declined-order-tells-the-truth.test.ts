import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getOrderProgress } from "@/lib/order-status";
import { hasCapturedPayment } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// A DECLINED ORDER WAS PRESENTED TO ITS CUSTOMER AS A LIVE, PAID ONE.
//
// getOrderProgress computed `awaitingPayment = !paid && !cancelled && !refunded`
// and had no branch for a failed payment, so payment_failed was headlined
// "Awaiting payment". Worse, isUnpaid's list is
//
//   pending | pending_payment | awaiting_verification | unverified | unpaid
//
// and payment_failed is in NONE of them — so every account surface that asks
// "is this unpaid?" answered NO for a declined order and rendered it as a live
// one:
//
//   * the orders list showed the order total in white, like money paid;
//   * the detail page showed the Ordered -> Delivered tracking stepper and a
//     row reading "Total paid $269.35";
//   * /invoice produced a downloadable document headed "Total paid", for a card
//     that was never charged;
//   * and there was no retry control anywhere, because that one IS gated on
//     isUnpaid.
//
// Twenty-one production rows were in that state when this was found, thirteen of
// them belonging to signed-in customers — including David's VL-4AFCDF39, the
// $269.35 that came back insufficient_funds.
//
// The team had already reasoned its way to this rule on the order-confirmation
// page, and wrote it down there: "Total paid" is a claim about money having
// changed hands, and it must only be made when the backend says it has. These
// three surfaces were simply missed.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const ORDERS_LIST = "src/app/account/(dashboard)/orders/page.tsx";
const ORDER_DETAIL = "src/app/account/(dashboard)/orders/[orderId]/page.tsx";
const INVOICE = "src/app/account/(dashboard)/orders/[orderId]/invoice/route.ts";

describe("getOrderProgress distinguishes a failed payment from an unstarted one", () => {
  it("reports a declined card as failed, not as awaiting payment", () => {
    const progress = getOrderProgress("payment_failed", "pending");
    expect(progress.failed).toBe(true);
    expect(progress.awaitingPayment).toBe(false);
    expect(progress.headline).toBe("Payment not completed");
  });

  it("reports a rejected manual payment the same way", () => {
    // The manual lane's equivalent: an operator refused the submitted proof.
    expect(getOrderProgress("payment_rejected", "pending").failed).toBe(true);
  });

  it("leaves a declined order at the very start of the tracker", () => {
    // activeIndex 0 is "Ordered". Anything above it claims progress that did
    // not happen.
    expect(getOrderProgress("payment_failed", "pending").activeIndex).toBe(0);
  });

  it("still reports a genuinely unstarted payment as awaiting payment", () => {
    // The guard must stay narrow — this is the state the "Complete payment"
    // call to action exists for.
    const progress = getOrderProgress("pending_payment", "pending");
    expect(progress.awaitingPayment).toBe(true);
    expect(progress.failed).toBe(false);
    expect(progress.headline).toBe("Awaiting payment");
  });

  it("does not disturb paid, cancelled or refunded orders", () => {
    expect(getOrderProgress("paid", "awaiting_fulfillment").failed).toBe(false);
    expect(getOrderProgress("paid", "delivered").headline).toBe("Delivered");
    expect(getOrderProgress("canceled", "cancelled").headline).toBe("Order cancelled");
    expect(getOrderProgress("refunded", "pending").headline).toBe("Order refunded");
    expect(getOrderProgress("partially_refunded", "shipped").headline).toBe("Partially refunded");
  });
});

describe("an invoice is only ever issued for money that actually moved", () => {
  it("refuses a declined order", () => {
    // The gate that matters: isUnpaid("payment_failed") is FALSE, which is how a
    // declined order earned a "Total paid" invoice in the first place.
    expect(hasCapturedPayment("payment_failed")).toBe(false);
    expect(hasCapturedPayment("payment_rejected")).toBe(false);
    expect(hasCapturedPayment("canceled")).toBe(false);
    expect(hasCapturedPayment("pending_payment")).toBe(false);
  });

  it("still issues one for a paid or refunded order", () => {
    // A refund does not un-issue the receipt for the payment that happened.
    expect(hasCapturedPayment("paid")).toBe(true);
    expect(hasCapturedPayment("partially_refunded")).toBe(true);
    expect(hasCapturedPayment("refunded")).toBe(true);
  });

  it("the route gates on captured payment rather than on isUnpaid", () => {
    const source = read(INVOICE);
    expect(source).toContain("hasCapturedPayment(order.paymentStatus)");
    expect(source).not.toContain("isUnpaid(order.paymentStatus)");
  });
});

// These three surfaces are server components whose rendering this suite cannot
// mount (vitest runs in a node environment here, and each reads a live session
// and the database). What IS checkable, and what actually regressed, is that
// each one consults the failed state at all — so each assertion names the exact
// claim it is preventing.
describe("the account surfaces consult the failed state", () => {
  it("the orders list does not show a declined total as money paid", () => {
    const source = read(ORDERS_LIST);
    expect(source).toContain("progress.failed");
    expect(source).toContain("not charged");
  });

  it("the detail page withholds the tracker, the invoice and the Reorder button", () => {
    const source = read(ORDER_DETAIL);
    expect(source).toContain("progress.failed");
    // The stepper and the invoice/Reorder row are both gated.
    expect(source).toContain("!unpaid && !failed");
    // "Total paid" is conditional now, not a bare row.
    expect(source).toContain('failed ? "Order total (not charged)" : "Total paid"');
  });

  it("the detail page tells a declined shopper what to do next, including the bank prompt", () => {
    const source = read(ORDER_DETAIL);
    // The one fact that turned David's decline into a paid order 71 seconds
    // later, and which no customer-facing surface mentioned anywhere.
    expect(source).toMatch(/bank may have asked you to approve/i);
    expect(source).toMatch(/different card/i);
    // And a way out of the page, which the old rendering had none of.
    expect(source).toContain('href="/contact"');
  });
});

describe("a processor's raw failure text never reaches the customer", () => {
  it("the notifications list sanitises the reason the way its sibling page does", () => {
    const source = read("src/lib/account-notifications.ts");
    expect(source).toContain("customerSafeFailureReason(event.failureReason)");
    // The raw passthrough that used to be here.
    expect(source).not.toContain("event.failureReason ? event.failureReason");
  });
});
