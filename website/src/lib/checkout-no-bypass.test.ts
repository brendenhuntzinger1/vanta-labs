import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A card order must never reach the confirmation page without a payment session.
 *
 * This is the regression that let a shopper see "Thank you for your order" and
 * "Total paid $68.49" having never entered a card. The order row and its
 * inventory hold are written before the provider is called, so at the moment
 * this decision is made the order already exists — which is exactly why
 * treating a missing session as success looked harmless and was not.
 *
 * Asserted against the source because the alternative is a jsdom render of the
 * whole checkout page for one branch. The shapes below are the load-bearing
 * ones: if a refactor moves them, this fails loudly and someone re-reads the
 * branch rather than rediscovering the bug in production.
 */

const checkout = readFileSync(join(process.cwd(), "src/app/checkout/page.tsx"), "utf8");
const confirmation = readFileSync(join(process.cwd(), "src/components/order-confirmation-status.tsx"), "utf8");
const purchase = readFileSync(join(process.cwd(), "src/components/tiktok-purchase-event.tsx"), "utf8");

describe("checkout cannot present an unpaid order as placed", () => {
  it("refuses when the provider returned no payment session", () => {
    expect(checkout).toContain("if (!result.hostedCheckoutUrl) {");
  });

  it("keeps the cart when it refuses", () => {
    // The original bug cleared the cart on the way to the false thank-you page,
    // so the shopper could not even retry.
    const branch = checkout.slice(checkout.indexOf("if (!result.hostedCheckoutUrl) {"));
    const body = branch.slice(0, branch.indexOf("\n      }"));
    expect(body).not.toContain("clearCart()");
    expect(body).toContain("return;");
  });

  it("re-enables the submit button so a retry is possible", () => {
    const branch = checkout.slice(checkout.indexOf("if (!result.hostedCheckoutUrl) {"));
    const body = branch.slice(0, branch.indexOf("\n      }"));
    expect(body).toContain("submitLatchRef.current = false");
  });

  it("never navigates to the confirmation page as an alternative to paying", () => {
    // The exact shape of the old bug: an else branch that treated "no session"
    // as "order placed".
    expect(checkout).not.toMatch(/else\s*\{[^}]*order-confirmation/);
  });

  it("still sends a shopper to the payment session when there is one", () => {
    expect(checkout).toContain("window.location.assign(result.hostedCheckoutUrl)");
  });
});

describe("the confirmation page never claims money it does not have", () => {
  it("only says the payment is confirmed on the paid branch", () => {
    const confirmed = confirmation.indexOf("Order confirmed");
    const paidBranch = confirmation.indexOf("if (paid) {");
    expect(paidBranch).toBeGreaterThanOrEqual(0);
    expect(confirmed).toBeGreaterThan(paidBranch);
  });

  it("shows a confirming state rather than a paid one while the webhook lands", () => {
    expect(confirmation).toContain("Confirming your payment…");
  });

  it("labels the total by payment state, not by the amount_paid column", () => {
    const total = readFileSync(join(process.cwd(), "src/components/order-total-row.tsx"), "utf8");
    expect(total).toContain('paid ? "Total paid" : "Order total"');
    expect(total).toContain("Not yet charged");
  });
});

describe("no conversion is reported for an unpaid order", () => {
  it("the browser leg asks the server rather than trusting the URL", () => {
    expect(purchase).toContain("/api/ads/purchase-event/");
    expect(purchase).toContain("if (!body?.event) return;");
  });

  it("the server decides paid from the order's own payment_status", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/ads/purchase-event/[orderId]/route.ts"), "utf8");
    expect(route).toContain('String(order.payment_status ?? "").toLowerCase() === "paid"');
  });
});
