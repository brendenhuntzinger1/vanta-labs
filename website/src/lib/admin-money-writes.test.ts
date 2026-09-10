import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hasCapturedPayment } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// TWO ADMIN WRITE PATHS THAT COULD CORRUPT AN ORDER'S MONEY STATE.
//
// 1. REFUNDING AN ORDER THAT WAS NEVER PAID.
//
//    The route refused a SECOND refund ("already fully refunded") but nothing
//    refused a FIRST one on a pending_payment or payment_failed order. Doing it
//    wrote payment_status = 'refunded', emailed the customer a refund
//    confirmation for a charge that never happened, and made the order
//    permanently unpayable: 'refunded' is money-terminal, so the real
//    payment.succeeded webhook arriving afterwards is recorded against the
//    existing status and dropped. The processor charges the card and the store
//    has nothing to show for it — the charged-but-invisible order, created by
//    an operator rather than by a lost webhook.
//
// 2. WRITING A PAYMENT STATUS NOTHING READS.
//
//    update_status did `payment_status = String(body.paymentStatus)` with no
//    validation, and the admin's own dropdown offered "failed". The value every
//    reader matches on is "payment_failed" — the reconcile sweep, the
//    order-status route, getOrderProgress and every account surface. An order
//    set to "failed" from that screen was therefore invisible to all of them,
//    and would never be reconciled or retired.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ROUTE = read("src/app/api/admin/orders/[orderId]/route.ts");
const ACTIONS = read("src/components/admin-order-actions.tsx");

describe("a refund needs a payment to refund", () => {
  it("refuses an order whose money never moved", () => {
    expect(ROUTE).toContain("hasCapturedPayment(String(order.payment_status))");
    expect(ROUTE).toMatch(/never paid, so there is nothing to refund/i);
  });

  it("tells the operator what to do instead, rather than just refusing", () => {
    expect(ROUTE).toMatch(/cancel it instead/i);
  });

  it("uses the same captured-payment set as the ledger and the invoice", () => {
    // The states money has actually reached. If these three ever disagreed, an
    // order could be refundable but have no invoice, or vice versa.
    expect(hasCapturedPayment("paid")).toBe(true);
    expect(hasCapturedPayment("partially_refunded")).toBe(true);
    expect(hasCapturedPayment("refunded")).toBe(true);
    expect(hasCapturedPayment("pending_payment")).toBe(false);
    expect(hasCapturedPayment("payment_failed")).toBe(false);
    expect(hasCapturedPayment("canceled")).toBe(false);
  });

  it("still refuses a second refund on a genuinely refunded order", () => {
    // The guard that already existed must not have been replaced by the new one.
    expect(ROUTE).toMatch(/already been fully refunded/i);
  });
});

describe("update_status can only write a status the system reads", () => {
  it("allow-lists the non-money statuses", () => {
    expect(ROUTE).toContain("ADMIN_WRITABLE_PAYMENT_STATUSES");
    expect(ROUTE).toMatch(/"pending_payment", "payment_failed", "canceled"/);
  });

  it("does not write the request value straight into the column", () => {
    // The defect in one line.
    expect(ROUTE).not.toContain("updatePayload.payment_status = String(body.paymentStatus)");
  });

  it("refuses anything else with a message naming the valid values", () => {
    expect(ROUTE).toMatch(/is not a payment status this action can set/i);
  });

  it("leaves the money states to the refund and cancel actions", () => {
    // paid / refunded / partially_refunded must NOT be settable here: they carry
    // reversals (restock, commission, points, store credit) that this path does
    // not run.
    const block = ROUTE.slice(ROUTE.indexOf("ADMIN_WRITABLE_PAYMENT_STATUSES"), ROUTE.indexOf("updatePayload.payment_status = requested"));
    expect(block).not.toMatch(/"paid"/);
    expect(block).not.toMatch(/"refunded"/);
    expect(block).not.toMatch(/"partially_refunded"/);
  });

  it("the dropdown offers the value the readers actually match on", () => {
    expect(ACTIONS).toContain('<option value="payment_failed">');
    // The non-canonical value that nothing read.
    expect(ACTIONS).not.toContain('<option value="failed">');
  });
});
