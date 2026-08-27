import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { providerSettlesRefunds } from "@/lib/payment-provider";
import { refundedMerchandiseFraction } from "@/lib/payment-webhook";
import { reimbursementRecordedTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// NOBODY IS EVER TOLD MONEY MOVED WHEN IT DID NOT.
//
// That invariant has not changed. What changed is which side of it this action
// sits on.
//
// It used to be a "refund" button that recorded a refund nobody had sent, so
// the guard was: do not email. Announcing a refund that is not coming makes the
// customer wait, then charge back — which costs more than the refund and is
// reported against the merchant account.
//
// It is now a record of a reimbursement the owner has ALREADY sent by hand at
// the end of a manual return. The money genuinely moved before this ran, so the
// email is correct to send — provided it says what actually happened. The
// dangerous sentence is no longer "we refunded you"; it is "we returned it to
// your original payment method", which was never true and now never appears.
//
// The processor is not contacted at all. The behavioural proof lives in
// e2e/manual-reimbursement.test.ts, which watches a live provider object and
// asserts refundPayment is never called. What this file adds is a structural
// guard against that call being reintroduced, and a check on the words the
// customer and the owner actually read.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");
const route = readFileSync(join(SRC, "app/api/admin/orders/[orderId]/route.ts"), "utf8");
/** Comments EXPLAIN why the provider call was removed; prose is not a call. */
const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const actions = readFileSync(join(SRC, "components/admin-order-actions.tsx"), "utf8");

describe("the processor is not involved", () => {
  it("still reports that the processor does not settle refunds", () => {
    // If a real card-refund integration ever lands, it is a DIFFERENT action.
    // This one records money the owner sent outside the processor.
    expect(providerSettlesRefunds()).toBe(false);
  });

  it("the admin order route contains no call to a provider refund", () => {
    // Structural backstop for the behavioural test. A reintroduced call would
    // pay a returning customer twice the moment a real integration exists.
    expect(routeCode).not.toMatch(/refundPayment\s*\(/);
    expect(routeCode).not.toMatch(/getPaymentProvider\s*\(/);
  });
});

describe("what the customer is told", () => {
  const rendered = reimbursementRecordedTemplate({
    customerName: "A Customer",
    orderId: "VL-TEST0001",
    amount: 50,
    supportEmail: "support@vantalabsresearch.com",
  });

  it("says the reimbursement was processed, and names the order", () => {
    expect(rendered.subject).toMatch(/reimbursement/i);
    expect(rendered.html).toContain("VL-TEST0001");
    expect(rendered.text).toContain("$50.00");
  });

  it("NEVER claims the money went back to a card", () => {
    // The one sentence that would be false. It is also the sentence a customer
    // would act on — waiting for a statement line that never appears.
    for (const lie of [/original payment method/i, /back to your card/i, /business days/i, /statement/i]) {
      expect(rendered.html).not.toMatch(lie);
      expect(rendered.text).not.toMatch(lie);
    }
  });

  it("names no payment processor and no payment handle", () => {
    const everything = `${rendered.html}${rendered.text}`;
    expect(everything).not.toMatch(/veyra/i);
    expect(everything).not.toMatch(/zelle|cash ?app/i);
  });
});

describe("what the owner is told", () => {
  it("states prominently that recording does not send money", () => {
    expect(actions).toMatch(/does not send money/i);
    // In the amber callout, not the page's smallest grey text.
    expect(actions).toMatch(/border-amber-300\/40[\s\S]{0,400}does not send money/i);
  });

  it("says so again in the confirmation prompt, in capitals", () => {
    expect(actions).toContain("VANTA WILL NOT SEND ANY MONEY");
  });

  it("tells the owner returned stock is not restocked automatically", () => {
    expect(actions).toMatch(/not.{0,40}added back automatically/i);
  });

  it("labels the action as recording, never as sending", () => {
    expect(actions).toContain("Record manual reimbursement");
    // "Issue refund" reads as an instruction to the software to pay someone.
    expect(actions).not.toContain("Issue refund");
  });
});

describe("the audit trail", () => {
  it("records how the money was sent, and that Vanta did not send it", () => {
    const auditBlock = route.slice(route.indexOf('action: "order_refund"'), route.indexOf('action: "order_refund"') + 900);
    expect(auditBlock).toContain("reimbursementMethod");
    expect(auditBlock).toContain("providerRefunded");
    expect(auditBlock).toContain("performedBy");
  });
});

// ---------------------------------------------------------------------------
// WHAT A REFUND RETURNS IS NOT ONLY THE CASH.
//
// The refunded fraction decides how much of the ambassador's commission is
// reversed. It used to be measured as `min(newRefundTotal, base) / base`, and
// `newRefundTotal` is capped at the CASH `amount_paid` while `base` is
// `subtotal - discount`. An order settled with store credit therefore returned
// its entire merchandise while reporting a refunded fraction of zero, and the
// commission on goods the store got back was never clawed back.
// ---------------------------------------------------------------------------
describe("how much of the merchandise a refund returned", () => {
  const fraction = (cash: number, nonCash: number, base = 100) =>
    refundedMerchandiseFraction({ commissionableBase: base, cashRefunded: cash, nonCashReturned: nonCash });

  it("is 1 when an order settled entirely in credit is returned in full", () => {
    // The defect, at its sharpest: $0 cash, $100 of merchandise handed back.
    expect(fraction(0, 100)).toBe(1);
  });

  it("is 0 when nothing has been returned", () => {
    expect(fraction(0, 0)).toBe(0);
  });

  it("counts cash and non-cash tender together", () => {
    expect(fraction(30, 20)).toBeCloseTo(0.5, 10);
  });

  it("is unchanged on an ordinary all-cash order", () => {
    // The regression guard. No credit, no points: identical to the old rule.
    expect(fraction(0, 0)).toBe(0);
    expect(fraction(25, 0)).toBeCloseTo(0.25, 10);
    expect(fraction(100, 0)).toBe(1);
  });

  it("never exceeds 1, however much was handed back", () => {
    // A refund covering shipping, tax and fees on top of the merchandise must
    // not reverse MORE than the whole commission.
    expect(fraction(500, 500)).toBe(1);
  });

  it("is a full reversal when there is no commissionable merchandise at all", () => {
    // Nothing to apportion — the conservative direction is to reverse it all.
    expect(refundedMerchandiseFraction({ commissionableBase: 0, cashRefunded: 0, nonCashReturned: 0 })).toBe(1);
  });
});
