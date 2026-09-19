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

  it("will not record a consent without the age confirmation", () => {
    // The attestation gates MARKETING, and only marketing: this store may not
    // text anyone who has not made it. Keeping a number is not marketing, so
    // the spin never waits on it.
    const submit = MODAL.slice(MODAL.indexOf("const spin = useCallback"));
    expect(submit).toMatch(/if \(smsConsent && !confirmed\)/);
  });

  it("asks for a number and will not spin without one", () => {
    const submit = MODAL.slice(MODAL.indexOf("const spin = useCallback"));
    expect(submit).toMatch(/if \(needPhone && !phone\.trim\(\)\)/);
    expect(submit).toContain('"/api/offers/welcome"');
    expect(submit).toMatch(/placement: "storefront"/);
  });

  it("sends the number whether or not the box was ticked, and says which", () => {
    // THE WHOLE POINT OF THE SPLIT. The number is posted from everybody; the
    // tick travels beside it as its own field, so entering a number can never
    // become a consent by accident.
    const submit = MODAL.slice(MODAL.indexOf("const spin = useCallback"));
    // Either half is a reason to post: a number to keep, or a tick to record
    // against the number already kept.
    expect(submit).toMatch(/if \(phone\.trim\(\) \|\| smsConsent\)/);
    expect(submit).toContain("smsConsent }");
  });

  it("does not make somebody retype a number the store already holds", () => {
    // The server answers this; the card never decides it. The one thing that
    // can override it is the server saying, on a tick, that it has no number
    // after all — and then the field is shown rather than the consent lost.
    expect(MODAL).toMatch(/const needPhone = invite\?\.needPhone === true \|\| revealPhone;/);
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

describe("a tick is recorded even when the card never asked for a number", () => {
  // THE CARD STOPS ASKING once the store holds a number — that stored number is
  // what the tick subscribes, so retyping it buys nothing. But the SMS box is
  // still shown, and the submit used to post only when a number had been typed
  // INTO THIS CARD. So the commonest consent there is — a returning shopper
  // ticking the box with no field in front of them — was read, shown a wheel,
  // and dropped. Nothing recorded it and nothing said so.
  const SPIN_FN = MODAL_CODE.slice(MODAL_CODE.indexOf("const spin = useCallback"), MODAL_CODE.indexOf("if (!open) return null;"));

  it("posts when the box is ticked, with or without a typed number", () => {
    expect(SPIN_FN).toContain("if (phone.trim() || smsConsent)");
    expect(SPIN_FN, "the post is still gated on a typed number").not.toContain("if (needPhone && phone.trim())");
  });

  it("still sends the tick as its own field rather than implying it from the number", () => {
    expect(SPIN_FN).toContain("smsConsent }");
  });

  it("reopens the phone field when the server says it has no number to consent", () => {
    // The alternative is telling somebody to enter a number with nowhere to
    // type one, which is how a dropped consent looks from the shopper's side.
    expect(SPIN_FN).toContain("needPhone");
    expect(MODAL_CODE).toContain("setRevealPhone(true)");
    // One `needPhone`, so the field that appears and the field the submit
    // insists on can never disagree.
    expect(MODAL_CODE, "the revealed field is never rendered").toContain("const needPhone = invite?.needPhone === true || revealPhone;");
  });
});

describe("a refusal the shopper cannot act on does not cost them the spin", () => {
  // THE COMPONENT HAS ALWAYS SAID THIS AND DID NOT DO IT: "the offer was never
  // conditional on the text list, and stranding them on a card because a
  // subscription did not take would be making it conditional after the fact."
  // Every `ok: false` stopped the spin, including the rate limiter's.
  //
  // MEASURED, not theorised: the limiter is keyed on the request IP at ten an
  // hour, so the eleventh shopper behind one mobile carrier's NAT was shown
  // "Please wait a moment before trying again" and could not spin at all.
  const SPIN_FN = MODAL_CODE.slice(MODAL_CODE.indexOf("const spin = useCallback"), MODAL_CODE.indexOf("if (!open) return null;"));

  it("keeps them on the card only for a refusal they can fix", () => {
    expect(SPIN_FN).toContain("res.status === 400");
  });

  it("goes to the wheel on anything else", () => {
    // The push is what must always happen; the sign-up is the thing that may
    // fail. If this assertion ever inverts, a limiter or a 500 takes the prize.
    const afterPost = SPIN_FN.slice(SPIN_FN.indexOf("res.status === 400"));
    expect(afterPost).toContain('router.push("/spin")');
  });

  it("is not gated on the storefront limiter being shared between shoppers", () => {
    // The endpoint's own key: a signed-in caller is counted as themselves, so
    // one household, campus or carrier NAT is not one bucket.
    const route = readFileSync(join(SRC, "app", "api", "offers", "welcome", "route.ts"), "utf8");
    expect(route).toContain("sessionEmail ? `welcome-offer-account:${sessionEmail}`");
  });
});

describe("what the funnel is told, and what a stalled connection does", () => {
  const MODAL_ALL = MODAL_CODE;

  it("reports joining the text list only when the server said it happened", () => {
    // `joinedTexts: smsConsent` reported the ASK. A limiter, a 500 or the
    // endpoint's own 200-with-ok:false all let the shopper through to the
    // wheel with nothing recorded, so the funnel counted sign-ups that no
    // consent record could ever be produced for.
    expect(MODAL_ALL).toContain("joinedTexts = smsConsent && data?.subscribed === true;");
    expect(MODAL_ALL).toContain('trackFunnelEvent("spin_invite_accepted", { placement: "storefront", joinedTexts });');
    expect(MODAL_ALL, "the ask is being reported as the outcome").not.toContain("joinedTexts: smsConsent");
  });

  it("gives the request a deadline, so a held-open socket cannot disable the button for good", () => {
    // `fetch` on a socket that is opened and never answered neither resolves
    // nor rejects, so no catch can reach it: "One moment…" stays disabled for
    // the life of the page and the only way out is a reload.
    expect(MODAL_ALL).toContain("signal: timeoutSignal(REQUEST_TIMEOUT_MS)");
  });

  it("announces a validation refusal rather than only drawing it", () => {
    expect(MODAL).toContain('role="alert"');
    expect(MODAL).toContain('aria-describedby={error ? "entry-offer-error" : undefined}');
  });
});

describe("the wheel's own presses have the same deadline", () => {
  const WHEEL = readFileSync(join(SRC, "components", "spin-wheel.tsx"), "utf8");

  it("the spin and the dose choice both carry one", () => {
    // "Spinning…" and "Saving…" are both disabled-while-in-flight controls.
    const signals = WHEEL.split("signal: timeoutSignal(REQUEST_TIMEOUT_MS)").length - 1;
    expect(signals, "a press can still hang for ever").toBeGreaterThanOrEqual(2);
  });
});
