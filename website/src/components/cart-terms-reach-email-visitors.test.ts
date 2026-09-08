import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EMAIL_GRANT_COOKIE } from "@/lib/email/link-grant";
import { GUEST_GRANT_COOKIE } from "@/lib/cart-recovery-grant";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments: the notes below quote the very patterns they ban. */
const code = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

const layout = code(read("src/app/layout.tsx"));
const cart = code(read("src/components/cart-context.tsx"));
const drawer = code(read("src/components/cart-drawer.tsx"));
const cartPage = code(read("src/app/cart/cart-client.tsx"));

// ---------------------------------------------------------------------------
// "FREE SHIPPING AT $200.00 — $108.82 AWAY", ON A STORE SHIPPING EVERYTHING FREE.
//
// This store puts the whole catalogue behind an account wall, and three email
// click trackers mint a browse grant so a recipient can shop without one: cart
// recovery, campaigns, automations. The wall consults that grant last, so all
// three land a SIGNED-OUT shopper on the cart.
//
// The cart prices what it shows from /api/catalog/promotions — shipping config,
// live promotions, bundle rates, sales tax — and asked for it only when
// signedIn. Every emailed shopper therefore priced against
// DEFAULT_SHIPPING_CONFIG, contradicting the email that had just told them
// shipping was free.
//
// THE FIRST FIX SNIFFED THE RECOVERY COOKIE IN THE BROWSER, and that is the
// part worth pinning. It covered exactly one of the three journeys: the
// campaign and automation grants are httpOnly, so client-side code cannot see
// them, and those two kept the bug while the fix looked complete. The check
// belongs on the server, which can see all three.
// ---------------------------------------------------------------------------

describe("the cart asks for the store's terms when an emailed shopper arrives", () => {
  it("the layout resolves the grant from the cookies the click trackers set", () => {
    expect(layout).toContain(`cookieStore.get(EMAIL_GRANT_COOKIE)`);
    expect(layout).toContain(`cookieStore.get(GUEST_GRANT_COOKIE)`);
  });

  it("and hands it to the provider beside signedIn", () => {
    expect(layout).toMatch(/<CartProvider signedIn=\{signedIn\} emailGrant=\{emailGrant\}>/);
  });

  it("the provider asks when either is true", () => {
    expect(cart).toContain("if (!signedIn && !emailGrant) return;");
  });

  it("and re-asks if either changes, so signing in mid-session repriced the cart", () => {
    expect(cart).toContain("}, [signedIn, emailGrant]);");
  });

  // THE REGRESSION THIS FILE EXISTS FOR. A browser-side cookie check cannot see
  // an httpOnly grant, so it silently covers one journey out of three.
  it("does not decide this by reading document.cookie", () => {
    // Narrow on purpose: cart-context reads document.cookie for other things
    // (the referral code among them) and always did. What must not come back is
    // deciding THIS from a cookie only one of the three journeys leaves behind.
    expect(cart).not.toContain("vl_cart_recovery=");
    expect(cart).not.toContain("recoveredVisit");
  });

  // Presence only. Validity is the endpoint's job, and it still answers 401 —
  // so the worst a forged cookie buys is one refused request, which the
  // response.ok guard already treats as the old no-op.
  it("gates asking, never trusting: the cookie names are the real ones", () => {
    expect(EMAIL_GRANT_COOKIE).toBe("vl_email_grant");
    expect(GUEST_GRANT_COOKIE).toBe("vl_cart_grant");
  });

  it("still refuses to act on a non-ok response", () => {
    expect(cart).toContain("if (!response.ok) return;");
  });
});

// ---------------------------------------------------------------------------
// THE DRAWER SHOWED A SIGNED-OUT WIN-BACK SHOPPER FULL SHIPPING AND NO GIFT.
//
// The same guard, one component along, with a sharper cost. The drawer asks
// /api/offer/status to learn whether this browser holds a gift; without an
// answer, useOfferQuote never arms and every figure is the un-gifted one. It
// returned early on `!signedIn` — excluding precisely the person the gift was
// minted for, who arrives from the email with a browse grant and no account.
//
// /cart never had the guard, so the page showed the gift while the drawer
// beside it did not. Two surfaces, one cart, different money.
// ---------------------------------------------------------------------------
describe("both cart surfaces ask whether this browser holds a gift", () => {
  it("the drawer asks when signed in OR carrying a grant", () => {
    expect(drawer).toContain("if (!signedIn && !emailGrant) return;");
  });

  it("and re-asks when either changes", () => {
    expect(drawer).toContain("}, [signedIn, emailGrant]);");
  });

  it("the /cart page asks unconditionally, as it always did", () => {
    const at = cartPage.indexOf('"/api/offer/status"');
    expect(at, "the cart page must still ask").toBeGreaterThan(-1);
    const effectStart = cartPage.lastIndexOf("useEffect(", at);
    expect(cartPage.slice(effectStart, at)).not.toContain("if (!signedIn) return;");
  });

  // The regression in one line: a guard that names signedIn and not emailGrant,
  // in front of the offer read, is the bug coming back.
  it("neither surface gates the offer read on signedIn alone", () => {
    for (const [label, source] of [["drawer", drawer], ["cart page", cartPage]] as const) {
      const at = source.indexOf('"/api/offer/status"');
      if (at < 0) continue;
      const effectStart = source.lastIndexOf("useEffect(", at);
      expect(source.slice(effectStart, at), `${label} gates the gift on an account`)
        .not.toContain("if (!signedIn) return;");
    }
  });

  it("the context carries the grant, so a component in the root layout can see it", () => {
    expect(cart).toContain("emailGrant: boolean;");
    expect(cart).toMatch(/signedIn,\s*\n\s*emailGrant,/);
  });
});
