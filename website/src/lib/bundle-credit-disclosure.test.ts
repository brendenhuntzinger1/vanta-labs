// ---------------------------------------------------------------------------
// THE SAVINGS A SHOPPER CANNOT ADD UP.
//
// Reported from a phone, cart contents visible in the screenshot:
//
//     GLP-1                       x2      $85.48
//     Recon Water (0.9% Benzyl…)    x1      $14.99
//     Subtotal                            $100.47
//     Buy 2 Get 1 Free                    -$10.49
//
// "Buy 2 Get 1 Free" next to $10.49, on a basket whose cheapest — and
// therefore free — unit costs $14.99. Every number there is arithmetically
// correct and the card is charged the right amount; the shopper simply has no
// way to see it.
//
// What is missing is the quantity-bundle discount. Two GLP-1 at $44.99 earn the
// 5% two-unit tier, so $4.50 comes off inside the line prices before any
// order-level discount competes, and resolveCartDiscount then ranks every
// candidate on what it saves BEYOND that. The promotion is worth $14.99, the
// bundle already granted $4.50 of it, and the row shows the $10.49 remainder
// against a subtotal that has silently absorbed the rest.
//
// The arithmetic is not the bug and is deliberately not touched here — it is
// the server's, and payment-service.ts refuses any order whose claimed total
// sits below it. The bug is that $4.50 of a shopper's savings is stated
// nowhere, which turns a correct total into one that looks wrong.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { bundleCreditNote } from "@/lib/discount-resolution";

const usd = (value: number) => `$${value.toFixed(2)}`;

describe("bundleCreditNote", () => {
  it("accounts for the savings the subtotal already absorbed", () => {
    expect(bundleCreditNote({ bundleSavings: 4.5, discountAmount: 10.49, format: usd }))
      .toBe("Bundle & Save already took $4.50 off the prices above — $14.99 off in total.");
  });

  it("says nothing when there is no bundle discount hiding in the subtotal", () => {
    expect(bundleCreditNote({ bundleSavings: 0, discountAmount: 10.49, format: usd })).toBeNull();
  });

  it("says nothing when no order-level discount was netted down", () => {
    // Bundle pricing on its own is disclosed line by line, next to the price it
    // moved. There is no netting to explain, so there is nothing to add.
    expect(bundleCreditNote({ bundleSavings: 4.5, discountAmount: 0, format: usd })).toBeNull();
  });

  it("adds the two halves rather than restating either", () => {
    expect(bundleCreditNote({ bundleSavings: 6.9, discountAmount: 8.09, format: usd }))
      .toBe("Bundle & Save already took $6.90 off the prices above — $14.99 off in total.");
  });

  it("rounds the sum to the cent rather than trailing float noise", () => {
    expect(bundleCreditNote({ bundleSavings: 0.1, discountAmount: 0.2, format: usd }))
      .toBe("Bundle & Save already took $0.10 off the prices above — $0.30 off in total.");
  });
});

// ---------------------------------------------------------------------------
// AND IT HAS TO BE ON THE PAGE.
//
// There is no DOM-testing library in this project, so a correct sentence that
// no surface renders would pass every test above while the shopper still sees
// the bare "-$10.49". These read the source, as cart-server-discount-parity.ts
// does for the same reason: it is the only check available that the three
// surfaces which show a discount row all show this with it.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("the surfaces that show a netted discount row", () => {
  const SURFACES = [
    "src/app/cart/cart-client.tsx",
    "src/app/checkout/page.tsx",
    "src/components/cart-drawer.tsx",
  ];

  it.each(SURFACES)("%s explains the netting rather than only printing it", (path) => {
    const source = read(path);
    expect(source).toContain("bundleCreditNote({");
    // Fed the SAME amount the row prints, not the pre-quote client figure — the
    // two differ whenever an armed offer repriced the cart server-side.
    expect(source).toMatch(/bundleCreditNote\(\{[^}]*discountAmount: shownDiscount/);
    expect(source).toMatch(/bundleCreditNote\(\{[^}]*bundleSavings/);
    // Rendered, and only when there is something to say. Asserting the name
    // appears somewhere is not enough: it appears in its own assignment, so a
    // surface that computed the sentence and dropped it would still pass.
    expect(source).toMatch(/\{bundleNote \? /);
    expect(source).toContain(">{bundleNote}</p>");
  });

  it("takes the bundle savings from the cart rather than recomputing them", () => {
    // A second derivation of "what did the tiers grant" is a second thing to
    // drift from resolveCartDiscount's `compete()`. The provider publishes one.
    const context = read("src/components/cart-context.tsx");
    expect(context).toContain("bundleSavings: quantityBundleSavings");
    for (const path of SURFACES) {
      expect(read(path)).toMatch(/\n\s*bundleSavings,\n/);
    }
  });

  it("counts bundle pricing in the checkout's 'You saved' figure", () => {
    // The tiers are a saving the shopper earned; leaving them out understated
    // their own order by every dollar Bundle & Save had granted.
    const checkout = read("src/app/checkout/page.tsx");
    expect(checkout).toMatch(/const totalSaved = [^;]*bundleSavings/);
  });
});
