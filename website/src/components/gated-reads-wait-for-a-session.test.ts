import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE FIRST SCREEN EVERY VISITOR SEES ASKED FOR SEVEN THINGS IT COULD NOT HAVE.
//
// Closing the default made /account/login the front door, and the root layout
// mounts CartProvider, the cart drawer and the BAC-water upsell on it. Every one
// of their reads is behind the account wall, so an anonymous visitor's first
// impression of the store included seven refused requests and seven console
// errors — measured in the browser against the harness:
//
//   401 /api/account/me                    401 /api/catalog/promotions
//   401 /api/account/ambassador-discount   401 /api/catalog/bulk-savings-config
//   401 /api/catalog/promotions/eligibility
//   401 /api/offer/status                  401 /api/catalog/bac-water
//
// None of them could ever succeed there. `signedIn` already travels from the
// layout (it is what makes the cart re-read its configuration the moment a
// session appears), so the guard costs nothing.
//
// AND ONE OF THEM WAS NOT MERELY NOISE. fetchBacWater cached its result in
// module scope for the page session and treated a 401 as "there is no such
// product" — so the anonymous call on the portal latched null and the upsell
// never appeared again for that visitor, however many times they opened the
// cart after signing in.
// ---------------------------------------------------------------------------

const code = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const cart = code("src/components/cart-context.tsx");
const drawer = code("src/components/cart-drawer.tsx");
const bacWater = code("src/components/bac-water-upsell.tsx");

describe("the layout's gated reads wait for a session", () => {
  it("the cart context publishes whether the viewer has one", () => {
    expect(cart).toMatch(/signedIn: boolean;/);
    expect(cart).toMatch(/\n\s*signedIn,\n/);
  });

  it.each([
    ["the cart drawer's pending-offer read", drawer, '"/api/offer/status"'],
    ["the BAC-water upsell", bacWater, '"/api/catalog/bac-water"'],
  ])("%s waits for it", (_label, src, endpoint) => {
    expect(src).toContain(endpoint);
    expect(src).toContain("if (!signedIn) return;");
    expect(src).toContain("useCart()");
  });
});

describe("a refused read is not an answer", () => {
  it("fetchBacWater does not cache a non-ok response as 'no such product'", () => {
    const fn = bacWater.slice(bacWater.indexOf("function fetchBacWater"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("if (!response.ok) throw");
    expect(body, "a refusal must not be written into the module cache").not.toMatch(
      /if \(!response\.ok\) return null;/,
    );
  });

  it("and clears the in-flight promise so a later mount retries", () => {
    const fn = bacWater.slice(bacWater.indexOf("function fetchBacWater"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("pendingFetch = null;");
  });
});
