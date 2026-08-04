import { describe, expect, it } from "vitest";
import { buildOrderSummaryLines, sumSummaryLines, type OrderAmounts } from "./order-summary-breakdown";

function amounts(overrides: Partial<OrderAmounts> = {}): OrderAmounts {
  return {
    total: 0,
    subtotal: 0,
    shipping: 0,
    handling: 0,
    tax: 0,
    discount: 0,
    itemsTotal: 0,
    ...overrides,
  };
}

describe("buildOrderSummaryLines", () => {
  it("reproduces the real order that left $21.05 unexplained", () => {
    // GLP-1 (5mg) × 1 at $54.99 that settled at $76.04. Before the residual
    // line the receipt showed only the item and the total.
    const lines = buildOrderSummaryLines(amounts({ total: 76.04, subtotal: 54.99, itemsTotal: 54.99 }));

    expect(sumSummaryLines(lines)).toBe(76.04);
    const protection = lines.find((line) => line.key === "protection");
    expect(protection?.amount).toBe(21.05);
  });

  it("always sums to the settled charge", () => {
    const cases: OrderAmounts[] = [
      amounts({ total: 76.04, subtotal: 54.99, itemsTotal: 54.99 }),
      amounts({ total: 120, subtotal: 100, shipping: 6, handling: 2, tax: 12, itemsTotal: 100 }),
      amounts({ total: 89.5, subtotal: 100, discount: 15, shipping: 4.5, itemsTotal: 100 }),
      amounts({ total: 54.99, subtotal: 54.99, itemsTotal: 54.99 }),
      amounts({ total: 40, subtotal: 54.99, itemsTotal: 54.99 }), // post-hoc adjustment
      amounts({ total: 0, subtotal: 0, itemsTotal: 0 }),
    ];

    for (const input of cases) {
      expect(sumSummaryLines(buildOrderSummaryLines(input))).toBe(Math.round(input.total * 100) / 100);
    }
  });

  it("shows a shortfall as a credit rather than hiding it", () => {
    const lines = buildOrderSummaryLines(amounts({ total: 40, subtotal: 54.99, itemsTotal: 54.99 }));
    const adjustment = lines.find((line) => line.key === "adjustment");

    expect(adjustment).toBeDefined();
    expect(adjustment?.amount).toBe(-14.99);
    expect(adjustment?.tone).toBe("credit");
    expect(lines.some((line) => line.key === "protection")).toBe(false);
  });

  it("falls back to item totals when subtotal was never recorded", () => {
    const lines = buildOrderSummaryLines(amounts({ total: 54.99, subtotal: 0, itemsTotal: 54.99 }));

    expect(lines.find((line) => line.key === "subtotal")?.amount).toBe(54.99);
    // Without the fallback the whole order value would land in the residual.
    expect(lines.some((line) => line.key === "protection")).toBe(false);
  });

  it("always shows subtotal and shipping, and hides empty optional lines", () => {
    const lines = buildOrderSummaryLines(amounts({ total: 54.99, subtotal: 54.99, itemsTotal: 54.99 }));
    const keys = lines.map((line) => line.key);

    expect(keys).toContain("subtotal");
    expect(keys).toContain("shipping");
    expect(keys).not.toContain("discount");
    expect(keys).not.toContain("handling");
    expect(keys).not.toContain("tax");
  });

  it("renders a discount as a negative credit line", () => {
    const lines = buildOrderSummaryLines(amounts({ total: 85, subtotal: 100, discount: 15, itemsTotal: 100 }));
    const discount = lines.find((line) => line.key === "discount");

    expect(discount?.amount).toBe(-15);
    expect(discount?.tone).toBe("credit");
  });

  it("treats sub-cent residuals as float noise, not money", () => {
    const lines = buildOrderSummaryLines(amounts({ total: 54.99 + 0.001, subtotal: 54.99, itemsTotal: 54.99 }));

    expect(lines.some((line) => line.key === "protection" || line.key === "adjustment")).toBe(false);
  });

  it("survives null-ish and non-finite amounts without emitting NaN", () => {
    const lines = buildOrderSummaryLines({
      total: Number.NaN,
      subtotal: undefined as unknown as number,
      shipping: null as unknown as number,
      handling: Number.NaN,
      tax: null as unknown as number,
      discount: undefined as unknown as number,
      itemsTotal: 0,
    });

    for (const line of lines) {
      expect(Number.isFinite(line.amount)).toBe(true);
    }
    expect(sumSummaryLines(lines)).toBe(0);
  });
});
