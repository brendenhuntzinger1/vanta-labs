import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The panel now embeds the manual shipping-cost entry form, a client component
// whose only browser dependency is useRouter().refresh(). Stubbed so the panel
// can still be rendered to static markup in a node test.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { AdminOrderProfitPanel, type OrderProfitView } from "@/components/admin-order-profit-panel";

// ---------------------------------------------------------------------------
// THE PANEL'S REVENUE LINES MUST ADD UP TO THE REVENUE FIGURE THEY EXPLAIN.
//
// This is the screen the owner reads to decide whether an order made money, and
// the whole point of the store-credit fix is that a redeeming order's lines now
// reconcile: merchandise + shipping + fees − redemption = gross revenue = cash.
//
// Mutation M7 in the money re-certification deleted the "Store credit & points
// redeemed" line outright and NOTHING went red — the panel had no test of any
// kind. Deleting it does not change a single stored number, which is exactly
// why it is dangerous: the owner is shown $117.00 of revenue lines on an order
// that collected $89.50, with nothing on the screen to explain the difference,
// and every figure behind it is correct. A display that cannot be wrong about
// the arithmetic is not a display that is right about it.
//
// Rendered through react-dom/server rather than asserted against the source
// text. A test that greps the file for a label passes on a component whose
// conditional has been deleted and whose string has been left behind — the
// precise failure mode commission-eligibility.test.ts was rewritten to escape.
// ---------------------------------------------------------------------------

/**
 * The canonical redeeming order, the same basket the profit suites use:
 *   $100 merchandise + $10 shipping + $7 protection & surcharge
 *   less $20.00 store credit and 750 points ($7.50) = $89.50 collected.
 *
 * Untaxed on purpose. Sales tax is inside `grossRevenue` when the owner counts
 * it as profit, but the panel deliberately prints it BELOW the net profit line
 * — money held for a state is not revenue, and anything above that line reads
 * as ours. Keeping tax at zero here lets the revenue block be compared with
 * grossRevenue directly; the taxed case is asserted separately at the bottom.
 */
const REDEEMING: OrderProfitView = {
  grossRevenue: 89.5,
  merchandiseRevenue: 100,
  shippingCharged: 10,
  additionalRevenue: 7,
  creditRedeemed: 27.5,
  taxCountedAsProfit: true,
  cogs: 24,
  shippingCost: 7,
  shippingCostIsEstimate: false,
  shippingCostSource: "shippo",
  shippingProfit: 3,
  processingFee: 7.8,
  commission: 15,
  refund: 0,
  taxCollected: 0,
  profit: 35.7,
  marginPercent: 39.9,
  profitStatus: "finalized",
  processingFeeIsEstimate: true,
  hasEstimatedCost: false,
};

function render(profit: OrderProfitView): string {
  return renderToStaticMarkup(<AdminOrderProfitPanel profit={profit} audit={[]} orderId="order-test" />);
}

/** Every `<dt>label</dt><dd>$x.xx</dd>` pair the panel rendered, in order. */
function rows(html: string): Array<{ label: string; amount: number }> {
  const out: Array<{ label: string; amount: number }> = [];
  const pattern = /<dt[^>]*>(.*?)<\/dt>\s*<dd[^>]*>(.*?)<\/dd>/g;
  for (const match of html.matchAll(pattern)) {
    const label = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    const text = match[2].replace(/<[^>]*>/g, " ");
    const money = /(-?)\$([\d,]+\.\d{2})/.exec(text);
    if (!money) continue;
    out.push({
      label,
      amount: Number(`${money[1]}${money[2].replace(/,/g, "")}`),
    });
  }
  return out;
}

/** The lines above the first divider: what came IN. */
const REVENUE_LABELS = [
  "Merchandise revenue",
  "Shipping collected",
  "Shipping protection & fees",
  "Store credit & points redeemed",
];

function revenueTotal(html: string): number {
  const sum = rows(html)
    .filter((row) => REVENUE_LABELS.includes(row.label))
    .reduce((acc, row) => acc + row.amount, 0);
  return Math.round(sum * 100) / 100;
}

describe("the order profit panel explains the revenue it reports", () => {
  it("shows the redemption as a NEGATIVE line", () => {
    const line = rows(render(REDEEMING)).find((row) => row.label === "Store credit & points redeemed");
    expect(line).toBeDefined();
    // Negative, not positive: it is a reduction of what was collected, not a
    // cost that was paid out. Rendered above Net profit for the same reason.
    expect(line!.amount).toBe(-27.5);
  });

  it("and the revenue lines therefore sum to grossRevenue, which is the cash", () => {
    const html = render(REDEEMING);
    expect(revenueTotal(html)).toBe(REDEEMING.grossRevenue);
    expect(revenueTotal(html)).toBe(89.5);
  });

  it("holds on an order with no redemption at all", () => {
    // Otherwise the assertion above could pass on a panel that always printed a
    // fixed deduction.
    const plain: OrderProfitView = { ...REDEEMING, creditRedeemed: 0, grossRevenue: 117 };
    const html = render(plain);
    expect(rows(html).some((row) => row.label === "Store credit & points redeemed")).toBe(false);
    expect(revenueTotal(html)).toBe(117);
  });

  it("holds when the redemption is the only thing between the lines and the total", () => {
    const creditOnly: OrderProfitView = {
      ...REDEEMING,
      shippingCharged: 0,
      additionalRevenue: 0,
      creditRedeemed: 20,
      grossRevenue: 80,
      shippingCostIsEstimate: true,
    };
    expect(revenueTotal(render(creditOnly))).toBe(80);
  });

  it("still puts sales tax BELOW the net profit line, where it is not revenue", () => {
    const html = render({ ...REDEEMING, taxCollected: 8, grossRevenue: 97.5 });
    const labels = rows(html).map((row) => row.label);
    const tax = labels.findIndex((label) => label.startsWith("Sales tax collected"));
    const net = labels.indexOf("Net profit");
    expect(tax).toBeGreaterThan(-1);
    expect(net).toBeGreaterThan(-1);
    expect(tax).toBeGreaterThan(net);
    // And it is not one of the revenue lines above the divider.
    expect(revenueTotal(html)).toBe(89.5);
  });
});

// ---------------------------------------------------------------------------
// THE PANEL MUST OFFER THE ENTRY THE SWEEP TELLS THE OPERATOR TO USE.
//
// shipping_cost_manual_entry_required fires for labels whose postage Shippo
// cannot report back, and says "Enter the cost by hand in Admin -> Orders; no
// automatic repair is possible." This panel is that screen, and it carried a
// comment stating the opposite -- that the form was removed because "the
// reconciliation sweep re-fetches it from Shippo rather than asking a human".
// For this class of order the sweep has already given up. Nothing on the page
// closed the loop.
//
// The pair below is the whole rule: offered when the figure is MISSING, absent
// when the figure was MEASURED. The second half preserves the reason the form
// was removed in the first place -- a typed figure must not be able to quietly
// outrank a Shippo-reported one.
// ---------------------------------------------------------------------------
describe("entering a shipping cost the sweep cannot recover", () => {
  it("offers the entry form while the exact cost is still unknown", () => {
    const html = render({ ...REDEEMING, shippingCostIsEstimate: true, profitStatus: "estimated" });
    expect(html).toContain("<input");
  });

  it("does not offer it once a measured cost has been recorded", () => {
    const html = render({ ...REDEEMING, shippingCostIsEstimate: false, profitStatus: "finalized" });
    expect(html).not.toContain("<input");
  });
});
