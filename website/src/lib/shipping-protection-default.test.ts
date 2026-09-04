import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// THE PUBLISHED SHIPPING POLICY AND THE CART MUST AGREE ABOUT SHIPPING PROTECTION.
//
// That is the invariant this file has always guarded, and it still is. What
// changed is the direction, not the rule.
//
// Shipping Protection is now PRE-SELECTED on the three surfaces that render a
// visible checkbox with the fee beside it — the cart drawer, /cart and
// /checkout — and src/lib/legal-content.ts says so in the store's own words:
//
//   "...added to your order by default for a small fee based on your order
//    total. It is shown as a separate line item in your cart and at checkout,
//    and you can remove it with one click at any time before you pay."
//
// The reason to keep testing this after the flip is that pre-selection is only
// defensible while the disclosure holds. A cart that pre-ticks a paid add-on is
// ordinary retail; a cart that pre-ticks one while its own published policy
// says it never does that is negative-option billing, and the policy is the
// artefact a customer or a card network would read. Either half can be edited
// alone by someone who does not know about the other, so both halves are
// pinned here, together, and moving one without the other fails.
//
// The wallet half of the promise lives in shipping-protection-wallet.test.ts:
// express checkout must NOT inherit this default, because it can take a
// payment without ever showing the checkbox.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(path, "utf8");

describe("shipping protection is pre-selected, and the Shipping Policy says so", () => {
  it("the cart pre-selects it", () => {
    // Matches the ONE declaration and reads its initial value out of the match,
    // rather than searching the file for a string. An earlier version of this
    // test asserted `source.toContain("useState(false)")`, which cart-context
    // satisfies ten times over — nine of them nothing to do with shipping
    // protection — so it passed even if the protection state was deleted
    // outright. Keep it anchored to the declaration.
    const source = read("src/components/cart-context.tsx");
    const declaration = /const \[shippingProtectionEnabled, setShippingProtectionEnabled\] = useState\(([^)]*)\)/
      .exec(source);

    expect(declaration, "no shippingProtectionEnabled useState declaration found at all").toBeTruthy();
    expect(
      declaration![1].trim(),
      "shipping protection is no longer pre-selected, but the Shipping Policy still tells customers it is",
    ).toBe("true");
  });

  it("the policy makes the promise the cart is keeping", () => {
    // The exact claims the pre-selected default depends on. If someone edits
    // the policy back to an opt-in description, this fails and points them at
    // the cart default as the other half of the change.
    const policy = read("src/lib/legal-content.ts");
    expect(policy).toContain("added to your order by default");
    expect(policy).toContain("remove it with one click");
  });

  it("the policy no longer carries the opt-in promise it used to", () => {
    // The old wording — "off by default and never pre-selected" — is now false
    // of the cart. Leaving it behind anywhere in the legal copy would be worse
    // than never having flipped the default, so it is banned outright.
    const policy = read("src/lib/legal-content.ts");
    expect(policy).not.toMatch(/never pre-selected/i);
    expect(policy).not.toMatch(/protection[^.]{0,80}off by default/i);
  });

  it("every surface that pre-selects it also shows a way to remove it", () => {
    // Pre-selection is only honest where the shopper can see and undo it. Each
    // of these surfaces must render the protection control, and it must be
    // bound to the cart state (so it reflects, and can clear, the default).
    for (const path of [
      "src/components/cart-drawer.tsx",
      "src/app/cart/cart-client.tsx",
      "src/app/checkout/page.tsx",
    ]) {
      const source = read(path);
      expect(source, `${path} no longer renders a protection control`)
        .toMatch(/checked=\{shippingProtectionEnabled\}/);
      expect(source, `${path} renders no way to switch protection off`)
        .toMatch(/setShippingProtectionEnabled/);
    }
  });
});
