import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// THE GATE MUST NOT STAND BETWEEN A SHOPPER AND THE CARD FORM.
//
// Reproduced in a real browser against the production build: navigating to
// /checkout/pay/<id>, /pay/<id> or /order-confirmation/<id> rendered the age
// gate on top of the page. That is what a live shopper hit — address filled
// in, "Continue to secure payment" pressed, and then an age gate, which reads
// as a failed payment.
//
// The mechanism is the seam, not either half: create-session writes the order
// row, the checkout page navigates with window.location.assign(), and a full
// document load resets the gate's in-memory state (which is never persisted,
// on purpose). Both halves are correct; the handoff was not.
//
// These assert the route lists directly, because the alternative — mounting
// the gate in jsdom and driving usePathname — tests the harness more than the
// rule. The browser reproduction above is what proves the behaviour; this is
// what stops it coming back.
// ---------------------------------------------------------------------------

const GATE = path.join(__dirname, "age-gate.tsx");
const source = readFileSync(GATE, "utf8");

/** The array literal assigned to a top-level const, as written in the file. */
function routeList(name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`${name} is not declared in age-gate.tsx`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

describe("routes the age gate must not block", () => {
  const exempt = routeList("PAYMENT_AND_RECEIPT");

  it("the payment page is exempt — this is the one a live shopper hit", () => {
    expect(exempt).toContain("/checkout/pay");
  });

  it("the resubmit-payment page is exempt", () => {
    // Linked from the account order page and from a rejected-payment email.
    expect(exempt).toContain("/pay");
  });

  it("the confirmation page is exempt", () => {
    // The receipt link circulates; meeting an age gate on your own receipt is
    // the same interruption one step later.
    expect(exempt).toContain("/order-confirmation");
  });

  it("the exemption is actually wired into the verified check", () => {
    // A list nothing reads would leave the defect in place while looking fixed.
    expect(source).toMatch(/const isPaymentOrReceipt = matches\(PAYMENT_AND_RECEIPT\)/);
    expect(source).toMatch(/isVerified = localVerified \|\| isStaffArea \|\| isPaymentOrReceipt/);
  });
});

describe("routes the age gate must STILL block", () => {
  const exempt = [...routeList("PAYMENT_AND_RECEIPT"), ...routeList("STAFF_ONLY")];

  // The exemption is for people who have already attested at checkout. Anyone
  // still browsing has attested to nothing, so widening this list is how the
  // gate quietly stops existing.
  for (const shopperRoute of [
    "/",
    "/products",
    "/cart",
    "/checkout",
    "/membership",
    "/research",
    "/coa-library",
    "/account",
    "/ambassador",
    "/legal",
    "/wholesale",
  ]) {
    it(`${shopperRoute} is NOT exempt`, () => {
      expect(exempt).not.toContain(shopperRoute);
    });
  }

  it("/checkout itself is gated even though /checkout/pay is not", () => {
    // The prefix match means a careless "/checkout" entry would exempt the
    // whole funnel, including the page where the attestation is collected.
    expect(exempt).not.toContain("/checkout");
    expect(exempt).toContain("/checkout/pay");
  });

  it("no exemption is a bare prefix that swallows the site", () => {
    for (const entry of exempt) {
      expect(entry.startsWith("/"), `"${entry}" must be an absolute path`).toBe(true);
      expect(entry.length, `"${entry}" is too broad`).toBeGreaterThan(1);
    }
  });
});
