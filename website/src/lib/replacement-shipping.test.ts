import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Replacements are now the store's standard remedy rather than a shipping
// protection edge case, so they carry the same obligations as a paid order:
// they have to reach the right address, and they have to reach Shippo quickly.
//
// A replacement is by definition already a late parcel -- it exists because the
// first one failed -- which makes both failures worse here than on a normal
// order. A dropped apartment line sends the apology to the wrong door.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");
const module_ = readFileSync(join(SRC, "lib/admin-replacements.ts"), "utf8");
const route = readFileSync(join(SRC, "app/api/admin/orders/[orderId]/route.ts"), "utf8");

describe("a replacement order", () => {
  // The bug: shipping_address_2 was added to checkout and to the Shippo push
  // but never to the row a replacement copies, so the unit number was silently
  // dropped on exactly the reship that had to arrive.
  it("copies the apartment line from the original", () => {
    expect(module_).toContain("shipping_address_2: original.shipping_address_2 ?? null");
  });

  it("copies the state and phone, which carriers require", () => {
    expect(module_).toContain("state: original.state ?? null");
    expect(module_).toContain("phone: original.phone ?? null");
  });

  // The missing-column fallback used to drop straight to a row with no state
  // and no phone. Carriers reject a US shipment without a state, so that
  // "graceful" path produced an order that could never ship.
  it("keeps state and phone when retrying a missing-column insert", () => {
    const fallback = module_.slice(module_.indexOf("looksLikeMissingColumn"));
    // Compare the INSERTS, not any mention of the names -- the comment above
    // the code names baseOrderRow first, which a looser match would trip on.
    expect(fallback).toContain("insert(retryRow)");
    expect(fallback.indexOf("insert(retryRow)")).toBeLessThan(fallback.indexOf("insert(baseOrderRow)"));
  });

  it("is a real $0 order, so it flows through the normal fulfillment queue", () => {
    expect(module_).toContain('order_type: "replacement"');
    expect(module_).toContain('payment_status: "paid"');
    expect(module_).toContain("amount_paid: 0");
  });

  // Money must not move and nobody must be paid twice for a failed delivery.
  it("earns no commission, points or coupon", () => {
    expect(module_).toContain("referral_code: null");
    expect(module_).toContain("ambassador_id: null");
    expect(module_).toContain("coupon_code: null");
    expect(module_).toContain("points_redeemed: 0");
  });

  it("reaches Shippo immediately rather than waiting for the sweep", () => {
    const block = route.slice(route.indexOf('action === "send_replacement"'));
    expect(block).toContain("syncOrderToShippo(replacement.orderId)");
    expect(block).toContain("after(");
  });

  // Same reasoning as the payment webhook: a Shippo call can take 15 seconds,
  // and nothing that talks to a third party belongs on a response path.
  it("does not await the Shippo call inside the response", () => {
    const block = route.slice(route.indexOf('action === "send_replacement"'));
    const syncAt = block.indexOf("syncOrderToShippo(replacement.orderId)");
    const afterAt = block.indexOf("after(");
    expect(afterAt).toBeGreaterThan(-1);
    expect(afterAt).toBeLessThan(syncAt);
  });
});
