import { describe, expect, it } from "vitest";
import { unsafeEffectAlert } from "@/lib/payment-webhook";

// THESE FIVE ARE NOT AUTO-REPAIRED, AND THAT IS DELIBERATE.
//
//   inventory decrement        legacy fallback has no order-scoped claim
//   points earn                bare INSERT, no (order_id, reason) guard
//   store credit redemption    bare insert, no guard
//   coupon redemption          unconditional increment, no order linkage
//   membership activation      duplicates a 'renewal' billing event
//
// Retrying any of them would double-write. So the failure is escalated to a
// durable, operator-visible alert instead of a console line nobody reads.
describe("unsafeEffectAlert", () => {
  it("is always critical — this is money that silently did not happen", () => {
    const alert = unsafeEffectAlert("points_earn", "order-1", new Error("boom"));
    expect(alert.severity).toBe("critical");
  });

  it("names the order so the backlog is recoverable by hand", () => {
    const alert = unsafeEffectAlert("coupon_redemption", "order-42", new Error("boom"));
    expect(alert.context.orderId).toBe("order-42");
    expect(alert.message).toContain("order-42");
  });

  it("carries the effect in the alert type so alerts group per effect", () => {
    expect(unsafeEffectAlert("inventory_decrement", "order-1", new Error("x")).type)
      .toBe("unsafe_effect_failed_inventory_decrement");
  });

  it("stringifies a non-Error rejection rather than dropping it", () => {
    expect(unsafeEffectAlert("points_earn", "order-1", "plain string").context.error)
      .toBe("plain string");
  });
});
