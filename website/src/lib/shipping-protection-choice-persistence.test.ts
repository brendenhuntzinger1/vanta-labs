import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// A REMOVAL THAT DOES NOT SURVIVE THE NEXT PAGE LOAD IS NOT A REMOVAL.
//
// (Named for the CHOICE, not the fee: shipping-protection-persistence.test.ts
// is a different file about the fee surviving quote -> database.)
//
// Found in the browser, not in review. Shipping protection is pre-selected, and
// the whole case for pre-selecting it is that the shopper can take it off in
// one click. But the flag lived in a plain `useState(true)` while the cart
// ITEMS were persisted to localStorage, so the two disagreed about what a
// navigation means:
//
//   1. /cart, protection ticked by default, total $86.76
//   2. shopper unticks it -> $84.00, exactly as promised
//   3. shopper continues to /checkout
//   4. fresh mount, state resets to the default -> TICKED AGAIN, $89.36
//
// The shopper declined a paid add-on and was charged for it two clicks later.
// While the default was `false` this reset was invisible (it could only ever
// drop a fee the shopper had chosen); flipping the default is what turned it
// into a silent re-charge, which makes it exactly this change's problem.
//
// Both flags are persisted, not just the enabled one:
//   - `enabled` alone would restore the choice but forget it WAS a choice,
//     and the wallet gate reads the choice flag — so a shopper who deliberately
//     kept protection on /cart would lose it at Apple Pay after a page load.
//   - `choiceMade` alone restores nothing.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(path, "utf8");

const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CART_CONTEXT = "src/components/cart-context.tsx";

describe("the shipping-protection choice survives a page load", () => {
  it("is written to the same localStorage record as the cart items", () => {
    const source = code(CART_CONTEXT);
    // The persist effect's payload. Items and referralCode were already in it;
    // the protection flags have to ride along or they are forgotten on every
    // navigation.
    expect(source, "the persisted cart record does not include the protection flags").toMatch(
      /JSON\.stringify\(\{\s*items,\s*referralCode,\s*couponCode,\s*shippingProtectionEnabled,\s*shippingProtectionChoiceMade,?\s*\}\)/,
    );
  });

  it("re-writes storage when the shopper changes the choice", () => {
    // The effect must actually depend on the flags. Persisting them in the
    // payload but leaving them out of the dependency array means the write only
    // happens when something ELSE changes — so unticking protection and going
    // straight to checkout would still be forgotten.
    const source = code(CART_CONTEXT);
    expect(source, "the persist effect does not re-run when the protection choice changes").toMatch(
      /\}, \[items, referralCode, couponCode, shippingProtectionEnabled, shippingProtectionChoiceMade, isHydrated\]\)/,
    );
  });

  it("restores both flags on hydration", () => {
    const source = code(CART_CONTEXT);
    // Read back as booleans. A stored `false` must win over the `true` default,
    // which is the entire point, so this cannot be a truthiness check that
    // treats a missing value and an explicit false alike.
    expect(source, "the stored enabled flag is not restored").toMatch(
      /typeof parsed\.shippingProtectionEnabled === "boolean"/,
    );
    expect(source, "the stored choice flag is not restored").toMatch(
      /typeof parsed\.shippingProtectionChoiceMade === "boolean"/,
    );
  });


  // -------------------------------------------------------------------------
  // CROSS-TAB SYNC. Reported by the Vercel agent review on PR #147, verified
  // against the code, and real.
  //
  // cart-context listens for `storage` events so a second tab mirrors the
  // first. The handler synced `items` and `referralCode` only, and the comment
  // above it already names the hazard it exists to prevent: a stale tab can
  // "clobber the other tab's changes on its next save (last-writer-wins)".
  // The protection flags were exactly such a change.
  //
  //   1. two tabs open on the cart, protection default-on and untouched
  //   2. tab A unticks it -> localStorage {enabled:false, choiceMade:true}
  //   3. tab B's handler fires, syncs items, keeps its stale enabled:true
  //   4. that setItems moves a dependency of tab B's persist effect, which
  //      writes {enabled:true, choiceMade:false} straight back
  //
  // The shopper's explicit removal is erased and the paid add-on returns —
  // and choiceMade being reset ALSO downgrades a deliberate keep back to
  // "merely default-on", which the wallet gate reads. Before this change the
  // default was false, so a clobber could only ever remove a fee the shopper
  // had chosen; pre-selecting it is what turns the same race into a charge.
  // -------------------------------------------------------------------------
  it("the cross-tab storage handler syncs the protection flags too", () => {
    const source = code(CART_CONTEXT);
    const handler = /const handleStorage = \(event: StorageEvent\) => \{[\s\S]*?\n    \};/.exec(source);
    expect(handler, "no handleStorage function found").toBeTruthy();
    const body = handler![0];

    expect(body, "the cross-tab handler ignores shippingProtectionEnabled, so a stale tab re-adds the fee")
      .toMatch(/setShippingProtectionEnabled\(/);
    expect(body, "the cross-tab handler ignores shippingProtectionChoiceMade, so a stale tab downgrades a deliberate keep")
      .toMatch(/setShippingProtectionChoiceMade\(/);
    // Booleans, not truthiness: the value that has to survive is `false`.
    expect(body, "the cross-tab handler does not read the flags as booleans")
      .toMatch(/typeof parsed\.shippingProtectionEnabled === "boolean"/);
  });

  it("still defaults to on for a shopper with no stored choice", () => {
    // The restore must not accidentally turn the default off for a first-time
    // visitor whose localStorage has no protection keys at all.
    const source = code(CART_CONTEXT);
    const declaration = /const \[shippingProtectionEnabled, setShippingProtectionEnabled\] = useState\(([^)]*)\)/
      .exec(source);
    expect(declaration![1].trim()).toBe("true");
  });
});
