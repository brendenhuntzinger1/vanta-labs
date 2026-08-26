import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// THE PUBLISHED SHIPPING POLICY AND THE CART MUST AGREE ABOUT SHIPPING PROTECTION.
//
// src/lib/legal-content.ts, the `shipping` policy body, says this in the store's
// own words:
//
//   "Shipping Protection is an optional, store-backed service — not third-party
//    insurance — that you may add at checkout for a small fee based on your order
//    total. It is off by default and NEVER PRE-SELECTED."
//
// src/components/cart-context.tsx initialised it to `useState(true)`, so it was
// on by default and pre-selected on every cart, adding
// orders.shipping_protection_fee to the total unless the shopper noticed and
// unticked it.
//
// That is a specific, negative, published promise contradicted by the code, on a
// control that takes the customer's money. Pre-ticking a paid add-on while
// telling customers in writing that it is never pre-ticked is the shape
// regulators call negative-option billing, and the policy is the artefact a
// customer or a card network would read.
//
// Of the two sides, the code is the one to move: the published promise is the
// conservative position and needs no owner decision to be safe. If the business
// wants it pre-selected, that is a product decision AND a policy edit, together.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(path, "utf8");

describe("shipping protection is off by default, as the Shipping Policy promises", () => {
  it("the cart does not pre-select it", () => {
    const source = read("src/components/cart-context.tsx");
    expect(source).toContain("useState(false)");
    expect(source).not.toMatch(/const \[shippingProtectionEnabled, setShippingProtectionEnabled\] = useState\(true\)/);
  });

  it("the policy still makes the promise the cart is now keeping", () => {
    // If someone edits the policy to drop the promise, this test should be the
    // thing that makes them notice the cart default is the other half of it.
    const policy = read("src/lib/legal-content.ts");
    expect(policy).toContain("never pre-selected");
  });

  it("no other surface re-enables it by default", () => {
    for (const path of [
      "src/components/cart-drawer.tsx",
      "src/components/cart-client.tsx",
      "src/app/checkout/page.tsx",
    ]) {
      let source: string;
      try { source = read(path); } catch { continue; }
      expect(source, path).not.toMatch(/shippingProtection\w*\s*=\s*true/);
      expect(source, path).not.toMatch(/defaultChecked/);
    }
  });
});
