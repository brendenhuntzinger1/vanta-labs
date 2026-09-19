import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_VERSION, acceptableSmsPhone } from "@/lib/sms-consent-text";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const FORM = read("src/components/sms-optin-form.tsx");
const PAGE = read("src/app/sms/page.tsx");
const ROUTE = read("src/app/api/sms/subscribe/route.ts");

/** Strip comments, so prose ABOUT a banned pattern is not mistaken for it. */
function code(src: string) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

const FORM_CODE = code(FORM);
const PAGE_CODE = code(PAGE);
const ROUTE_CODE = code(ROUTE);

// ---------------------------------------------------------------------------
// THE PAGE A CARRIER READS.
//
// This store's toll-free registration was refused repeatedly, and each refusal
// named something the reviewer could not see rather than something that was
// wrong: "cannot validate business website URL", "opt-in not provided", "age
// gate is needed". The consent sentence was already correct the whole time. It
// was behind an account.
//
// So the properties pinned here are the ones a REVIEWER checks, in the order
// they check them, and every one of them is a property that a well-meaning
// later edit could quietly remove: a pre-ticked box to lift conversion, the
// welcome discount added back "since it's an opt-in page anyway", transactional
// messages folded into the marketing sentence to save a paragraph.
// ---------------------------------------------------------------------------

describe("the scan has something to scan", () => {
  it("loaded all three sources, so the negative assertions below mean something", () => {
    // Every "must not contain" test in this file passes trivially against an
    // empty string. Renaming or moving any of these files must fail loudly
    // here rather than quietly turning the rest of the suite green.
    expect(FORM_CODE.length).toBeGreaterThan(500);
    expect(PAGE_CODE.length).toBeGreaterThan(500);
    expect(ROUTE_CODE.length).toBeGreaterThan(500);
    expect(FORM_CODE).toContain("SmsOptInForm");
    expect(PAGE_CODE).toContain("SmsOptInPage");
    expect(ROUTE_CODE).toContain("export async function POST");
  });
});

describe("both boxes start unticked, and neither ticks the other", () => {
  it("initialises each agreement to false", () => {
    expect(FORM_CODE).toMatch(/useState\(false\)/);
    // Two separate pieces of state, named for what they mean.
    expect(FORM_CODE).toMatch(/const\s*\[\s*ageConfirmed\s*,\s*setAgeConfirmed\s*\]\s*=\s*useState\(false\)/);
    expect(FORM_CODE).toMatch(/const\s*\[\s*smsConsent\s*,\s*setSmsConsent\s*\]\s*=\s*useState\(false\)/);
  });

  it("never seeds either box from anything", () => {
    // defaultChecked, checked={true}, or a value read from storage or the URL
    // would each be a pre-ticked box wearing a different hat.
    expect(FORM_CODE).not.toMatch(/defaultChecked/);
    expect(FORM_CODE).not.toMatch(/checked=\{\s*true\s*\}/);
    expect(FORM_CODE).not.toMatch(/localStorage|sessionStorage|searchParams/);
  });

  it("keeps the age confirmation from setting the SMS agreement", () => {
    // The exact regression this guards: one handler writing both. Checking
    // "I am 21" must never be, or become, permission to send marketing.
    expect(FORM_CODE).not.toMatch(/setAgeConfirmed\([^)]*\)\s*;\s*setSmsConsent\(/);
    expect(FORM_CODE).not.toMatch(/setSmsConsent\(\s*ageConfirmed\s*\)/);
    expect(FORM_CODE).not.toMatch(/setSmsConsent\(\s*event\.target\.checked\s*\)[\s\S]{0,80}setAgeConfirmed/);
  });

  it("sends only the SMS agreement to the server", () => {
    // Age is a gate on this form; it is not a permission this store records.
    expect(FORM_CODE).toMatch(/consent:\s*true/);
    expect(FORM_CODE).not.toMatch(/age:\s*ageConfirmed/);
  });
});

describe("the consent sentence is the shared constant, not a copy of it", () => {
  it("renders SMS_CONSENT_TEXT rather than retyping it", () => {
    expect(FORM_CODE).toMatch(/\{\s*SMS_CONSENT_TEXT\s*\}/);
    // A paraphrase living on the one page a carrier reads is the worst place
    // for the wording to drift from what the consent row says was shown.
    expect(FORM_CODE).not.toContain("Consent is not a condition of purchase.");
  });

  it("still carries every clause the carriers require", () => {
    // Asserted against the constant itself: if someone edits it, this is where
    // the missing clause shows up, whichever surface renders it.
    for (const clause of [
      "recurring automated marketing text messages",
      "Vanta Labs",
      "Consent is not a condition of purchase",
      "Message frequency varies",
      "Message and data rates may apply",
      "Reply STOP to cancel",
      "HELP for help",
    ]) {
      expect(SMS_CONSENT_TEXT).toContain(clause);
    }
  });

  it("keeps a disclosure version pinned to the wording", () => {
    expect(SMS_DISCLOSURE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the page is marketing only", () => {
  it("does not fold transactional messaging into the marketing consent", () => {
    // "order updates, shipping notifications AND promotional offers" in one
    // consent is a named rejection reason, and it is also untrue of this box.
    const surface = `${PAGE_CODE} ${FORM_CODE} ${SMS_CONSENT_TEXT}`.toLowerCase();
    for (const transactional of [
      "order confirmation",
      "shipping notification",
      "order update",
      "delivery update",
      "account alert",
    ]) {
      expect(surface, `the opt-in must not promise ${transactional}s`).not.toContain(transactional);
    }
  });

  it("says plainly that the messages are promotional", () => {
    expect(PAGE_CODE.toLowerCase()).toContain("promotional text messages");
  });
});

describe("the retired welcome incentive is not advertised here", () => {
  it("offers no discount, code or percentage", () => {
    const surface = `${PAGE_CODE} ${FORM_CODE}`;
    // The screenshot previously submitted for verification read "Get 15% off
    // your first order" and "Text me my 15% code and updates". That incentive
    // is retired and must not reappear on the compliance surface.
    expect(surface).not.toMatch(/\d+%/);
    expect(surface.toLowerCase()).not.toContain("discount");
    expect(surface.toLowerCase()).not.toContain("% off");
    expect(surface).not.toMatch(/WELCOME_OFFER|welcome-offer/);
  });

  it("does not import the offer machinery at all", () => {
    expect(FORM_CODE).not.toMatch(/@\/lib\/offers/);
    expect(PAGE_CODE).not.toMatch(/@\/lib\/offers/);
    // And posts to its own endpoint rather than the one that mints codes.
    expect(FORM_CODE).toContain("/api/sms/subscribe");
    expect(FORM_CODE).not.toContain("/api/offers/welcome");
  });
});

describe("the reviewer's checklist is on the page", () => {
  it("links both policies", () => {
    expect(FORM_CODE).toContain("/legal/privacy");
    expect(FORM_CODE).toContain("/legal/terms");
  });

  it("identifies the business", () => {
    expect(PAGE_CODE).toMatch(/BRAND_LEGAL_NAME/);
    expect(PAGE_CODE).toMatch(/supportEmail/);
  });

  it("states the age restriction and how it is enforced", () => {
    expect(PAGE_CODE).toContain("21");
    expect(FORM_CODE).toContain("I confirm I am 21 years of age or older.");
  });

  it("invents no business details", () => {
    // site-identity.ts publishes no postal address or telephone number and
    // says why; a compliance page is exactly where someone would be tempted to
    // fill those in to look more legitimate.
    expect(PAGE_CODE).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
    expect(PAGE_CODE).not.toMatch(/\b[A-Z]{2}\s+\d{5}\b/);
  });
});

describe("the endpoint records consent and nothing else", () => {
  it("refuses anything whose consent flag is not exactly true", () => {
    // Not truthy: "false", 0 and "" all arrive from real form serialisers.
    expect(ROUTE_CODE).toMatch(/body\.consent\s*!==\s*true/);
  });

  it("writes through the one shared consent writer", () => {
    expect(ROUTE_CODE).toMatch(/recordSmsConsent/);
    expect(ROUTE_CODE).toMatch(/source:\s*"sms-page"/);
  });

  it("mints no discount and grants nothing", () => {
    expect(ROUTE_CODE).not.toMatch(/claimWelcomeOffer|grantWelcomeOffer|coupon|code:/);
  });

  it("is rate limited", () => {
    expect(ROUTE_CODE).toMatch(/checkRateLimit/);
  });

  it("never claims the number is verified", () => {
    // status stays at the table default of 'pending'; this store sends no
    // confirmation code, so "verified" would be a lie told to the one table a
    // carrier would ask to see.
    expect(ROUTE_CODE).not.toMatch(/verified/);
  });
});

describe("the phone validator the page relies on", () => {
  // FIXTURES FOLLOW sms-consent-phone.test.ts, AND THAT IS NOT COSMETIC.
  //
  // This block first used "(555) 555-5555", which passed locally and failed in
  // CI. The cause was neither flake nor environment: #215 landed on main while
  // this branch was open and taught acceptableSmsPhone the numbering plan's own
  // rules, under which 555 is not an assignable AREA code — so 5555555555 is
  // not a typo, it is a number that cannot exist, and rejecting it is correct.
  //
  // The valid shape is an assignable NPA with the 555 EXCHANGE, which is the
  // range reserved for fiction and the one this repository uses everywhere so
  // that no suite can dial a real person.
  it("accepts numbers people actually type", () => {
    expect(acceptableSmsPhone("(415) 555-1234")).toBeTruthy();
    expect(acceptableSmsPhone("+1 415 555 1234")).toBeTruthy();
    expect(acceptableSmsPhone("512-555-0100")).toBeTruthy();
  });

  it("rejects what cannot be texted", () => {
    expect(acceptableSmsPhone("")).toBeNull();
    expect(acceptableSmsPhone("not a number")).toBeNull();
    expect(acceptableSmsPhone("12345")).toBeNull();
  });

  it("rejects the impossible numbers the opt-in page would otherwise collect", () => {
    // The public page takes numbers from strangers with no account, so it is
    // the surface most likely to be handed a placeholder. These are refused by
    // structure rather than by guessing at ownership.
    expect(acceptableSmsPhone("(555) 555-5555")).toBeNull();
    expect(acceptableSmsPhone("1234567890")).toBeNull();
    expect(acceptableSmsPhone("0000000000")).toBeNull();
  });
});
