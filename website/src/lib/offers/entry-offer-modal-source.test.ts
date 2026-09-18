import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";
import { WELCOME_OFFER_PERCENT } from "@/lib/offers/welcome-offer-copy";

/**
 * The entry invitation — the first thing a visitor meets, and the ONE opt-in a
 * carrier's A2P review can actually reach.
 *
 * Every other sign-up surface in this store sits behind the account wall, so
 * none of them can be shown to a reviewer: the storefront redirects an
 * anonymous request to /account/login. This modal opens ON that portal, which
 * is why its compliance wording is asserted here rather than left to a visual
 * check. A regression on any line below is not a cosmetic bug — it is a
 * consent record that cannot be defended, and a number that must not be texted.
 *
 * Asserted against the source because the suite runs in node with no DOM: the
 * behaviour a browser would show is covered by the QA script that drives it.
 */

const SRC = join(process.cwd(), "src");
const MODAL = readFileSync(join(SRC, "components", "entry-offer-modal.tsx"), "utf8");
const PORTAL = readFileSync(join(SRC, "app", "account", "login", "page.tsx"), "utf8");

describe("the consent wording is the store's one sentence, not a retyped copy", () => {
  it("renders the shared TCPA sentence rather than its own", () => {
    // A second copy is a second thing to update and one to forget — and what
    // was SHOWN is what a carrier dispute asks about. sms-consent-text.ts is
    // also what the server stores with the consent row, so a divergent copy
    // here means the record and the screen disagree.
    expect(MODAL).toContain('from "@/lib/sms-consent-text"');
    expect(MODAL).toContain("SMS_CONSENT_TEXT");
    expect(MODAL).not.toContain(SMS_CONSENT_TEXT.slice(0, 40));
  });

  it("shows the disclosure line beneath it", () => {
    expect(MODAL).toContain("SMS_DISCLOSURE_TEXT");
    expect(SMS_DISCLOSURE_TEXT).toMatch(/never shared with third parties/i);
  });

  it("links the Privacy Policy and the Terms where the tick is made", () => {
    // Carriers require both reachable from the point of consent, not merely
    // somewhere on the site.
    expect(MODAL).toContain("/legal/privacy");
    expect(MODAL).toContain("/legal/terms");
  });
});

describe("nothing is ever pre-ticked", () => {
  it("starts the SMS consent box unticked", () => {
    // A pre-ticked box is not consent under the TCPA, and it is the single
    // fastest way to lose a number's opt-in record.
    expect(MODAL).toMatch(/const \[smsConsent, setSmsConsent\] = useState\(false\)/);
  });

  it("starts the age and research confirmation unticked", () => {
    expect(MODAL).toMatch(/const \[confirmed, setConfirmed\] = useState\(false\)/);
  });

  it("refuses to submit without the age confirmation", () => {
    expect(MODAL).toMatch(/if \(!confirmed\)/);
  });

  it("refuses to submit until the text box is ticked", () => {
    // THE OFFER IS THE TEXT LIST, AND THE SERVER HAS ALWAYS SAID SO.
    // claimWelcomeOffer refuses without an acceptable mobile number
    // (reason: "phone"), and recordSmsSignupOnly does too — so there is no
    // email-only path behind this endpoint at all. A modal that let someone
    // submit an address alone sent them into "That does not look like a
    // mobile number", which is a nonsense reply to a person who deliberately
    // left the box alone. The tick is asked for up front instead.
    expect(MODAL).toMatch(/if \(!smsConsent\)/);
  });

  it("asks for the number the offer cannot be issued without", () => {
    expect(MODAL).toMatch(/if \(!phone\.trim\(\)\)/);
  });

  it("does not call the text opt-in optional, because the discount depends on it", () => {
    // "Optional" beside a box the offer requires is the kind of small untruth
    // an A2P reviewer reads as a dark pattern. Consent still is not a
    // condition of PURCHASE — the store is open either way — and that
    // sentence stays in SMS_CONSENT_TEXT untouched.
    const smsBlock = MODAL.slice(MODAL.indexOf("entry-offer-sms-consent"), MODAL.indexOf("entry-offer-sms-disclosure"));
    expect(smsBlock).not.toMatch(/Optional/);
  });
});

describe("what it asks for", () => {
  it("shows the account's own address rather than a field that is quietly ignored", () => {
    // THE FIELD WAS DEAD INPUT AND NOBODY COULD TELL.
    //
    // /api/offers/welcome reads "sessionEmail || typedEmail" — the session
    // wins whenever there is one. This card now only opens INSIDE the store,
    // which is behind the account wall, so every visitor who sees it has a
    // session and everything typed here was discarded. Someone entering a
    // different address got their code at their account address and no hint
    // that it had happened; the first they would know is a code that never
    // arrived where they asked for it.
    //
    // Checkout already solved this ("Using your account email."), so this
    // follows that, not a new idea.
    expect(MODAL).toMatch(/type="email"/);
    expect(MODAL).toContain("entry-offer-email");
    expect(MODAL).toMatch(/readOnly/);
    expect(MODAL).toContain("Using your account email");
  });

  it("is told that address by the server rather than guessing at it", () => {
    expect(MODAL).toMatch(/accountEmail/);
  });

  it("collects a mobile number for the text list", () => {
    expect(MODAL).toMatch(/type="tel"/);
    expect(MODAL).toContain("entry-offer-phone");
  });

  it("posts to the one public offer endpoint", () => {
    // /api/offers/welcome is named explicitly on the public list; every other
    // offer path is walled. A guest cannot reach anything else.
    expect(MODAL).toContain('"/api/offers/welcome"');
    expect(MODAL).toMatch(/placement: "storefront"/);
  });

  it("offers the store's own percentage rather than a number typed here", () => {
    expect(MODAL).toContain("WELCOME_OFFER_PERCENT");
    expect(WELCOME_OFFER_PERCENT).toBe(15);
  });
});

describe("it can be dismissed, and it stays dismissed", () => {
  it("closes on the control, the backdrop and escape", () => {
    expect(MODAL).toMatch(/aria-label="Close"/);
    expect(MODAL).toMatch(/Escape/);
  });

  it("is a labelled dialog", () => {
    expect(MODAL).toMatch(/role="dialog"/);
    expect(MODAL).toMatch(/aria-modal="true"/);
  });

  it("remembers a dismissal rather than asking again on the next page", () => {
    expect(MODAL).toMatch(/localStorage/);
  });
});

describe("it opens once a visitor is INSIDE the store, never on the gate", () => {
  const LAYOUT = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");

  it("is not on the access portal", () => {
    // THE GATE ASKS ONE THING. A visitor standing at a sign-in screen has not
    // chosen this store yet, and interrupting that decision with a discount is
    // the owner's call and the answer is no.
    expect(PORTAL).not.toContain("EntryOfferModal");
  });

  it("is mounted globally, so it can open on the pages behind the gate", () => {
    expect(LAYOUT).toContain("<EntryOfferModal />");
  });

  it("replaces the older invitation rather than joining it", () => {
    // Two cards asking the same question is worse than one. The older
    // catalogue invitation is stood down; this is the one the owner approved.
    expect(LAYOUT).not.toContain("<SmsInviteModal />");
  });

  it("opens only on the storefront pages, never checkout or an account screen", () => {
    expect(MODAL).toMatch(/function isStoreRoute/);
    expect(MODAL).toMatch(/pathname === "\/"/);
    expect(MODAL).toMatch(/\/products/);
  });

  it("waits the house interval rather than pouncing on arrival", () => {
    // 6s is what sms-invite-modal.tsx already used. A card that lands the
    // instant a page paints reads as an ad; one that waits reads as an offer.
    expect(MODAL).toMatch(/OPEN_AFTER_MS = 6000/);
  });

  it("does not interrupt someone the offer is not open to", () => {
    // Bought already, subscribed already, holding a code, or once said stop:
    // the server decides all of it and answers mayInterrupt. This never works
    // it out for itself.
    expect(MODAL).toMatch(/mayInterrupt/);
  });
});
