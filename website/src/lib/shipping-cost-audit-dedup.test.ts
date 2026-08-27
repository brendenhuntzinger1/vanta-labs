import { describe, expect, it } from "vitest";
import { shouldWriteShippingAudit } from "@/lib/admin-profit";

// The repair sweep may re-record the same settled postage for an order (a
// re-run, an overlapping sweep). The orders UPDATE is idempotent — same values,
// same result — but the audit INSERT was unconditional, so every repeat wrote
// another audit row and the trail stopped being a record of what changed.
//
// `existing` is what getShippingCostAudit returns: created_at DESCENDING, so
// index 0 is the order's CURRENT recorded cost.
describe("shouldWriteShippingAudit", () => {
  it("writes when no audit row exists for this order", () => {
    expect(shouldWriteShippingAudit([], 742)).toBe(true);
  });

  it("writes when the recorded cost differs from the current one", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: 500 }], 742)).toBe(true);
  });

  it("does NOT write when the cost already recorded is the same", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: 742 }], 742)).toBe(false);
  });

  // FIX ROUND 2 — the dedup compared against ALL history, not the current state.
  //
  // 742 -> 500 -> 742 is an ordinary sequence: a label is bought at 742, an
  // admin corrects it to 500, then the true settled figure comes back as 742.
  // Matching ANY prior row suppressed that third write, so the audit trail
  // ended at 500 while the order was actually charging 742 — the trail said the
  // opposite of the truth, which is worse than a duplicate row.
  it("writes 742 again after a correction to 500 — the trail must not end on a stale value", () => {
    // Most recent first: the order currently reads 500, and was 742 before.
    expect(shouldWriteShippingAudit([{ exactCostCents: 500 }, { exactCostCents: 742 }], 742)).toBe(true);
  });

  it("still suppresses a genuine repeat of the current value, however long the history", () => {
    expect(
      shouldWriteShippingAudit(
        [{ exactCostCents: 742 }, { exactCostCents: 500 }, { exactCostCents: 742 }],
        742,
      ),
    ).toBe(false);
  });

  // voidLabelForOrder writes a reversal row carrying a null exact cost. A null
  // is never equal to an amount, so the next real charge after a void is always
  // recorded rather than swallowed as a repeat of the pre-void figure.
  it("writes after a reversal row, even at the pre-void amount", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: null }, { exactCostCents: 742 }], 742)).toBe(true);
  });
});
