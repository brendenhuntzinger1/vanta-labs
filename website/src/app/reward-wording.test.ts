import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SPIN_PRIZES } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// ONE WORD, THE WHOLE WAY THROUGH.
//
// The rule, stated by the owner: use "gift" only if EVERY outcome is a product
// gift; the moment the wheel carries a discount, say "reward" consistently.
//
// The wheel carries three discount wedges (two at 15%, one at 20%), so "gift"
// is wrong — a percentage off an order you still pay for is not a gift, and a
// customer who reads "your gift" and lands on 15% off has been told the wrong
// thing by the store's own checkout.
//
// It was wrong in production. Driven end to end on 2026-09-17, one journey used
// three different words for one thing:
//
//     email      "reward"      Spin the wheel for your reward
//     /spin      "prize"       Your prize · Free GLOW 70mg
//     /cart      "gift"        YOUR GIFT · GLOW · $0.00
//     /checkout  "gift"        GIFT · Your one-time gift
//
// "prize" is left alone deliberately: on a wheel it is the natural word and it
// promises nothing about what the reward IS. "gift" is the one that names the
// kind of thing you are getting, so it is the one that has to be true.
//
// SOURCE-LEVEL ON PURPOSE. The alternative is asserting on rendered output,
// which means standing up a cart with a live offer in it — the failure this
// guards against is somebody typing the word back in, and reading the file
// catches that at the point it happens.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Strip comments, so prose ABOUT the banned word is not mistaken for the word. */
function code(src: string) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

/**
 * Customer-visible text only.
 *
 * Identifiers and structure are excluded by construction rather than by a
 * blocklist: `giftLines` and `giftProductLines` are variable names nobody
 * reads, `key={`gift-${…}`}` is a React key, `data-testid="cart-gift-line"` is
 * a test hook, and `@/lib/offers/campaign-gift` is a module path. Renaming any
 * of those would be churn with no customer on the other end of it.
 *
 * Note `\bgift\b` already spares camelCase — `giftLines` has a word character
 * after "gift" so it never matches. What needs removing is the punctuation
 * cases: `gift-${…}`, `campaign-gift`, `cart-gift-line`.
 */
function visibleCopy(src: string): string {
  return (
    code(src)
      // Module paths: import specifiers and dynamic imports.
      .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?/gm, " ")
      .replace(/from\s+["'][^"']+["']/g, " ")
      // Structural attributes, whether string- or expression-valued.
      .replace(/\b(className|key|data-testid|id|style|href|src|alt|name|value)\s*=\s*\{[^}]*\}/g, " ")
      .replace(/\b(className|key|data-testid|id|style|href|src|alt|name|value)\s*=\s*"[^"]*"/g, " ")
      // Template-literal keys and class strings that survived the above.
      .replace(/`[^`\n]*\$\{[^`]*`/g, " ")
      // JSX expression holes, so a text node split by {…} reads as one line.
      .replace(/\{[^{}]*\}/g, "")
  );
}

const CUSTOMER_SURFACES: Array<[string, string]> = [
  ["cart", "src/app/cart/cart-client.tsx"],
  ["checkout", "src/app/checkout/page.tsx"],
  ["attestation interstitial", "src/app/attest/page.tsx"],
  ["the wheel itself", "src/components/spin-wheel.tsx"],
  ["the wheel's disclosures", "src/lib/spin/disclosure.ts"],
];

describe("the reward is never called a gift while a discount wedge exists", () => {
  it("the wheel really does carry a discount, so the rule really does apply", () => {
    // If this ever hits zero the wheel became all-product, "gift" is honest
    // again, and this whole file should be deleted DELIBERATELY rather than the
    // copy drifting back on its own.
    const discountWedges = SPIN_PRIZES.filter((prize) => prize.reward.kind === "percent");
    expect(discountWedges.length).toBeGreaterThan(0);
  });

  for (const [label, path] of CUSTOMER_SURFACES) {
    it(`${label} says reward, not gift`, () => {
      const copy = visibleCopy(read(path));
      const offenders = copy
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /\bgifts?\b/i.test(line));

      expect(
        offenders,
        `${path} shows the customer the word "gift":\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  }
});

describe("labels built in the engine count as customer copy too", () => {
  // THE GAP THIS CLOSES. The first version of this file scanned JSX only, and
  // passed — while quote-order.ts was building the string "15% gift" and
  // handing it to the cart, the drawer, the checkout summary and the receipt.
  // A percentage off an order the customer still pays for is the single
  // clearest case of the word being wrong, and it was the one case the guard
  // could not see, because the text is assembled in a template literal in
  // pricing code rather than written between tags.
  it("the discount label for a percentage reward does not say gift", () => {
    const quote = code(read("src/lib/quote-order.ts"));

    // The label itself, wherever it is built.
    const labelLines = quote
      .split("\n")
      .filter((line) => /couponLabel\s*:/.test(line) || /%\s*gift/.test(line));

    expect(
      labelLines.filter((line) => /\bgift\b/i.test(line)),
      `quote-order.ts builds a customer-visible label containing "gift":\n  ${labelLines.join("\n  ")}`,
    ).toEqual([]);

    // And positively: it says reward.
    expect(quote).toMatch(/couponLabel:[^\n]*% reward/);
  });
});

describe("the journey agrees with itself end to end", () => {
  it("the cart and the checkout use the same word for the same thing", () => {
    const cart = visibleCopy(read("src/app/cart/cart-client.tsx"));
    const checkout = visibleCopy(read("src/app/checkout/page.tsx"));
    expect(cart).toMatch(/Your reward/);
    expect(checkout).toMatch(/Your one-time reward/);
  });

  it("the invitation email uses it too", () => {
    // The email's copy lives in its own preview test, which renders through the
    // real template. Here we only pin that the word survived.
    const emailCopy = read("src/lib/email/wheel-invitation-preview.test.ts");
    expect(emailCopy).toContain("Spin the wheel for your reward");
  });
});
