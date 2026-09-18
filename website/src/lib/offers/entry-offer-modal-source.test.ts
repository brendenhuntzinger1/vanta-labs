import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";

/**
 * The store invitation, which now invites people to the wheel.
 *
 * WHAT IT IS NOT. Its header used to claim this was "the ONE opt-in a carrier's
 * A2P review can actually reach". That was never true and the component itself
 * says so: it opens on the catalogue, behind the account wall, where an
 * anonymous reviewer cannot go. The publicly reachable opt-in is the
 * create-account form at /account/login, and that surface is frozen.
 *
 * WHAT IT IS. The one interruption in the shopping flow, and the only place a
 * shopper who never received a win-back email learns that the wheel exists. The
 * compliance wording is asserted here rather than left to a visual check,
 * because a regression on any line below is a consent record that cannot be
 * defended.
 *
 * Asserted against the source because the suite runs in node with no DOM: the
 * behaviour a browser would show is covered by the QA script that drives it.
 */

const SRC = join(process.cwd(), "src");
const MODAL = readFileSync(join(SRC, "components", "entry-offer-modal.tsx"), "utf8");
const PORTAL = readFileSync(join(SRC, "app", "account", "login", "page.tsx"), "utf8");

/**
 * The file with its prose removed.
 *
 * SOME OF THESE RULES ARE ABOUT WHAT THE CARD NO LONGER SAYS, and the comments
 * explain the change by naming the very thing that went — "it used to sell 15%
 * off", "the retired card stored vl_entry_offer_joined". Asserted against the
 * raw text, the explanation fails its own lesson. sms-consent.ts's own test
 * already had to learn this; same trick, same reason.
 */
const codeOnly = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");

const MODAL_CODE = codeOnly(MODAL);

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

  it("will not record a consent without the age confirmation and a number", () => {
    // Both are required for the SIGN-UP, and only for the sign-up. This store
    // may not market to anyone who has not made the attestation.
    const branch = MODAL.slice(MODAL.indexOf("if (smsConsent) {"), MODAL.indexOf("trackFunnelEvent(\"spin_invite_accepted\""));
    expect(branch).toMatch(/if \(!confirmed\)/);
    expect(branch).toMatch(/if \(!phone\.trim\(\)\)/);
    expect(branch).toContain('"/api/offers/welcome"');
    expect(branch).toMatch(/placement: "storefront"/);
  });
});

describe("the spin is not bought with a tick", () => {
  it("never makes the text list a condition of spinning", () => {
    // WHILE THE DISCOUNT EXISTED THE OFFER WAS THE TEXT LIST: the server
    // issued no code without a mobile number, so the tick was the price and
    // "optional" beside it would have been untrue. Nothing is bought with a
    // tick now, so the consent has to be genuinely severable — a shopper who
    // ignores the whole section reaches the wheel with one press.
    const spin = MODAL.slice(MODAL.indexOf("const spin = useCallback"));
    const guard = spin.slice(0, spin.indexOf("if (smsConsent) {"));
    expect(guard).not.toMatch(/if \(!smsConsent\)/);
    expect(guard).not.toMatch(/if \(!confirmed\)/);
    expect(spin).toMatch(/router\.push\("\/spin"\)/);
  });

  it("calls the box optional, because it now is", () => {
    // The inverse of the rule this file used to carry, and for the stated
    // reason: the word was forbidden while the discount depended on the tick.
    // It is now the truthful word, and it is how /account/login — the surface
    // a carrier review actually loads — has always put it.
    const smsBlock = MODAL.slice(
      MODAL.indexOf('data-testid="entry-offer-sms-consent"'),
      MODAL.indexOf('id="entry-offer-sms-disclosure"'),
    );
    expect(smsBlock).toMatch(/Optional/);
  });

  it("does not ask for a number from somebody already on the list", () => {
    expect(MODAL).toMatch(/const askForTexts = invite\?\.askForTexts === true;/);
    expect(MODAL).toMatch(/\{askForTexts \? \(/);
  });
});

describe("what it offers", () => {
  it("offers the wheel, and names no retired discount", () => {
    expect(MODAL).toContain("Spin the wheel");
    expect(MODAL).not.toContain("WELCOME_OFFER_PERCENT");
    expect(MODAL_CODE, "the retired first-order discount is back on the card").not.toMatch(/15%/);
  });

  it("states the minimum spend rather than implying the reward is unconditional", () => {
    expect(MODAL).toMatch(/minimum spend/i);
  });

  it("asks the one endpoint whether this person may be interrupted", () => {
    expect(MODAL).toContain('"/api/spin/invite"');
    expect(MODAL).toMatch(/if \(!data\.mayInvite\) return;/);
  });

  it("shows which address a consent would be recorded against", () => {
    // The endpoint reads `sessionEmail || typedEmail` and there is always a
    // session here, so an editable address field would be collecting something
    // the server discards. The address is shown instead of asked for.
    expect(MODAL).toMatch(/accountEmail/);
    expect(MODAL).not.toMatch(/type="email"/);
  });
});

describe("it can be dismissed, and it stays dismissed", () => {
  it("closes on the control, the backdrop, escape and a plain No thanks", () => {
    expect(MODAL).toMatch(/aria-label="Close"/);
    expect(MODAL).toMatch(/Escape/);
    expect(MODAL).toContain('data-testid="entry-offer-skip"');
    expect(MODAL).toContain("No thanks");
  });

  it("is a labelled dialog", () => {
    expect(MODAL).toMatch(/role="dialog"/);
    expect(MODAL).toMatch(/aria-modal="true"/);
  });

  it("remembers a dismissal under a key of its own", () => {
    // NOT the retired card's key. `vl_entry_offer_joined` marked somebody who
    // had taken the old 15%, and reading it here would silence the wheel for
    // exactly the shoppers most worth inviting.
    expect(MODAL).toMatch(/const DISMISSED_KEY = "vl_spin_invite_dismissed_at"/);
    expect(MODAL_CODE).not.toContain("vl_entry_offer_joined");
  });
});

describe("it opens once a visitor is INSIDE the store, never on the gate", () => {
  const LAYOUT = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");

  it("is not on the access portal", () => {
    // THE GATE ASKS ONE THING. A visitor standing at a sign-in screen has not
    // chosen this store yet, and interrupting that decision is the owner's
    // call and the answer is no.
    expect(PORTAL).not.toContain("EntryOfferModal");
  });

  it("is mounted globally, so it can open on the pages behind the gate", () => {
    expect(LAYOUT).toContain("<EntryOfferModal />");
  });

  it("opens on the catalogue and product pages, and NOT on the front page", () => {
    expect(MODAL).toMatch(/function isStoreRoute/);
    expect(MODAL).toMatch(/\/products/);
    expect(MODAL, "the front page is back in the route list").not.toMatch(/pathname === "\/"/);
  });

  it("waits ten seconds, long enough to have read the page", () => {
    expect(MODAL).toMatch(/OPEN_AFTER_MS = 10000/);
  });

  it("yields to anything already covering the page, checked as it opens", () => {
    // The layout has claimed this for a fortnight and nothing implemented it:
    // the yield lived in the older invitation this one replaced and did not
    // come across. Seen on the harness at 390x844 — the promotions card open
    // on the catalogue with the invitation timer still running, which is two
    // interruptions stacked on a phone.
    expect(MODAL).toContain("document.querySelector('[data-offer-modal], [role=\"dialog\"], [data-vl-overlay]')");
    const timer = MODAL.slice(MODAL.indexOf("window.setTimeout"), MODAL.indexOf("OPEN_AFTER_MS);"));
    expect(timer).toContain("if (anotherOverlayIsOpen()) return;");
    // Counted only once it is actually on screen: an invitation that yielded
    // was never shown, and counting it puts a denominator under a
    // non-event.
    expect(timer.indexOf("anotherOverlayIsOpen()")).toBeLessThan(timer.indexOf("spin_invite_shown"));
  });

  it("lets the promotions card mark itself, rather than coordinating by hand", () => {
    const promo = readFileSync(join(SRC, "components", "storefront-offer-modal.tsx"), "utf8");
    expect(promo).toContain('data-offer-modal="true"');
  });
});

describe("the funnel can be measured at its widest point", () => {
  it("records the invitation being shown, skipped and accepted", () => {
    // An invitation nobody takes leaves no trace on the server, so without
    // these three the only measurable point is the spin itself — a conversion
    // rate with no denominator.
    for (const event of ["spin_invite_shown", "spin_invite_skipped", "spin_invite_accepted"]) {
      expect(MODAL).toContain(event);
    }
    const route = readFileSync(join(SRC, "app", "api", "analytics", "track", "route.ts"), "utf8");
    for (const event of ["spin_invite_shown", "spin_invite_skipped", "spin_invite_accepted"]) {
      expect(route, "the relay's allow-list is the real boundary").toContain(`"${event}"`);
    }
  });

  it("counts every way of saying no as the same answer", () => {
    // The backdrop, the ×, escape and "No thanks" all route through close().
    const closeFn = MODAL.slice(MODAL.indexOf("const close = useCallback"), MODAL.indexOf("useEffect(() => {\n    if (!open) return;"));
    expect(closeFn).toContain("spin_invite_skipped");
  });
});
