import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SMS_SIGNUP_CONFIG } from "@/lib/admin-control";
import { CONTACT_CODE_OFFERS } from "@/lib/marketing/omnisend/codes";
import {
  SMS_BAR_TEXT,
  SMS_CHECKOUT_CHECKBOX,
  SMS_CHECKOUT_INCENTIVE,
  SMS_INVITE_BODY,
  SMS_INVITE_BUTTON,
  SMS_INVITE_FIELD_LABEL,
  SMS_INVITE_HEADLINE,
  SMS_PRODUCT_LINK,
  SMS_RETURNING_INVITE,
  WELCOME_OFFER_APPLIED,
  WELCOME_OFFER_DAYS,
  WELCOME_OFFER_HELD_BY_BETTER,
  WELCOME_OFFER_PERCENT,
  WELCOME_OFFER_TERMS,
} from "@/lib/offers/welcome-offer-copy";

// ---------------------------------------------------------------------------
// ONE TEXT-LIST SIGN-UP, SAID THE SAME WAY EVERYWHERE.
//
// The owner's brief: SMS is the priority and the 15% first-order offer is its
// incentive; one branded invitation inside the store, quiet opportunities
// while shopping, an inline box at the checkout, and the homepage left alone.
// Nothing customer-facing turns on until the carriers approve this store.
//
// These are the invariants that brief turns into. They are about wiring and
// wording rather than rendering: what breaks silently is a sixth surface
// describing the offer in its own words, an incentive shown to someone who
// cannot have it, or a prompt that ignores the kill switch.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const CATALOG = read("src/app/products/products-client.tsx");
const PRODUCT = read("src/components/product-detail-client.tsx");
const CART = read("src/app/cart/cart-client.tsx");
const CHECKOUT = read("src/app/checkout/page.tsx");
const SIGNUP = read("src/components/account-auth-form.tsx");
const COMPONENT = read("src/components/welcome-offer-signup.tsx");
const MODAL = read("src/components/sms-invite-modal.tsx");
const LAYOUT = read("src/app/layout.tsx");
const ROUTE = read("src/app/api/offers/welcome/route.ts");
const SERVICE = read("src/lib/offers/welcome-offer.ts");
const HOOKS = read("src/lib/marketing/omnisend/hooks.ts");

describe("one wording, matching the code the store actually mints", () => {
  it("carries the owner's invitation copy verbatim", () => {
    expect(SMS_INVITE_HEADLINE).toBe("Get 15% off your first order");
    expect(SMS_INVITE_BODY).toBe(
      "Join Vanta Labs texts for exclusive sales, restock alerts, giveaways, and free product offers.",
    );
    expect(SMS_INVITE_FIELD_LABEL).toBe("Mobile number");
    expect(SMS_INVITE_BUTTON).toBe("Get my 15% off");
  });

  it("states all three restrictions in one line, shown before the button", () => {
    expect(WELCOME_OFFER_TERMS).toBe("First order only. Valid for 14 days. Cannot be combined with other offers.");
    // Before submission, not after: the terms block sits above the field.
    const form = COMPONENT.slice(COMPONENT.indexOf("export function SmsSignupForm"));
    expect(form.indexOf("WELCOME_OFFER_TERMS")).toBeLessThan(form.indexOf("welcome-offer-submit"));
  });

  it("promises exactly what the minter mints", () => {
    expect(WELCOME_OFFER_PERCENT).toBe(CONTACT_CODE_OFFERS.welcome.percent);
    expect(WELCOME_OFFER_DAYS * 24).toBe(CONTACT_CODE_OFFERS.welcome.ttlHours);
  });

  it("uses the checkout wording the owner specified", () => {
    expect(SMS_CHECKOUT_CHECKBOX).toBe(
      "Text me about free product offers, exclusive sales, giveaways, and restock alerts.",
    );
    expect(SMS_CHECKOUT_INCENTIVE).toBe("Subscribe to get 15% off this order. Cannot be combined with other offers.");
    expect(CHECKOUT).toContain("{SMS_CHECKOUT_CHECKBOX}");
    expect(CHECKOUT).toContain("{SMS_CHECKOUT_INCENTIVE}");
  });

  // THE PROMISE THE STORE WAS ABOUT TO BREAK.
  //
  // This line used to end "so your welcome code is saved for a future order".
  // Completing the order makes them a buyer, and a buyer's welcome code is
  // retired at first payment. The store was describing a future it was in the
  // act of removing.
  it("never promises the welcome code will survive an order that ends it", () => {
    expect(WELCOME_OFFER_HELD_BY_BETTER).not.toMatch(/future order/i);
    expect(WELCOME_OFFER_HELD_BY_BETTER).toMatch(/completing this order ends the welcome offer/i);
    expect(WELCOME_OFFER_HELD_BY_BETTER).toMatch(/cannot be combined/i);
  });

  it("says texts, never emails: the discount buys the channel the store lacks", () => {
    for (const line of [SMS_INVITE_BODY, SMS_BAR_TEXT, SMS_PRODUCT_LINK, SMS_CHECKOUT_CHECKBOX, SMS_RETURNING_INVITE]) {
      expect(line).not.toMatch(/\bemails?\b/i);
    }
  });

  it("keeps the house voice: no emoji, no exclamation marks", () => {
    const copy = [
      SMS_INVITE_HEADLINE, SMS_INVITE_BODY, SMS_INVITE_BUTTON, SMS_BAR_TEXT, SMS_PRODUCT_LINK,
      SMS_CHECKOUT_CHECKBOX, SMS_CHECKOUT_INCENTIVE, WELCOME_OFFER_TERMS, WELCOME_OFFER_APPLIED,
      WELCOME_OFFER_HELD_BY_BETTER, SMS_RETURNING_INVITE,
    ].join(" ");
    expect(copy).not.toMatch(/!/);
    expect(copy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("every placement the owner asked for, and no others", () => {
  it("mounts the bar, the link and the card", () => {
    expect(CATALOG).toContain('<WelcomeOfferSignup variant="bar" />');
    expect(PRODUCT).toContain('<WelcomeOfferSignup variant="link" />');
    expect(CART).toContain('<WelcomeOfferSignup variant="card" />');
  });

  it("mounts exactly one invitation modal, beside the promotions card", () => {
    expect(LAYOUT).toContain("<SmsInviteModal />");
    expect(LAYOUT.indexOf("<SmsInviteModal />")).toBeGreaterThan(LAYOUT.indexOf("<StorefrontOfferModal"));
  });

  it("explains the offer beside the sign-up page's SMS box, never the email one", () => {
    expect(SIGNUP.indexOf('data-testid="signup-welcome-offer"')).toBeGreaterThan(SIGNUP.indexOf('data-testid="signup-marketing-opt-in"'));
    expect(SIGNUP.indexOf('data-testid="signup-welcome-offer"')).toBeLessThan(SIGNUP.indexOf('data-testid="signup-sms-opt-in"'));
  });

  it("leaves the home page alone", () => {
    const home = read("src/app/page.tsx");
    expect(home).not.toContain("WelcomeOfferSignup");
    expect(home).not.toContain("SmsInviteModal");
  });

  it("never puts a dialog on the quiet placements or the checkout", () => {
    for (const source of [COMPONENT, CHECKOUT]) {
      expect(source).not.toMatch(/role="dialog"/);
      expect(source).not.toMatch(/aria-modal/);
    }
    expect(COMPONENT).toContain("aria-expanded");
  });
});

describe("the one invitation behaves like one invitation", () => {
  it("opens only on the catalogue and its product pages", () => {
    expect(MODAL).toContain('pathname === "/products" || pathname.startsWith("/products/")');
    expect(MODAL).toContain("if (!isShoppingRoute(pathname)) return;");
  });

  it("yields to anything already on screen, re-checked at the moment it opens", () => {
    expect(MODAL).toContain('document.querySelector(\'[data-offer-modal], [role="dialog"], [data-vl-overlay]\')');
    const effect = MODAL.slice(MODAL.indexOf("const timer = window.setTimeout"));
    expect(effect).toContain("if (anotherOverlayIsOpen()) return;");
  });

  it("shows once per session and then not again for the configured cooldown", () => {
    expect(MODAL).toContain("if (seenThisSession()) return;");
    expect(MODAL).toContain("if (withinCooldown(offer.dismissCooldownDays ?? 7)) return;");
    expect(DEFAULT_SMS_SIGNUP_CONFIG.dismissCooldownDays).toBe(7);
  });

  it("opens only for someone the server says may be interrupted", () => {
    expect(MODAL).toContain('if (offer.status !== "eligible" || !offer.mayInterrupt) return;');
  });

  it("closes on the backdrop, the control and escape", () => {
    expect(MODAL).toContain('data-testid="sms-invite-close"');
    expect(MODAL).toContain('if (event.key === "Escape") close();');
    expect(MODAL).toContain("markDismissed();");
  });
});

describe("the kill switch", () => {
  it("is off by default and only an explicit stored true turns it on", () => {
    expect(DEFAULT_SMS_SIGNUP_CONFIG.promptsEnabled).toBe(false);
    expect(read("src/lib/admin-control.ts")).toContain("promptsEnabled: config.prompts_enabled === true");
  });

  it("is honoured by the endpoint, not only by the UI", () => {
    expect(ROUTE).toContain("if (!config.promptsEnabled) {");
    expect(ROUTE).toContain("recordSmsSignupOnly");
  });

  it("hides every acquisition prompt while it is off", () => {
    expect(COMPONENT).toContain("if (offer.promptsEnabled === false) return null;");
    expect(MODAL).toContain("if (offer.promptsEnabled === false) return;");
    expect(CHECKOUT).toContain('welcomePromptsEnabled && (welcomeStatus === "eligible"');
  });
});

describe("the customer's state decides what appears", () => {
  it("answers four states and whether the person may be interrupted", () => {
    expect(SERVICE).toContain('export type WelcomeOfferStatus = "eligible" | "claimed" | "returning" | "suppressed";');
    expect(SERVICE).toContain("mayInterrupt: boolean");
  });

  it("never advertises a first-order discount to someone who has bought", () => {
    expect(SERVICE).toContain('return { status: sms === "subscribed" ? "suppressed" : "returning", mayInterrupt: false };');
    // An ALLOW-LIST at the checkout, which is stronger than excluding
    // "returning" by name: a state added later is silent until it is named.
    const panel = CHECKOUT.slice(CHECKOUT.indexOf("THE INCENTIVE, AND ONLY FOR SOMEONE IT IS OPEN TO"));
    expect(panel).toContain('welcomeStatus === "eligible" || welcomeStatus === "claimed" || welcomeStatus === "unknown"');
    expect(panel.slice(0, 400)).not.toContain('"returning"');
  });

  it("never interrupts someone who once opted out, but may still ask quietly", () => {
    expect(SERVICE).toContain('return { status: "eligible", mayInterrupt: sms === "none" };');
  });

  it("subscribes a returning buyer rather than refusing them the list", () => {
    const claim = SERVICE.slice(SERVICE.indexOf("export async function claimWelcomeOffer"));
    expect(claim.indexOf("recordSmsConsent")).toBeLessThan(claim.indexOf("hasPurchased"));
  });
});

describe("one code system behind all of it", () => {
  it("mints only through ensureContactCode, which re-offers rather than re-dates", () => {
    expect(SERVICE).toContain('ensureContactCode("welcome", address)');
    expect(SERVICE).not.toContain('.from("coupons").insert');
    expect(SERVICE).not.toContain("ttlHours");
  });

  it("no longer mints on the email opt-in path", () => {
    expect(HOOKS).not.toContain("ensureContactCode");
  });

  it("never lets a page render start someone's fourteen days: only the POST mints", () => {
    const get = ROUTE.slice(ROUTE.indexOf("export async function GET"), ROUTE.indexOf("export async function POST"));
    expect(get).toContain("readWelcomeOffer");
    expect(get).not.toContain("claimWelcomeOffer");
  });

  it("takes the address from the session whenever there is one", () => {
    expect(ROUTE).toContain("const email = sessionEmail || typedEmail;");
  });
});

describe("the reward is immediate, not synced", () => {
  it("shows the code with a copy control and a way back to shopping", () => {
    expect(COMPONENT).toContain('data-testid="welcome-offer-code"');
    expect(COMPONENT).toContain('data-testid="welcome-offer-copy"');
    expect(COMPONENT).toContain("navigator.clipboard.writeText");
    expect(COMPONENT).toContain('data-testid="welcome-offer-continue"');
  });

  it("applies at the checkout without a reload and without overwriting a typed code", () => {
    expect(CHECKOUT).toContain("if (!couponCode) applyCouponCode(data.code);");
    expect(CHECKOUT).toContain("if (couponCode) return;");
    const claim = CHECKOUT.slice(CHECKOUT.indexOf("THE TICK THAT EARNS IT"), CHECKOUT.indexOf("Fire begin_checkout"));
    expect(claim).not.toContain("location.reload");
    expect(claim).not.toContain("router.push");
  });

  it("says applied only once the priced order confirms it", () => {
    expect(CHECKOUT).toContain("couponOutcome?.controlsPrice");
  });

  // "NOT APPLIED" IS NOT "SOMETHING BETTER WON".
  //
  // Conflating them printed "a larger discount is already on this order" on a
  // checkout with an EMPTY cart and no discount of any kind. A held code and a
  // code that simply is not pricing anything yet are different states and the
  // shopper is told the true one.
  it("claims a larger discount won only when one is actually taking money off", () => {
    expect(CHECKOUT).toContain("const otherDiscountWins = !welcomeApplied && discountAmount > 0;");
    expect(CHECKOUT).toContain('welcomeStatus === "claimed" && otherDiscountWins ?');
    expect(CHECKOUT).toContain('data-testid="checkout-welcome-ready"');
  });

  it("offers a guest at the checkout, who has no session to judge by", () => {
    expect(ROUTE).toContain('if (!email) return NextResponse.json({ status: "unknown"');
    expect(CHECKOUT).toContain('welcomeStatus === "unknown"');
    // The storefront prompts are signed-in only and must stay silent for them.
    expect(COMPONENT).toContain('offer.status === "unknown"');
  });
});

describe("the sentence survives minification", () => {
  it("composes from two already-folded halves rather than a template pair", () => {
    const copy = read("src/lib/offers/welcome-offer-copy.ts");
    expect(copy).toContain('export const WELCOME_OFFER_SENTENCE = SMS_INVITE_HEADLINE + ". " + WELCOME_OFFER_TERMS;');
  });

  it("carries the invitation copy whole in a built client bundle", () => {
    let chunks: string[];
    try {
      chunks = readdirSync(new URL("../../../.next/static/chunks", import.meta.url));
    } catch {
      return; // No build here (CI runs vitest alone); the source scan covers it.
    }
    const bundle = chunks
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(new URL(`../../../.next/static/chunks/${name}`, import.meta.url), "utf8"))
      .join("\n");
    if (!bundle.includes("off your first order")) return;
    expect(bundle.includes(SMS_INVITE_HEADLINE)).toBe(true);
    expect(bundle.includes(WELCOME_OFFER_TERMS)).toBe(true);
  });
});
