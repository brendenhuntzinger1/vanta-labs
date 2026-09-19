import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SMS_SIGNUP_CONFIG } from "@/lib/admin-control";
import { CONTACT_CODE_OFFERS } from "@/lib/marketing/omnisend/codes";
import {
  SMS_BAR_TEXT,
  SMS_CHECKOUT_CHECKBOX,
  SMS_INVITE_BODY,
  SMS_INVITE_BUTTON,
  SMS_INVITE_FIELD_LABEL,
  SMS_INVITE_HEADLINE,
  SMS_PRODUCT_LINK,
  WELCOME_OFFER_APPLIED,
  WELCOME_OFFER_DAYS,
  WELCOME_OFFER_HELD_BY_BETTER,
  WELCOME_OFFER_PERCENT,
  WELCOME_OFFER_TERMS,
} from "@/lib/offers/welcome-offer-copy";

// ---------------------------------------------------------------------------
// ONE TEXT-LIST SIGN-UP, SAID THE SAME WAY EVERYWHERE.
//
// The owner's brief was: SMS is the priority and the 15% first-order offer is
// its incentive. The second half of that is retired. On 2026-09-18 the welcome
// code stopped minting at both call sites and the spin-to-win wheel took its
// place as the store's acquisition offer, so what is left here is the text list
// asked for on its own terms: quiet opportunities while shopping, an inline box
// at the checkout, and the homepage left alone.
//
// These are the invariants that turns into, and most of them are now about what
// is NOT said. What breaks silently is a surface still advertising the retired
// discount, an incentive shown to somebody who cannot have it, or a prompt that
// ignores the kill switch.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const CATALOG = read("src/app/products/products-client.tsx");
const PRODUCT = read("src/components/product-detail-client.tsx");
const CART = read("src/app/cart/cart-client.tsx");
const CHECKOUT = read("src/app/checkout/page.tsx");
const SIGNUP = read("src/components/account-auth-form.tsx");
const COMPONENT = read("src/components/welcome-offer-signup.tsx");
const COPY = read("src/lib/offers/welcome-offer-copy.ts");
const LAYOUT = read("src/app/layout.tsx");
const ROUTE = read("src/app/api/offers/welcome/route.ts");
const SERVICE = read("src/lib/offers/welcome-offer.ts");
const HOOKS = read("src/lib/marketing/omnisend/hooks.ts");

describe("one wording, matching the code the store actually mints", () => {
  it("asks for the list on its own terms, with no discount attached", () => {
    expect(SMS_INVITE_BODY).toBe(
      "Join Vanta Labs texts for exclusive sales, restock alerts, giveaways, and free product offers.",
    );
    expect(SMS_INVITE_FIELD_LABEL).toBe("Mobile number");
    // The headline and the button used to name the retired discount.
    for (const line of [SMS_INVITE_HEADLINE, SMS_INVITE_BUTTON, SMS_BAR_TEXT, SMS_PRODUCT_LINK]) {
      expect(line, `"${line}" still sells a discount nothing mints`).not.toMatch(/\d+%|off your first order/i);
    }
  });

  it("no longer offers anything the module cannot mint", () => {
    // Each of these named the retired welcome code on a surface that is an
    // OFFER rather than a record of one somebody already holds.
    for (const gone of ["SMS_CHECKOUT_INCENTIVE", "SMS_CHECKOUT_NEEDS_PHONE", "WELCOME_OFFER_SENTENCE", "SMS_RETURNING_INVITE"]) {
      expect(COPY, `${gone} is back`).not.toContain(`export const ${gone}`);
    }
  });

  it("states the terms only where a code actually exists", () => {
    expect(WELCOME_OFFER_TERMS).toBe("First order only. Valid for 14 days. Cannot be combined with other offers.");
    // THE FORM MINTS NOTHING NOW, so printing the retired code's three
    // restrictions over it would describe a deal the shopper is not being
    // given. They survive for the holder's own card and the checkout.
    const form = COMPONENT.slice(
      COMPONENT.indexOf("export function SmsSignupForm"),
      COMPONENT.indexOf("export function WelcomeCodeCard"),
    );
    expect(form).not.toContain("WELCOME_OFFER_TERMS");
    expect(COMPONENT.slice(COMPONENT.indexOf("export function WelcomeCodeCard"))).toContain("WELCOME_OFFER_TERMS");
  });

  it("promises exactly what the minter mints", () => {
    expect(WELCOME_OFFER_PERCENT).toBe(CONTACT_CODE_OFFERS.welcome.percent);
    expect(WELCOME_OFFER_DAYS * 24).toBe(CONTACT_CODE_OFFERS.welcome.ttlHours);
  });

  it("keeps the checkout's consent wording and drops the discount beside it", () => {
    // The box survives the retirement unchanged — it is a consent control, and
    // the words in it never named a discount. What goes is the line that sat
    // next to it selling one.
    expect(SMS_CHECKOUT_CHECKBOX).toBe(
      "Text me about free product offers, exclusive sales, giveaways, and restock alerts.",
    );
    expect(CHECKOUT).toContain("{SMS_CHECKOUT_CHECKBOX}");
    expect(CHECKOUT, "no discount is offered for ticking the box").not.toContain("SMS_CHECKOUT_INCENTIVE");
    expect(CHECKOUT).not.toContain("SMS_CHECKOUT_NEEDS_PHONE");
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
    for (const line of [SMS_INVITE_BODY, SMS_BAR_TEXT, SMS_PRODUCT_LINK, SMS_CHECKOUT_CHECKBOX]) {
      expect(line).not.toMatch(/\bemails?\b/i);
    }
  });

  it("keeps the house voice: no emoji, no exclamation marks", () => {
    const copy = [
      SMS_INVITE_HEADLINE, SMS_INVITE_BODY, SMS_INVITE_BUTTON, SMS_BAR_TEXT, SMS_PRODUCT_LINK,
      SMS_CHECKOUT_CHECKBOX, WELCOME_OFFER_TERMS, WELCOME_OFFER_APPLIED,
      WELCOME_OFFER_HELD_BY_BETTER,
    ].join(" ");
    expect(copy).not.toMatch(/!/);
    expect(copy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("every placement the owner asked for, and no others", () => {
  it("mounts the link and the card, and NOT a bar on the catalogue", () => {
    // THE CATALOGUE BAR IS GONE, at the owner's direction, and the reason is
    // how many asks there were rather than anything wrong with that one. The
    // same invitation to join the text list appears in the wheel card, under
    // the purchase controls on a product page, in the cart, at checkout, on
    // the sign-up form, on /sms and in account settings — a shopper walking
    // the catalogue met it twice before reaching a product.
    //
    // The wheel invitation is the one kept on that page, because it offers
    // something in exchange. A bar that only asks is the one to drop.
    expect(CATALOG, "the catalogue bar is back").not.toContain("WelcomeOfferSignup");
    expect(PRODUCT).toContain('<WelcomeOfferSignup variant="link" />');
    expect(CART).toContain('<WelcomeOfferSignup variant="card" />');
  });

  it("mounts exactly one invitation modal, beside the promotions card", () => {
    expect(LAYOUT).toContain("<EntryOfferModal />");
    expect(LAYOUT.indexOf("<EntryOfferModal />")).toBeGreaterThan(LAYOUT.indexOf("<StorefrontOfferModal"));
  });

  it("offers nothing for the tick on the one opt-in a carrier can load", () => {
    // /account/login carried a gold line reading "Get 15% off your first
    // order. First order only. Valid for 14 days." between the email box and
    // the SMS one. Nothing mints that code any more, so on the single opt-in
    // screen an A2P review can actually reach it had become an advertisement
    // for something the till refuses. It is removed rather than reworded.
    expect(SIGNUP).not.toContain('data-testid="signup-welcome-offer"');
    expect(SIGNUP).not.toContain("WELCOME_OFFER_SENTENCE");
  });

  it("changes nothing else about that screen's consent", () => {
    // The wording the carrier review saw, its version, the unticked boxes and
    // both legal links are not ours to edit.
    expect(SIGNUP).toContain("{SMS_CONSENT_TEXT}");
    expect(SIGNUP).toContain("{SMS_DISCLOSURE_TEXT}");
    expect(SIGNUP).toContain('data-testid="signup-sms-opt-in"');
    expect(SIGNUP).toContain('data-testid="signup-marketing-opt-in"');
    expect(SIGNUP).toContain("/legal/terms");
    expect(SIGNUP).toContain("/legal/privacy");
    expect(SIGNUP).toMatch(/const \[smsOptIn, setSmsOptIn\] = useState\(false\)/);
  });

  it("leaves the home page alone", () => {
    const home = read("src/app/page.tsx");
    expect(home).not.toContain("WelcomeOfferSignup");
    expect(home).not.toContain("EntryOfferModal");
  });

  it("never puts a dialog on the quiet placements or the checkout", () => {
    for (const source of [COMPONENT, CHECKOUT]) {
      expect(source).not.toMatch(/role="dialog"/);
      expect(source).not.toMatch(/aria-modal/);
    }
    expect(COMPONENT).toContain("aria-expanded");
  });
});

describe("the older invitation is gone, not merely unmounted", () => {
  it("leaves no second card asking the same question", () => {
    // sms-invite-modal.tsx was stood down when the entry card replaced it and
    // then sat in the tree for a fortnight, mounted nowhere, still importing
    // the retired discount's copy — so every constant it named looked live to
    // anyone grepping for consumers before deleting one.
    expect(existsSync(join("src", "components", "sms-invite-modal.tsx"))).toBe(false);
    expect(LAYOUT).not.toContain("<SmsInviteModal />");
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
    // The checkout no longer consults the switch at all: it gated a discount
    // that no longer exists, and the panel that remains is for a customer who
    // already holds a code rather than an offer to anybody.
    expect(CHECKOUT).not.toContain("welcomePromptsEnabled");
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
    // NARROWER THAN AN ALLOW-LIST NOW. The panel renders for exactly one
    // state — a customer who holds a code — so a buyer, a returning shopper
    // and an unknown guest are all silent without needing to be named.
    const panel = CHECKOUT.slice(CHECKOUT.indexOf("ONLY FOR SOMEONE WHO ALREADY HOLDS A CODE"));
    expect(panel).toContain('welcomeStatus === "claimed" ?');
    expect(panel.slice(0, 900)).not.toContain('"returning"');
    expect(panel.slice(0, 900)).not.toContain('"eligible"');
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

  it("still auto-applies a code the customer already holds, without overwriting a typed one", () => {
    // Nothing new is minted, but a holder's code is still dropped into an
    // EMPTY coupon slot so they do not have to remember six characters.
    expect(CHECKOUT).toContain("if (couponCode) return;");
    expect(CHECKOUT).toContain("applyCouponCode(welcomeCode);");
  });

  it("records the consent at the checkout without minting anything", () => {
    const tick = CHECKOUT.slice(
      CHECKOUT.indexOf("THE TICK, WHICH NOW EARNS NOTHING BUT THE SUBSCRIPTION"),
      CHECKOUT.indexOf("Fire begin_checkout"),
    );
    expect(tick, "the consent still reaches the ledger").toContain('"/api/offers/welcome"');
    expect(tick, "and nothing reads a code back").not.toContain("data.code");
    expect(tick).not.toContain("applyCouponCode");
    expect(tick).not.toContain("location.reload");
    expect(tick).not.toContain("router.push");
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
    expect(CHECKOUT).toContain("otherDiscountWins ?");
    expect(CHECKOUT).toContain('data-testid="checkout-welcome-ready"');
  });

  it("still answers for a guest at the checkout, who has no session to judge by", () => {
    expect(ROUTE).toContain('if (!email) return NextResponse.json({ status: "unknown"');
    // The checkout no longer shows a guest anything — there is no offer to
    // make them — but the endpoint must still answer rather than error.
    expect(COMPONENT).toContain('offer.status === "unknown"');
  });
});

describe("the copy survives minification", () => {
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
    // THE SHAPE THAT SHIPPED A BROKEN SENTENCE ONCE. A pair of template
    // literals added together, with only compile-time constants inside them,
    // folds in the minifier and loses the first one's tail — the bundle
    // shipped "Get 15Valid for 14 days." The source-level scan in
    // constant-template-folding.test.ts is what actually runs in CI, since
    // there are no chunks there; this is the belt to its braces.
    if (!bundle.includes("Vanta Labs texts")) return;
    expect(bundle.includes(SMS_INVITE_BODY)).toBe(true);
    expect(bundle.includes(WELCOME_OFFER_TERMS)).toBe(true);
  });
});

describe("the holdout, so the offer can be priced honestly", () => {
  it("holds nobody back by default", async () => {
    const { isHeldOut } = await import("@/lib/offers/welcome-offer-holdout");
    expect(DEFAULT_SMS_SIGNUP_CONFIG.holdoutPercent).toBe(0);
    for (const address of ["a@x.test", "b@x.test", "c@x.test"]) {
      expect(isHeldOut(address, 0)).toBe(false);
    }
  });

  it("is stable for an address, so nobody's experience flickers", async () => {
    const { holdoutBucket } = await import("@/lib/offers/welcome-offer-holdout");
    const first = holdoutBucket("Someone@Example.test");
    expect(holdoutBucket("someone@example.test")).toBe(first);
    expect(holdoutBucket("  someone@example.test  ")).toBe(first);
  });

  it("splits roughly at the percentage asked for", async () => {
    const { isHeldOut } = await import("@/lib/offers/welcome-offer-holdout");
    const people = Array.from({ length: 2000 }, (_, i) => `person${i}@example.test`);
    const held = people.filter((address) => isHeldOut(address, 10)).length;
    // 10% of 2000 is 200. A hash is not a shuffle, so this is a sanity band.
    expect(held).toBeGreaterThan(140);
    expect(held).toBeLessThan(260);
  });

  it("suppresses every prompt for a held-back shopper", () => {
    expect(SERVICE).toContain("if (isHeldOut(address, config.holdoutPercent)) return { status: \"suppressed\", mayInterrupt: false };");
  });

  // The analysis has to be able to reproduce the split months later, in SQL,
  // without this code. MD5 is used for exactly that reason.
  it("documents the SQL that reproduces the same split", async () => {
    const holdout = read("src/lib/offers/welcome-offer-holdout.ts");
    expect(holdout).toContain("substr(md5(lower(");
    expect(read("docs/omnisend/DEPLOY.md")).toContain("substr(md5(lower(customer_email))");
  });
});

describe("the consent ledger is the one production actually has", () => {
  it("writes phone_e164, not an invented email key", async () => {
    const consent = read("src/lib/sms-consent.ts");
    expect(consent).toContain("phone_e164: phone");
    expect(consent).toContain('onConflict: "phone_e164"');
    expect(consent).toContain("disclosure_version: SMS_DISCLOSURE_VERSION");
    // Code only: the header explains the old shape by naming the column it
    // used to write, so the prose must not fail its own lesson.
    const code = consent.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*")).join("\n");
    expect(code).not.toContain("consent_text");
  });

  it("stops every live number for an address, not one row", async () => {
    const consent = read("src/lib/sms-consent.ts");
    expect(consent).toContain('.in("phone_e164", live.map((row) => row.phone_e164))');
    expect(consent).toContain('opt_out_keyword: keyword');
  });

  it("records a resubscribe as a resubscribe", async () => {
    const consent = read("src/lib/sms-consent.ts");
    expect(consent).toContain("row.resubscribed_at = now;");
    expect(consent).toContain("row.resubscribe_count = Number(existing?.resubscribe_count ?? 0) + 1;");
  });

  it("makes an untick reach the ledger even when the account mirror says nothing", () => {
    const prefs = read("src/app/api/account/preferences/route.ts");
    expect(prefs).toContain("if (!body.smsMarketing) {");
    expect(prefs).toContain("await recordSmsOptOut(stopAddress, now);");
  });

  it("shows an account holder the subscription the ledger knows about", () => {
    const page = read("src/app/account/(dashboard)/settings/page.tsx");
    expect(page).toContain("readSmsSubscriptionForAccount");
    expect(page).toContain("smsStanding.subscribed && !preferences.smsMarketing");
  });
});
