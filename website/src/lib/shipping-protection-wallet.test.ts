import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// EXPRESS / WALLET CHECKOUT MUST NOT INHERIT THE PRE-SELECTED DEFAULT.
//
// Shipping Protection is pre-selected in the cart drawer, /cart and /checkout.
// Each of those renders a checkbox with the fee next to it, so a shopper who
// pays with the card form has necessarily been shown the charge and can clear
// it in one click. That is what makes the default defensible, and
// shipping-protection-default.test.ts pins it against the published policy.
//
// Apple Pay / Google Pay are the case where that reasoning fails. The express
// button can go from tap to authorized payment without our checkbox ever
// rendering — there is nowhere in a PassKit sheet to untick an add-on. Passing
// the default-on flag into that lane would bill people for something they were
// never shown and never agreed to, which is the precise thing the visible
// checkbox exists to prevent, and it would be the sketchiest possible reading
// of "on by default".
//
// So the wallet lane reads `shippingProtectionChosen` — enabled AND explicitly
// chosen by the shopper — rather than `shippingProtectionEnabled`. The flag can
// only become true on a surface that was displaying the fee at the time, so
// express carries protection when it was deliberately kept and never merely
// because it defaults on.
//
// These are source assertions because the rule lives in a React component and
// in the field a fetch body sends; the failure they exist to catch is somebody
// "tidying up" the two nearly-identical names into one.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Source with comments removed. A source-text assertion that prose can satisfy
 * is not testing the code — and the comments in these files necessarily name
 * `shippingProtectionEnabled` while explaining why the wallet must not use it.
 */
// NOTE: deliberately NOT the `{\/* ... *\/}` -> "" pass that
// shipping-protection-offer-price.test.ts uses. That pattern requires a `}`
// after the comment, so on a file where the first `*\/` is not followed by one
// it backtracks to a LATER `*\/}` and swallows everything in between — here it
// ate 25KB of the 30KB express button, including every line this file asserts
// on, and the tests failed against source that was perfectly correct.
// Stripping block comments on their own already empties a JSX comment; the
// leftover `{}` is harmless.
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const EXPRESS_BUTTON = "src/components/express-apple-pay-button.tsx";
const CART_CONTEXT = "src/components/cart-context.tsx";

describe("wallet checkout cannot silently charge for shipping protection", () => {
  it("the express button never reads the raw default-on flag", () => {
    const source = code(EXPRESS_BUTTON);
    expect(
      source,
      "express checkout reads shippingProtectionEnabled, so a one-tap wallet payment would carry a fee the shopper was never shown",
    ).not.toMatch(/shippingProtectionEnabled/);
  });

  it("the express button sends the explicit-choice flag to the server instead", () => {
    const source = code(EXPRESS_BUTTON);
    expect(source, "express checkout no longer pulls shippingProtectionChosen off the cart")
      .toMatch(/shippingProtectionChosen/);
    // The field actually posted to /api/checkout/express/session, which is what
    // express_checkout_intents.shipping_protection is stored from and what
    // express/authorize re-quotes against.
    expect(
      source,
      "the express session request no longer sends the chosen flag as shippingProtection",
    ).toMatch(/shippingProtection:\s*shippingProtectionChosen/);
  });

  it("the chosen flag requires BOTH selection and a deliberate choice", () => {
    const source = code(CART_CONTEXT);
    // Not just `= shippingProtectionEnabled`: the whole point is the second
    // conjunct. If someone simplifies this to an alias, wallets silently start
    // inheriting the default again and every other test here still passes.
    expect(source, "shippingProtectionChosen is no longer derived from an explicit choice").toMatch(
      /const shippingProtectionChosen\s*=\s*shippingProtectionEnabled\s*&&\s*shippingProtectionChoiceMade/,
    );
  });

  it("the choice flag starts false, so an untouched cart is not a choice", () => {
    const source = code(CART_CONTEXT);
    const declaration = /const \[shippingProtectionChoiceMade, setShippingProtectionChoiceMade\] = useState\(([^)]*)\)/
      .exec(source);
    expect(declaration, "no shippingProtectionChoiceMade state found").toBeTruthy();
    expect(
      declaration![1].trim(),
      "the cart claims a choice was made before the shopper touched anything",
    ).toBe("false");
  });

  it("the setter the UI calls is the one that records the choice", () => {
    // The context deliberately exports `chooseShippingProtection` under the
    // name `setShippingProtectionEnabled`, so every existing call site — all of
    // them real shopper interactions with a visible control — records the
    // choice without being touched. If this is ever pointed back at the bare
    // state setter, unticking and re-ticking would stop counting as a choice
    // and wallets would lose protection the shopper actually asked for.
    const source = code(CART_CONTEXT);
    expect(source, "the exported setter no longer records that a choice was made").toMatch(
      /setShippingProtectionEnabled:\s*chooseShippingProtection/,
    );
    expect(source, "chooseShippingProtection no longer marks the choice as made").toMatch(
      /chooseShippingProtection\s*=\s*useCallback\(\(enabled: boolean\) => \{\s*setShippingProtectionChoiceMade\(true\)/,
    );
  });

  it("the published policy tells shoppers what wallets do", () => {
    // The policy describes pre-selection; it must also describe the exception,
    // or it is inaccurate in the shopper-favourable direction rather than the
    // other one — still inaccurate.
    const policy = read("src/lib/legal-content.ts");
    expect(policy).toMatch(/Express wallet checkouts/i);
  });
});
