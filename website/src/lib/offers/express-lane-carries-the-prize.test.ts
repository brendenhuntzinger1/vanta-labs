import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE WALLET SHEET HAS TO KNOW ABOUT THE PRIZE.
//
// FOUND BY ASKING, not by a failing test: "did you verify quick checkout in my
// cart?" No. And it was broken. Neither express route passed `offerToken` to
// quoteOrder, so a shopper who had won a free vial, opened the cart drawer and
// paid with Apple Pay was priced as though they held nothing — charged full
// price, with no gift line on the order and nothing on the sheet to explain it.
//
// The prize survived (it is only consumed by a reservation that never
// happened), so nobody lost an entitlement. What they lost was the vial on the
// order they had just paid for, which is the whole of what the wheel promises.
//
// BOTH ROUTES OR NEITHER. session/ prices the sheet the customer approves;
// authorize/ prices the charge. If only one knew about the gift the two totals
// would differ and `addressIndependentCents !== intent.amount_cents` would
// refuse the payment outright — a wheel winner unable to use Apple Pay at all.
// That is why this test pins the pair rather than either one.
// ---------------------------------------------------------------------------

const API = join(process.cwd(), "src", "app", "api", "checkout");
const SESSION = readFileSync(join(API, "express", "session", "route.ts"), "utf8");
const AUTHORIZE = readFileSync(join(API, "express", "authorize", "route.ts"), "utf8");
const FULL = readFileSync(join(API, "create-session", "route.ts"), "utf8");

describe("every lane that prices a cart reads the offer", () => {
  const LANES = [
    ["the full checkout", FULL],
    ["the express sheet", SESSION],
    ["the express charge", AUTHORIZE],
  ] as const;

  for (const [name, source] of LANES) {
    it(`${name} passes the offer token to quoteOrder`, () => {
      expect(source).toContain("offerToken: readOfferCookie(request) ?? undefined,");
    });

    it(`${name} imports the reader rather than parsing the cookie itself`, () => {
      // One parser. A second one is a second set of rules about a bearer token.
      expect(source).toContain("readOfferCookie");
      expect(source).not.toMatch(/cookies\(\)[^\n]*vl_offer/);
    });
  }
});

describe("what the express lane still does NOT do", () => {
  it("never redeems points, because a wallet sheet cannot ask for an amount", () => {
    expect(SESSION).toContain("pointsToRedeem: 0");
    expect(AUTHORIZE).toContain("pointsToRedeem: 0");
  });

  it("re-prices from the frozen items, never the live cart", () => {
    // The gift is the one thing that may now differ between the sheet and the
    // charge, and it differs only in the safe direction: quoteOrder resolves it
    // from the ledger both times, and a prize that expired in between is simply
    // absent from the second quote — which the amount check then catches.
    expect(AUTHORIZE).toContain("items: intent.items.map((item) => ({ id: item.id, quantity: item.quantity }))");
  });
});
