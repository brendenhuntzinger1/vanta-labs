import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// A card order whose webhook never arrives must still be recoverable.
//
// The processor session id was assigned to a local variable and returned to the
// caller, but never written to the order row — so card orders sat with
// payment_id null. reconcileVeyraPendingPayments selects
// `.not("payment_id", "is", null)`, which meant the one mechanism built to
// rescue a paid-but-unconfirmed order could not see the card lane at all. Its
// own comment states the cost: "money moved, order reads unpaid, stock released
// at reservation expiry".
// ---------------------------------------------------------------------------

describe("a card order records its processor session id", () => {
  const service = read("src/lib/payment-service.ts");

  it("writes the session id onto the order row, not just the response", () => {
    expect(service).toContain("paymentId = checkout.paymentId;");
    // The write must target the order that was just created.
    expect(service).toMatch(/\.update\(\{ payment_id: paymentId[\s\S]{0,80}\.eq\("order_id", orderId\)/);
  });

  it("never lets that bookkeeping write fail the checkout", () => {
    // The customer is mid-redirect to the processor. A failed write here must
    // log and continue — throwing would break a checkout that has succeeded.
    const idx = service.indexOf("payment_id: paymentId");
    const after = service.slice(idx, idx + 600);
    expect(after).toContain("console.error");
    expect(after).not.toMatch(/throw new Error/);
  });
});

describe("the reconciler can reach the orders that need it", () => {
  it("still only polls orders that carry a session id", () => {
    const reconcile = read("src/lib/express-reconcile.ts");
    // This filter is why persisting the id matters — it is the gate that was
    // excluding every card order.
    expect(reconcile).toContain('.not("payment_id", "is", null)');
    expect(reconcile).toContain('.eq("payment_status", "pending_payment")');
  });

  it("the webhook can still find an order by its session id", () => {
    // Persisting the id also restores this documented fallback path for
    // provider events that arrive without usable metadata.
    const webhook = read("src/lib/payment-webhook.ts");
    expect(webhook).toContain("findOrderIdByPaymentId");
    expect(webhook).toMatch(/\.eq\("payment_id", paymentId\)/);
  });
});
