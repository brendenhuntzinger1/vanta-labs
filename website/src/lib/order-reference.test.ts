import { describe, expect, it } from "vitest";
import { displayOrderReference } from "@/lib/order-reference";

// Customer surfaces used `orderNumber ?? orderId`, so a missing number showed a
// 45-character database key on the confirmation page, the order list, the order
// detail page, and the invoice the customer keeps. Order VL-49CA32C1 reached
// "paid" with null customer_email and null customer_name, so fields that
// "cannot" be null demonstrably are.

const REAL_ID = "order-8f2f12b9-62b5-4630-9ff5-b11f27702553";

describe("displayOrderReference", () => {
  it("prefers the real order number", () => {
    expect(displayOrderReference("VL-E8F4D52F", REAL_ID)).toBe("VL-E8F4D52F");
  });

  it("never shows a raw database id when the number is missing", () => {
    const shown = displayOrderReference(null, REAL_ID);
    expect(shown).not.toContain(REAL_ID);
    expect(shown).not.toContain("order-");
    expect(shown).not.toContain("-62b5-");
  });

  it("renders in the same shape as a real order number", () => {
    expect(displayOrderReference(null, REAL_ID)).toBe("VL-8F2F12B9");
    expect(displayOrderReference(null, REAL_ID)).toMatch(/^VL-[0-9A-F]{8}$/);
  });

  it("is deterministic, so support can prefix-search the row", () => {
    expect(displayOrderReference(null, REAL_ID)).toBe(displayOrderReference("", REAL_ID));
  });

  it("treats an empty or whitespace number as missing", () => {
    expect(displayOrderReference("", REAL_ID)).toBe("VL-8F2F12B9");
    expect(displayOrderReference("   ", REAL_ID)).toBe("VL-8F2F12B9");
  });

  it("handles an id with no order- prefix", () => {
    expect(displayOrderReference(null, "8f2f12b9-62b5-4630-9ff5-b11f27702553")).toBe("VL-8F2F12B9");
  });

  it("shows a neutral placeholder rather than an empty heading", () => {
    expect(displayOrderReference(null, null)).toBe("Pending");
    expect(displayOrderReference("", "")).toBe("Pending");
    expect(displayOrderReference(undefined, undefined)).toBe("Pending");
  });

  it("never leaks a stray prefix for a short or odd id", () => {
    expect(displayOrderReference(null, "order-")).toBe("Pending");
    expect(displayOrderReference(null, "order-abc")).toBe("VL-ABC");
  });
});
