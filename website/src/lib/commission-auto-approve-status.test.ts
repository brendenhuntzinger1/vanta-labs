import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isPaidOrderStatus, isRevenueOrderStatus, PAID_ORDER_STATUSES, REVENUE_ORDER_STATUSES } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// A COMMISSION ON A PARTIALLY-REFUNDED ORDER IS STILL OWED.
//
// autoApproveEligibleCommissions() decided whether an order had earned its
// commission with a raw string compare:
//
//     const orderStatus = orderStatusById.get(row.order_id);
//     if (orderStatus !== "paid") return false;
//
// That is narrower than the rule this codebase everywhere else applies, in two
// separate ways:
//
//   * PAID_ORDER_STATUSES is {paid, completed, succeeded}. A processor
//     reporting "completed" or "succeeded" left the commission pending for
//     ever.
//   * REVENUE_ORDER_STATUSES adds "partially_refunded". ledger.ts records that
//     as the owner's explicit decision — "a $200 order refunded by $50 is $150
//     of revenue" — and every other reader in partner-portal.ts (lines 1327,
//     1559, 1722) already honours it.
//
// The partial-refund case is the COMMON one rather than an edge case, because
// the hold period exists precisely to span the refund window: a partial refund
// normally lands while the commission is still pending. The commission then sat
// at `pending` permanently, with no error, no alert and no admin surface saying
// why the ambassador was never paid.
//
// These assertions are on the SHARED PREDICATE plus the call site, because
// autoApproveEligibleCommissions is a paged cron sweep over five tables and a
// behavioural harness for it would test the fakes more than the rule. What can
// go wrong here is the rule, and the rule is now one function with one meaning.
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(process.cwd(), "src/lib/partner-portal.ts"), "utf8");

describe("which order statuses have earned a commission", () => {
  it("counts a partially-refunded order as revenue, and a fully refunded one as not", () => {
    expect(isRevenueOrderStatus("partially_refunded")).toBe(true);
    expect(isRevenueOrderStatus("refunded")).toBe(false);
  });

  it("counts every paid spelling a processor may report", () => {
    for (const status of ["paid", "completed", "succeeded"]) {
      expect(isPaidOrderStatus(status)).toBe(true);
      expect(isRevenueOrderStatus(status)).toBe(true);
    }
  });

  it("refuses the states where no money was kept", () => {
    for (const status of ["pending_payment", "payment_failed", "canceled", "refunded", "", null, undefined]) {
      expect(isRevenueOrderStatus(status)).toBe(false);
    }
  });

  it("is exactly the paid set plus partially_refunded — the two must not drift apart", () => {
    expect(REVENUE_ORDER_STATUSES).toEqual(new Set([...PAID_ORDER_STATUSES, "partially_refunded"]));
  });
});

describe("auto-approval asks the shared predicate, not a string", () => {
  it("no longer compares the order status against the literal 'paid'", () => {
    // The exact line that stranded the money. If it comes back, so does the bug.
    expect(source).not.toContain('if (orderStatus !== "paid")');
  });

  it("routes the auto-approve eligibility decision through isRevenueOrderStatus", () => {
    expect(source).toContain("if (!isRevenueOrderStatus(orderStatusById.get(row.order_id)))");
  });
});
