import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOrderSummaryLines, sumSummaryLines } from "@/lib/order-summary-breakdown";

// ---------------------------------------------------------------------------
// THREE SURFACES DESCRIBED ONE ORDER, AND THEY DID NOT AGREE.
//
// A $200 basket where the customer spent $55 of store credit and points, on a
// card, settling at $166.24:
//
//   the emailed receipt   "Credits applied  −$55.00"     (reads the columns)
//   the confirmation page "Adjustment       −$55.00"     (does not select them,
//                                                         so it lands in the
//                                                         residual)
//   the admin order page   nothing at all                 (five hand-written
//                                                         rows: subtotal,
//                                                         discount, shipping,
//                                                         tax, card fee)
//
// "Adjustment" reads like a correction the store made, not the customer
// spending their own balance. And the admin panel's lines simply did not sum to
// the "Total charged" printed beneath them — on any order carrying protection,
// handling, store credit or points, which is most of the ones an operator opens
// a detail page to argue about. Four recorded columns were missing from it, all
// four already on the row it selects with `*`.
//
// All three derive from buildOrderSummaryLines now. The rule that function has
// always enforced — the lines add up to what the card was charged — is what
// makes that safe to share.
// ---------------------------------------------------------------------------

const AMOUNTS = {
  total: 166.24,
  subtotal: 200,
  shipping: 0,
  handling: 0,
  tax: 16.4,
  discount: 0,
  itemsTotal: 200,
  shippingProtection: 0,
  cardProcessingFee: 4.84,
  creditsApplied: 55,
};

const code = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

describe("the customer's own balance", () => {
  it("is named, not left as an unlabelled Adjustment", () => {
    const lines = buildOrderSummaryLines(AMOUNTS);
    const credits = lines.find((line) => line.key === "credits");

    expect(credits?.label).toBe("Credits applied");
    expect(credits?.amount).toBe(-55);
    expect(lines.some((line) => line.key === "adjustment"), "nothing is left unexplained").toBe(false);
  });

  it("still adds up to the settled charge", () => {
    expect(sumSummaryLines(buildOrderSummaryLines(AMOUNTS))).toBeCloseTo(166.24, 2);
  });

  it("matches the wording the emailed receipt has always used", async () => {
    const { receiptAdjustmentsFromOrder } = await import("@/lib/email/order-confirmation-render");
    const fromRow = receiptAdjustmentsFromOrder({
      store_credit_redeemed_cents: 5000,
      points_redeemed: 500,
      shipping_protection_fee: 0,
    });
    // 50 dollars of credit plus 500 points; the exact points rate is the
    // email's to define, and the point here is that BOTH surfaces read it from
    // the same function rather than one of them inferring a remainder.
    expect(fromRow.creditsApplied).toBeGreaterThan(50);

    const lines = buildOrderSummaryLines({ ...AMOUNTS, creditsApplied: fromRow.creditsApplied });
    expect(lines.find((line) => line.key === "credits")?.label).toBe("Credits applied");
  });

  it("leaves an order with no credits exactly as it was", () => {
    const lines = buildOrderSummaryLines({ ...AMOUNTS, total: 221.24, creditsApplied: 0 });
    expect(lines.some((line) => line.key === "credits")).toBe(false);
    expect(sumSummaryLines(lines)).toBeCloseTo(221.24, 2);
  });
});

describe("every surface reads the same builder", () => {
  it.each([
    ["the confirmation page", "src/app/order-confirmation/[orderId]/page.tsx"],
    ["the admin order detail", "src/app/admin/orders/[orderId]/page.tsx"],
  ])("%s calls buildOrderSummaryLines with the credits", (_label, path) => {
    const src = code(path);
    expect(src).toContain("buildOrderSummaryLines({");
    expect(src).toContain("creditsApplied: receiptAdjustmentsFromOrder(");
  });

  it("the confirmation page actually SELECTS the two columns it now reads", () => {
    // The whole defect: the builder cannot name what the query never fetched.
    const src = code("src/app/order-confirmation/[orderId]/page.tsx");
    expect(src).toContain("store_credit_redeemed_cents");
    expect(src).toContain("points_redeemed");
  });

  it("the admin panel no longer hand-writes its own row list", () => {
    const src = code("src/app/admin/orders/[orderId]/page.tsx");
    const panel = src.slice(src.indexOf(">Charges<"), src.indexOf("Total charged"));
    for (const hardcoded of ["Sales tax", "Card processing fee"]) {
      expect(
        panel.includes(`>${hardcoded}<`),
        `${hardcoded} is still written by hand, so it can drift from the receipt again`,
      ).toBe(false);
    }
  });
});
