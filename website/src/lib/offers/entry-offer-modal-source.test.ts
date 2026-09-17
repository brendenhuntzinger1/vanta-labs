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

  it("subscribes to texts ONLY when the SMS box is ticked", () => {
    // The email sign-up and the text sign-up are separate decisions. Sending a
    // phone number the visitor typed but did not tick for is an unconsented
    // message, so the number is withheld unless the box is on.
    expect(MODAL).toMatch(/smsConsent \? /);
  });
});

describe("what it asks for", () => {
  it("collects an email, because a signed-out visitor has no session to read one from", () => {
    expect(MODAL).toMatch(/type="email"/);
    expect(MODAL).toContain("entry-offer-email");
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

describe("it opens where a visitor enters the site", () => {
  it("is mounted on the access portal", () => {
    // The portal is the entrance for this store and the only page an
    // anonymous visitor — or a reviewer — can reach.
    expect(PORTAL).toContain("EntryOfferModal");
  });
});
