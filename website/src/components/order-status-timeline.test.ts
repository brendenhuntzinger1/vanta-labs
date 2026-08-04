import { describe, expect, it } from "vitest";
import { stepIndexForFulfillment } from "./order-status-timeline";

describe("stepIndexForFulfillment", () => {
  it("starts at Order confirmed for a brand-new paid order", () => {
    expect(stepIndexForFulfillment(null)).toBe(0);
    expect(stepIndexForFulfillment(undefined)).toBe(0);
    expect(stepIndexForFulfillment("")).toBe(0);
    expect(stepIndexForFulfillment("unfulfilled")).toBe(0);
    expect(stepIndexForFulfillment("pending")).toBe(0);
  });

  it("advances to Processing once fulfilment has picked the order up", () => {
    expect(stepIndexForFulfillment("processing")).toBe(1);
    expect(stepIndexForFulfillment("awaiting_fulfillment")).toBe(1);
    expect(stepIndexForFulfillment("partially_fulfilled")).toBe(1);
  });

  it("advances to Shipped once the parcel is out", () => {
    expect(stepIndexForFulfillment("shipped")).toBe(2);
    expect(stepIndexForFulfillment("delivered")).toBe(2);
    expect(stepIndexForFulfillment("fulfilled")).toBe(2);
  });

  it("ignores casing and stray whitespace from the database", () => {
    expect(stepIndexForFulfillment("  Shipped ")).toBe(2);
    expect(stepIndexForFulfillment("PROCESSING")).toBe(1);
  });

  it("never runs past the last step or before the first", () => {
    const statuses = [null, "", "weird_new_status", "processing", "shipped", "delivered", "cancelled"];
    for (const status of statuses) {
      const index = stepIndexForFulfillment(status);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(2);
    }
  });

  it("falls back to Order confirmed for an unrecognised status rather than guessing forward", () => {
    // Claiming "Shipped" for a status we don't understand would be a lie in the
    // one direction that matters; staying at step 0 is merely stale.
    expect(stepIndexForFulfillment("on_hold")).toBe(0);
    expect(stepIndexForFulfillment("cancelled")).toBe(0);
  });
});
