import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getCommissionStateForRefund } from "@/lib/payment-webhook";

// ---------------------------------------------------------------------------
// THE COMMISSION LIFECYCLE THE CODE WRITES, AND THE CHECK CONSTRAINT THAT HAS
// TO ADMIT IT. (VL-7 / P12-01)
//
// referral_orders.payment_status carries the COMMISSION lifecycle. Production's
// original CHECK described the ORDER's payment state instead, and
// referral-orders-commission-lifecycle.sql widened it to the real lifecycle —
// but left out `manual_review`, which is what the REFUND path writes when the
// commission has already been paid out and cannot be clawed back.
//
// The result was 23514 on every refund of a paid-commission order, raised from
// INSIDE the webhook's refund branch. Until the companion REF-02 fix, that one
// exception took the restock and the customer's points/store credit with it,
// and the processor's retry hit the already-terminal guard and ran nothing at
// all — so the work was destroyed, not deferred.
//
// This file is the guard against the list drifting from the writers again. It
// reads the migration, not the database, because the migration is what an
// operator applies.
// ---------------------------------------------------------------------------

const SQL_DIR = join(process.cwd(), "src/lib/sql");
const migration = readFileSync(join(SQL_DIR, "referral-orders-manual-review-status.sql"), "utf8");

/** The values the CHECK admits, read out of the constraint itself. */
function admittedStatuses(sql: string): string[] {
  const check = sql.slice(sql.lastIndexOf("add constraint referral_orders_payment_status_check"));
  const list = check.slice(check.indexOf("array["), check.indexOf("]));"));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

const ADMITTED = admittedStatuses(migration);

describe("what the refund path writes", () => {
  it("flags a refunded-after-payout commission for review, and the CHECK admits it", () => {
    // The value that raised 23514 in production.
    const state = getCommissionStateForRefund("paid");
    expect(state.status).toBe("manual_review");
    expect(ADMITTED).toContain(state.status);
  });

  it("admits every status getCommissionStateForRefund can produce", () => {
    for (const current of ["pending", "approved_for_payout", "paid", "commission_paid", "reversed", null]) {
      expect(ADMITTED).toContain(getCommissionStateForRefund(current).status);
    }
  });

  it("admits the PARTIAL-refund path's status too", () => {
    // updateCommissionOnRefund: a partial refund of an order whose commission
    // was already paid writes 'manual_review' as well, and keeps a reduced
    // commission_amount rather than reversing outright.
    expect(ADMITTED).toContain("manual_review");
  });
});

describe("the rest of the lifecycle is not lost in the widening", () => {
  it("still admits accrual, payout approval, payout and reversal", () => {
    // referral-orders-commission-lifecycle.sql's list, which this file
    // supersedes — dropping one of these would break accrual again (M-01).
    for (const status of ["pending", "approved_for_payout", "paid", "reversed", "voided", "refunded", "partially_refunded"]) {
      expect(ADMITTED).toContain(status);
    }
  });

  it("defaults to 'pending', the value that has to be cleared before payout", () => {
    expect(migration).toMatch(/alter column payment_status set default 'pending'/);
  });
});

describe("how the migration is applied", () => {
  it("drops narrow constraints BY RULE, so a differently-named duplicate cannot survive", () => {
    // The harness carries `pc_ro_ps` from harness-prod-parity-constraints.sql,
    // enforcing the original three-value rule under another name. A by-name
    // migration widens one, leaves the other in force, and reports success.
    expect(migration).toMatch(/from pg_constraint/);
    expect(migration).toMatch(/not like '%''manual_review''%'/);
    expect(migration).toMatch(/execute format\('alter table public\.referral_orders drop constraint %I'/);
  });

  it("has a rollback that says what reverting costs", () => {
    const rollback = readFileSync(join(SQL_DIR, "ROLLBACK-referral-orders-manual-review-status.sql"), "utf8");
    expect(rollback).toMatch(/manual_review/);
    expect(rollback).toMatch(/23514/);
  });

  it("runs in the local harness AFTER the parity constraints that re-create the drift", () => {
    const setup = readFileSync(join(process.cwd(), "scripts/setup-local-harness.sh"), "utf8");
    const parityAt = setup.indexOf("harness-prod-parity-constraints.sql");
    const migrationAt = setup.indexOf("referral-orders-manual-review-status");
    expect(parityAt).toBeGreaterThan(-1);
    expect(migrationAt).toBeGreaterThan(parityAt);
  });

  it("is staged for the operator in the deployment runbook", () => {
    const runbook = readFileSync(join(process.cwd(), "docs/DEPLOYMENT-ORDER.md"), "utf8");
    expect(runbook).toContain("referral-orders-manual-review-status.sql");
    expect(runbook).toContain("ROLLBACK-referral-orders-manual-review-status.sql");
  });
});
