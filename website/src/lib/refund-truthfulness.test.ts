import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { providerSettlesRefunds } from "@/lib/payment-provider";

// ---------------------------------------------------------------------------
// The refund button does not send money.
//
// LivePaymentProvider.refundPayment() is a no-op: there is no refund
// integration with the processor. Everything else about a refund is real --
// the order is marked refunded, commission is reversed, stock is restocked --
// which is exactly what makes it dangerous. It looks completed from every
// angle except the customer's bank account.
//
// The email was the harm. "Your refund has been processed" tells someone to
// expect money that is not coming; they wait, nothing arrives, and the next
// thing that happens is a chargeback -- which costs more than the refund would
// have and is reported against the merchant account.
//
// These tests fail the moment that email can be sent again without settlement.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");
const route = readFileSync(join(SRC, "app/api/admin/orders/[orderId]/route.ts"), "utf8");
const actions = readFileSync(join(SRC, "components/admin-order-actions.tsx"), "utf8");

describe("refunds tell the truth", () => {
  it("reports that the processor does not settle refunds", () => {
    // When a real integration lands this flips, and the email gate below opens
    // on its own. Until then it must be honest.
    expect(providerSettlesRefunds()).toBe(false);
  });

  it("gates the customer refund email on money actually having moved", () => {
    expect(route).toContain("providerRefunded");
    expect(route).toContain("if (order.customer_email && providerRefunded)");
  });

  it("never sends that email unconditionally", () => {
    // The original bug, in one line: the send was guarded only on an address
    // existing, so every recorded refund announced itself as processed.
    expect(route).not.toContain("if (order.customer_email) {\n        const refundEmail");
  });

  it("tells the admin in the response that no money was sent", () => {
    expect(route).toContain("NO money has been sent");
    expect(route).toContain("customerNotified");
  });

  it("records in the audit log whether money moved", () => {
    const auditBlock = route.slice(route.indexOf('action: "order_refund"'));
    expect(auditBlock.slice(0, 600)).toContain("providerRefunded");
  });

  // The fact was previously rendered in the page's smallest, greyest text.
  it("states it prominently in the admin, not as helper text", () => {
    expect(actions).toContain("This does not send money.");
    expect(actions).not.toMatch(/text-xs text-zinc-500">\s*Updates this order/);
  });

  it("says so again in the confirmation prompt", () => {
    expect(actions).toContain("NO MONEY WILL BE SENT");
  });
});
