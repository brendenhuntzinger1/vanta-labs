import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments: the note recording this fix quotes the pattern it bans. */
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

const cart = code(read("src/components/cart-context.tsx"));
const layout = code(read("src/app/layout.tsx"));

// ---------------------------------------------------------------------------
// THE CART PRICED WITH ITS BUILT-IN DEFAULTS FOR THE WHOLE SESSION.
//
// CartProvider fetches everything it prices with — the shipping config, the
// promotions, the bundle rates, the member and ambassador discounts, the points
// and store-credit balances — in mount effects with EMPTY dependency arrays.
// That was correct while the store served anonymous visitors: the config
// arrived once and could not change under a shopper.
//
// Closing the default made it wrong, silently. The provider lives in the ROOT
// layout, so it mounts on the sign-in portal — the first page every visitor now
// sees — where all of those endpoints answer 401 and every effect returns
// early. Signing in is a client-side navigation plus router.refresh(), and
// neither remounts a provider above the changing segment, so the effects never
// ran again.
//
// Measured in a real browser against the harness with Free Shipping Sitewide
// ON — portal, sign in through the form, then click through to the catalogue,
// a product and the cart with no reload at any point:
//
//     shown to the shopper     Estimated shipping  $15.00
//                              "Free shipping at $200.00 — $131.00 away"
//                              Estimated total     $88.14
//     charged by the server    shipping            $0.00
//                              total               $73.14
//
// A $15 phantom fee and a "spend $131 more" nag on a store that ships
// everything free, and then a checkout whose expectedTotal cannot match. The
// live Buy 2 Get 1 promotion was missing from the same session for the same
// reason.
// ---------------------------------------------------------------------------

describe("the cart refetches its configuration when the viewer signs in", () => {
  it("the provider is told whether the viewer is signed in", () => {
    expect(cart).toMatch(/export function CartProvider\(\s*\{\s*children,\s*signedIn/);
  });

  it("the root layout passes the value it already resolves", () => {
    expect(layout).toContain("const signedIn = Boolean(await getAuthenticatedUser())");
    expect(layout).toContain("<CartProvider signedIn={signedIn}>");
  });

  it.each([
    ["the shipping config and promotions", '"/api/catalog/promotions"'],
    ["the member/points/store-credit state", '"/api/account/me"'],
    ["the ambassador discount", '"/api/account/ambassador-discount"'],
    ["the bulk savings config", '"/api/catalog/bulk-savings-config"'],
    ["the promotion eligibility check", '"/api/catalog/promotions/eligibility"'],
  ])("%s is refetched when signedIn changes", (_label, endpoint) => {
    const at = cart.indexOf(endpoint);
    expect(at, `${endpoint} must still be fetched here`).toBeGreaterThan(-1);
    // The dependency array closing this effect must name signedIn.
    const after = cart.slice(at);
    const deps = after.match(/\n\s*\}, \[([^\]]*)\]\);/);
    expect(deps, `no dependency array found after ${endpoint}`).not.toBeNull();
    expect(deps?.[1], `${endpoint} still has a mount-only effect, so a shopper who signs in keeps the defaults`).toContain("signedIn");
  });

  it("the referral code is revalidated too, so the ambassador's discount appears", () => {
    // The same 401, with a sharper cost. An unresolved code renders with no
    // ambassador name and no discount, next to a CLEAR button that expires
    // vl_referral_code — so a shopper who reasonably concludes the code failed
    // destroys the attribution for that sale and for the rest of the thirty-day
    // window.
    const at = cart.indexOf("validateReferralCodeClient(referralCode)");
    expect(at, "the referral code must still be validated in the provider").toBeGreaterThan(-1);
    const deps = cart.slice(at).match(/\n\s*\}, \[([^\]]*)\]\);/);
    expect(deps).not.toBeNull();
    expect(deps?.[1]).toContain("signedIn");
  });

  it("does not remount the provider to solve it, which would empty the cart", () => {
    // A key={signedIn} on CartProvider would refetch by throwing the shopper's
    // basket away. The prop exists precisely so the state survives.
    expect(layout).not.toMatch(/<CartProvider[^>]*key=/);
  });
});
