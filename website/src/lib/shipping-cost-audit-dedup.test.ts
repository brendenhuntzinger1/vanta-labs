import { describe, expect, it } from "vitest";
import { shouldWriteShippingAudit } from "@/lib/admin-profit";

// The repair sweep may re-record the same settled postage for an order (a
// re-run, an overlapping sweep). The orders UPDATE is idempotent — same values,
// same result — but the audit INSERT was unconditional, so every repeat wrote
// another audit row and the trail stopped being a record of what changed.
describe("shouldWriteShippingAudit", () => {
  it("writes when no audit row exists for this order", () => {
    expect(shouldWriteShippingAudit([], 742)).toBe(true);
  });

  it("writes when the recorded cost differs from every existing row", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: 500 }], 742)).toBe(true);
  });

  it("does NOT write when the same cost is already recorded", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: 742 }], 742)).toBe(false);
  });

  it("does NOT write when the same cost appears among several rows", () => {
    expect(
      shouldWriteShippingAudit([{ exactCostCents: 500 }, { exactCostCents: 742 }], 742),
    ).toBe(false);
  });
});
