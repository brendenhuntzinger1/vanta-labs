import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The form calls useRouter() to refresh the server-rendered page after a save.
// There is no app-router context in a node test, so stub the one hook it uses;
// everything asserted below is the component's own markup and arithmetic.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const {
  AdminOrderShippingCostForm,
  parseShippingCostInput,
  isVoidedLabelRefusal,
} = await import("@/components/admin-order-shipping-cost-form");

// ---------------------------------------------------------------------------
// THE ALERT TELLS THE OPERATOR TO DO SOMETHING THE ADMIN COULD NOT DO.
//
// shipping_cost_manual_entry_required says, in production, "Enter the cost by
// hand in Admin -> Orders; no automatic repair is possible." The server action
// it refers to (`set_shipping_cost`) exists, is role-gated and is audited --
// but no component had ever called it, so the instruction was a dead end on
// every order it ever fired for.
//
// These tests pin the entry path itself. The bounds are asserted against the
// SAME numbers the route enforces, so a client that lets a figure through which
// the server would then reject cannot pass.
// ---------------------------------------------------------------------------

describe("parseShippingCostInput", () => {
  it("accepts a plain dollar figure", () => {
    expect(parseShippingCostInput("7.42")).toEqual({ ok: true, amount: 7.42 });
  });

  it("accepts zero — a free label really did cost nothing", () => {
    // Not folded in with the happy case: `!amount` and `amount < 0` are one
    // typo apart, and the first silently refuses a legitimate $0.00 entry.
    expect(parseShippingCostInput("0")).toEqual({ ok: true, amount: 0 });
  });

  it("refuses an empty entry rather than sending zero", () => {
    const result = parseShippingCostInput("   ");
    expect(result.ok).toBe(false);
  });

  it("refuses a negative cost", () => {
    expect(parseShippingCostInput("-1").ok).toBe(false);
  });

  it("refuses anything the server's own bound would reject", () => {
    // The route refuses > 10000. A client that accepts 10001 produces a round
    // trip whose only outcome is a 400.
    expect(parseShippingCostInput("10000").ok).toBe(true);
    expect(parseShippingCostInput("10000.01").ok).toBe(false);
  });

  it("refuses text that is not a number", () => {
    expect(parseShippingCostInput("about seven dollars").ok).toBe(false);
  });
});

describe("isVoidedLabelRefusal", () => {
  it("recognises the server's voided-label refusal", () => {
    // Verbatim from recordActualShippingCost — this is the one refusal a human
    // is allowed to override, and the checkbox appears only in response to it.
    const refusal =
      "This order's label was voided and its postage refunded, so there is no shipping cost to record. "
      + "If the carrier DECLINED the refund and the postage was really paid, re-send this entry with "
      + "overrideVoidedLabel to record it by hand.";
    expect(isVoidedLabelRefusal(refusal)).toBe(true);
  });

  it("does not offer the override for an unrelated failure", () => {
    // Offering "tick here to force it" on a transient read failure invites the
    // operator to override a guard that never fired.
    expect(isVoidedLabelRefusal("Could not read this order before recording its shipping cost: timeout")).toBe(false);
    expect(isVoidedLabelRefusal("Order not found")).toBe(false);
  });
});

describe("the form the operator actually sees", () => {
  it("renders an entry field for the cost", () => {
    const html = renderToStaticMarkup(<AdminOrderShippingCostForm orderId="order-abc" />);
    expect(html).toContain("<input");
    expect(html.toLowerCase()).toContain("shipping");
  });

  it("does not offer the voided-label override until the server asks for it", () => {
    // The override re-charges postage the carrier is believed to have refunded.
    // It must never be a checkbox sitting there to be ticked by habit.
    const html = renderToStaticMarkup(<AdminOrderShippingCostForm orderId="order-abc" />);
    expect(html).not.toContain('type="checkbox"');
  });
});
