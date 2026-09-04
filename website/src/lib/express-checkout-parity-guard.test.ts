import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// WALLETS STAY OFF UNTIL THE EXPRESS LANE MATCHES THE CARD LANE.
//
// The 2026-09-04 audit found the Apple Pay / Google Pay lane builds its quotes
// without the one-time offer cookie and stamps no email attribution: a wallet
// customer would silently lose the gift their email promised, and the sale
// would never be credited to the automation or campaign that produced it.
// Wallets are switched off in production today, so nobody is affected — but an
// env var is a one-line change, and the day someone flips it the gifts break.
//
// So the env var is no longer sufficient on its own. EXPRESS_OFFER_PARITY in
// express-checkout.ts must ALSO be true, and this test refuses to let it be
// true until the express routes carry the same wiring the card lane has. The
// checks below are on the route SOURCE, on purpose: the harness cannot run a
// real wallet sheet, so the only honest thing to verify is that the code path
// exists. Real wallet verification still needs a registered host and a device.
// ---------------------------------------------------------------------------

const ROUTES = {
  session: path.resolve(__dirname, "../app/api/checkout/express/session/route.ts"),
  authorize: path.resolve(__dirname, "../app/api/checkout/express/authorize/route.ts"),
};

const REQUIRED_FOR_PARITY: Array<{ route: keyof typeof ROUTES; symbol: string; why: string }> = [
  { route: "session", symbol: "readOfferCookie(", why: "the wallet sheet's total must include the gift the email promised" },
  { route: "session", symbol: "offerToken:", why: "the express quote must be priced with the offer token" },
  { route: "authorize", symbol: "offerToken:", why: "the authorised order must be priced with the offer token" },
  { route: "authorize", symbol: "reserveCustomerOffer(", why: "the gift must be reserved before the order exists, as the card lane does" },
  { route: "authorize", symbol: "attributeOrderToAutomation({", why: "wallet orders must credit the automation that produced them" },
  { route: "authorize", symbol: "attributeOrderToCampaign({", why: "wallet orders must credit the campaign that produced them" },
  { route: "authorize", symbol: "stampMarketingSourceAtCreation({", why: "wallet orders must carry the one primary marketing source" },
];

/** The route's CODE, with comments removed — a comment that names a symbol is not wiring. */
function source(route: keyof typeof ROUTES): string {
  return readFileSync(ROUTES[route], "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("express checkout parity guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps wallets OFF even when the env var says on, while parity is not declared", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED", "true");
    const mod = await import("@/lib/express-checkout");
    if (!mod.EXPRESS_OFFER_PARITY) {
      expect(mod.EXPRESS_CHECKOUT_ENABLED, "wallets must not turn on before offer/attribution parity").toBe(false);
    } else {
      expect(mod.EXPRESS_CHECKOUT_ENABLED).toBe(true);
    }
  });

  it("stays off when the env var is unset, whatever the parity flag says", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED", "");
    const mod = await import("@/lib/express-checkout");
    expect(mod.EXPRESS_CHECKOUT_ENABLED).toBe(false);
  });

  it("refuses to declare parity until the express routes carry the card lane's offer and attribution wiring", async () => {
    const mod = await import("@/lib/express-checkout");
    const missing = REQUIRED_FOR_PARITY.filter((req) => !source(req.route).includes(req.symbol));
    if (mod.EXPRESS_OFFER_PARITY) {
      expect(
        missing,
        "EXPRESS_OFFER_PARITY is true but the express lane still lacks: "
          + missing.map((m) => `${m.route}: ${m.symbol} (${m.why})`).join("; "),
      ).toEqual([]);
    } else {
      // While parity is false, record what is still missing so the gap is
      // visible in the test output rather than only in a comment.
      expect(missing.length, "if nothing is missing any more, declare parity and let wallets be enabled").toBeGreaterThan(0);
    }
  });

  it("the money-moving authorize route checks the flag itself, not only the session route", () => {
    expect(source("authorize")).toContain("if (!EXPRESS_CHECKOUT_ENABLED)");
    expect(source("session")).toContain("if (!EXPRESS_CHECKOUT_ENABLED)");
  });

  it("names the exact env var an operator would reach for, so the guard is discoverable", () => {
    const text = readFileSync(path.resolve(__dirname, "express-checkout.ts"), "utf8");
    expect(text).toContain("NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED");
    expect(text).toContain("EXPRESS_OFFER_PARITY");
  });
});
