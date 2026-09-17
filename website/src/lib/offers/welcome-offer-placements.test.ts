import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_CODE_OFFERS } from "@/lib/marketing/omnisend/codes";
import {
  WELCOME_OFFER_DAYS,
  WELCOME_OFFER_HEADLINE,
  WELCOME_OFFER_LINK_LABEL,
  WELCOME_OFFER_PERCENT,
  WELCOME_OFFER_SENTENCE,
  WELCOME_OFFER_TERMS,
} from "@/lib/offers/welcome-offer-copy";

// ---------------------------------------------------------------------------
// THE WELCOME OFFER SAYS THE SAME THING EVERYWHERE, AND IS EARNED BY TEXTS.
//
// The owner's brief on 2026-09-16: findable throughout the store, one wording,
// the home page left alone, no popups, never a condition of buying — and the
// offer attached to the SMS box rather than the email one, because the email
// list was already most of the account base and the SMS list was empty.
//
// These are the invariants that brief turns into. They are deliberately about
// wiring and wording, not rendering: what breaks silently here is a fifth
// surface describing the offer in its own words, or the discount quietly
// drifting back onto the email box.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const CATALOG = read("src/app/products/products-client.tsx");
const PRODUCT = read("src/components/product-detail-client.tsx");
const CART = read("src/app/cart/cart-client.tsx");
const CHECKOUT = read("src/app/checkout/page.tsx");
const SIGNUP = read("src/components/account-auth-form.tsx");
const COMPONENT = read("src/components/welcome-offer-signup.tsx");
const ROUTE = read("src/app/api/offers/welcome/route.ts");
const HOOKS = read("src/lib/marketing/omnisend/hooks.ts");
const SIGNUP_ROUTE = read("src/app/api/auth/signup/route.ts");

describe("one wording, and it matches the code the store actually mints", () => {
  it("is the owner's sentence, verbatim, with the terms travelling with the offer", () => {
    expect(WELCOME_OFFER_SENTENCE).toBe(
      "Subscribe to texts for 15% off your first order. Valid for 14 days. Cannot be combined with other offers.",
    );
    expect(WELCOME_OFFER_SENTENCE).toContain(WELCOME_OFFER_HEADLINE);
    expect(WELCOME_OFFER_SENTENCE).toContain(WELCOME_OFFER_TERMS);
  });

  it("promises exactly what codes.ts mints, so no surface can advertise a discount the till will not give", () => {
    expect(WELCOME_OFFER_PERCENT).toBe(CONTACT_CODE_OFFERS.welcome.percent);
    expect(WELCOME_OFFER_DAYS * 24).toBe(CONTACT_CODE_OFFERS.welcome.ttlHours);
  });

  it("says texts, never emails: the discount is what buys the channel the store does not have", () => {
    for (const line of [WELCOME_OFFER_SENTENCE, WELCOME_OFFER_HEADLINE, WELCOME_OFFER_LINK_LABEL]) {
      expect(line).toContain("texts");
      expect(line).not.toMatch(/\bemails?\b/i);
    }
  });

  // THE BUG THIS PAIR EXISTS FOR.
  //
  // The sentence was two template literals added together. Vitest saw the
  // right string, the dev server rendered the right string, and the minified
  // bundle shipped "Subscribe to texts for 15Valid for 14 days." — the folder
  // dropped the first template's trailing quasi, which happened to be the
  // whole offer. It only bites when every substitution is a compile-time
  // constant, which is exactly what a copy module is made of.
  it("composes the sentence from two already-folded halves rather than a template pair", () => {
    const copy = read("src/lib/offers/welcome-offer-copy.ts");
    expect(copy).toContain('export const WELCOME_OFFER_SENTENCE = WELCOME_OFFER_HEADLINE + " " + WELCOME_OFFER_TERMS;');
    expect(copy).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*`\s*\n\s*\+\s*`/);
  });

  it("survives minification: the built client bundle carries the sentence whole", () => {
    // Only meaningful against a real build (CI, or a local `npm run build`).
    // Skipped rather than failed when there is none, so the suite still runs
    // on a clean checkout.
    let chunks: string[];
    try {
      chunks = readdirSync(new URL("../../../.next/static/chunks", import.meta.url));
    } catch {
      return;
    }
    const bundle = chunks
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(new URL(`../../../.next/static/chunks/${name}`, import.meta.url), "utf8"))
      .join("\n");
    if (!bundle.includes("Subscribe to texts for")) return;
    // Each half has to survive folding WHOLE. The joined sentence is built at
    // runtime from the two identifiers, so it is deliberately not looked for
    // as a literal — what the bug destroyed was the headline's tail, and that
    // is what is checked. Booleans rather than toContain: a failed toContain
    // prints the entire bundle.
    expect(bundle.includes(WELCOME_OFFER_HEADLINE)).toBe(true);
    expect(bundle.includes(WELCOME_OFFER_TERMS)).toBe(true);
    expect(bundle.includes("Subscribe to texts for 15Valid")).toBe(false);
  });

  it("keeps the house voice: no emoji, no exclamation marks", () => {
    const copy = [WELCOME_OFFER_SENTENCE, WELCOME_OFFER_HEADLINE, WELCOME_OFFER_LINK_LABEL, WELCOME_OFFER_TERMS].join(" ");
    expect(copy).not.toMatch(/!/);
    expect(copy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("every placement the owner asked for, and no others", () => {
  it("puts the bar on the catalogue, the link on a product page and the card in the cart", () => {
    expect(CATALOG).toContain('<WelcomeOfferSignup variant="bar" />');
    expect(PRODUCT).toContain('<WelcomeOfferSignup variant="link" />');
    expect(CART).toContain('<WelcomeOfferSignup variant="card" />');
  });

  it("explains the offer beside the sign-up page's SMS box, in the shared wording", () => {
    expect(SIGNUP).toContain('import { WELCOME_OFFER_SENTENCE } from "@/lib/offers/welcome-offer-copy";');
    expect(SIGNUP).toContain("{WELCOME_OFFER_SENTENCE}");
    // Beside the SMS box, not the email one: the discount rides with the
    // consent that earns it.
    expect(SIGNUP.indexOf('data-testid="signup-welcome-offer"')).toBeGreaterThan(SIGNUP.indexOf('data-testid="signup-marketing-opt-in"'));
    expect(SIGNUP.indexOf('data-testid="signup-welcome-offer"')).toBeLessThan(SIGNUP.indexOf('data-testid="signup-sms-opt-in"'));
  });

  it("leaves the home page alone", () => {
    const home = read("src/app/page.tsx");
    expect(home).not.toContain("WelcomeOfferSignup");
    expect(home).not.toContain("welcome-offer-copy");
  });

  it("never opens a dialog for it, anywhere", () => {
    // Inline disclosure only. A popup here would collide with the Omnisend
    // pop-up on the catalogue and sit over a checkout, which is the one place
    // the owner ruled it out outright.
    for (const source of [COMPONENT, CHECKOUT]) {
      expect(source).not.toMatch(/role="dialog"/);
      expect(source).not.toMatch(/aria-modal/);
    }
    expect(COMPONENT).toContain("aria-expanded");
  });
});

describe("the checkout applies it in place", () => {
  it("claims and applies without a reload, from the box that earns it", () => {
    expect(CHECKOUT).toContain('body: JSON.stringify({ phone, email: address, placement: "checkout" })');
    expect(CHECKOUT).toContain("if (!couponCode) applyCouponCode(data.code);");
    // Nothing navigates: the shopper's address, card fields and shipping
    // choice all survive, which is the whole point of doing it this way.
    const claim = CHECKOUT.slice(CHECKOUT.indexOf("THE TICK THAT EARNS IT"), CHECKOUT.indexOf("Fire begin_checkout"));
    expect(claim).not.toContain("location.reload");
    expect(claim).not.toContain("router.push");
  });

  it("stops asking once the code is on the order, and explains rather than fights a better discount", () => {
    expect(CHECKOUT).toContain("{WELCOME_OFFER_APPLIED}");
    expect(CHECKOUT).toContain("{WELCOME_OFFER_HELD_BY_BETTER}");
    // controlsPrice is the quote's own answer to "is this code what is
    // reducing the total", so the applied message can never outrun the money.
    expect(CHECKOUT).toContain("couponOutcome?.controlsPrice");
  });

  it("never overwrites a code the shopper typed themselves", () => {
    expect(CHECKOUT).toContain("if (couponCode) return;");
  });
});

describe("one eligibility and one code system behind all of it", () => {
  it("mints only through ensureContactCode, which re-offers a live code rather than dating a new one", () => {
    const service = read("src/lib/offers/welcome-offer.ts");
    expect(service).toContain('ensureContactCode("welcome", address)');
    expect(service).not.toContain('.from("coupons").insert');
    expect(service).not.toContain("ttlHours");
  });

  it("hides the offer from anyone who has already bought", () => {
    const service = read("src/lib/offers/welcome-offer.ts");
    expect(service).toContain("hasPurchased");
    expect(service).toContain('status: "ineligible"');
  });

  it("no longer mints on the email opt-in path", () => {
    expect(HOOKS).not.toContain("ensureContactCode");
  });

  it("mints on the SMS consent path instead", () => {
    expect(SIGNUP_ROUTE).toContain("await grantWelcomeOfferForConsent(input.email);");
    expect(read("src/app/api/account/preferences/route.ts")).toContain("await grantWelcomeOfferForConsent(address);");
    expect(read("src/lib/marketing/omnisend/reconcile.ts")).toContain("await grantWelcomeOfferForConsent(subscriber.email);");
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
