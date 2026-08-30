import { describe, expect, it } from "vitest";

import { referralCodeAssignedTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// AN APPROVED AMBASSADOR MUST NEVER BE TOLD THEY EARN 0%.
//
// WHAT HAPPENED. Jaeley Reynolds was approved with referral code MIZZY and
// received "You'll earn 0% commission on qualifying orders placed through your
// link." Their stored rate was 15.00 — on BOTH ambassadors and partners. The
// database was right the whole time; the email was the only thing that lied.
//
// ROOT CAUSE. updatePartnerStatus sent the email as:
//
//     commissionPercent: input.commissionPercent ?? 0
//
// input.commissionPercent is the rate typed in THAT admin request. Assigning or
// changing a referral code without re-entering the rate in the same submission
// leaves it undefined, and `?? 0` turned the absence into a literal zero. The
// approval email, two blocks above in the same function, already did it
// properly — reading the stored rate and falling back to the program default —
// so the two emails sent from one action disagreed with each other.
//
// WHAT WAS NOT WRONG. The money. ensureCommissionRecord resolves the rate
// through getEffectiveCommissionPercent, which reads ambassadors.commission_
// percent directly; the email is not an input to it. All seven ambassadors in
// production hold real rates (10, 10, 15, 20, 15, 15, 15) and none is 0 or
// null, so nothing needed correcting in the data and nothing was written to it.
//
// THE FIX. The rate is resolved inside sendReferralCodeAssignedEmail — request
// rate, then stored rate, then program default — so no caller can express
// "email them zero" by forgetting to pass something. A deliberate 0 still
// sends 0, because an owner may genuinely run a 0% ambassador; only ABSENCE
// now means "look it up".
//
// This file covers the template and the resolution rule. The wiring from the
// admin action through to the send is covered in referral-code-email-wiring.test.ts.
// ---------------------------------------------------------------------------

/**
 * The resolution rule under test, matching firstFinitePercent in
 * partner-portal.ts. Kept in step by referral-code-email-wiring.test.ts, which
 * drives the real function.
 */
function resolve(candidates: Array<number | string | null | undefined>): number {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === "string" && candidate.trim() === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

describe("the exact email that went out", () => {
  it("says 15%, not 0%, for MIZZY's stored rate", () => {
    const percent = resolve([undefined, "15.00", 10]);
    const email = referralCodeAssignedTemplate({
      name: "Jaeley Reynolds",
      referralCode: "MIZZY",
      referralLink: "https://www.vantalabsresearch.com/r/MIZZY",
      commissionPercent: percent,
      dashboardUrl: "https://www.vantalabsresearch.com/account/ambassador",
    });

    expect(email.html).toContain("You'll earn 15% commission");
    expect(email.html).not.toContain("earn 0% commission");
    expect(email.text).toContain("Commission rate: 15%");
  });

  it("reproduces the old bug when the old expression is used", () => {
    // `input.commissionPercent ?? 0` with nothing typed in the request. Read
    // through a function so the compiler cannot fold the branch away — the
    // point is the runtime value the old expression produced.
    const requestRate = (): number | undefined => undefined;
    const oldWay = requestRate() ?? 0;
    const email = referralCodeAssignedTemplate({
      name: "Jaeley Reynolds",
      referralCode: "MIZZY",
      referralLink: "https://www.vantalabsresearch.com/r/MIZZY",
      commissionPercent: oldWay,
      dashboardUrl: "https://www.vantalabsresearch.com/account/ambassador",
    });
    // The screenshot, regenerated. This is what must never be produced again.
    expect(email.html).toContain("earn 0% commission");
  });
});

describe("which rate the email quotes", () => {
  it("uses the rate the admin just typed, when they typed one", () => {
    expect(resolve([20, "15.00", 10])).toBe(20);
  });

  it("falls back to the stored rate when the request set none", () => {
    expect(resolve([undefined, "15.00", 10])).toBe(15);
  });

  it("falls back to the program default when the ambassador has no rate yet", () => {
    expect(resolve([undefined, null, 10])).toBe(10);
  });

  it("reads a postgres numeric string, which is how the column arrives", () => {
    // numeric(5,2) comes back as "15.00", not 15. Treating that as absent is
    // how a correct stored rate would still have emailed the default.
    expect(resolve([undefined, "15.00"])).toBe(15);
    expect(resolve([undefined, "7.50"])).toBe(7.5);
  });

  it("treats an empty string as absent, not as zero", () => {
    // Number("") is 0. Without the guard, a blanked column emails 0% again.
    expect(resolve([undefined, "", 15])).toBe(15);
    expect(resolve([undefined, "   ", 15])).toBe(15);
  });

  it("honours a deliberate 0% rather than overriding it", () => {
    // The owner may genuinely run a 0% ambassador. Absence and zero are
    // different things, and only absence looks further.
    expect(resolve([0, "15.00", 10])).toBe(0);
    expect(resolve([undefined, 0, 10])).toBe(0);
  });

  it("only reaches 0 when nothing at all is configured", () => {
    expect(resolve([undefined, null, undefined])).toBe(0);
  });
});

describe("every rate in production emails as itself", () => {
  // The seven live ambassadors, as stored: PAUL, ELIJAH-AB78AE, SMOKE, ZAIN,
  // ELOA, FLAVIAROSSETTI, MIZZY. None is 0 or null.
  it.each([
    ["PAUL", "10.00", 10],
    ["ELIJAH-AB78AE", "10.00", 10],
    ["SMOKE", "15.00", 15],
    ["ZAIN", "20.00", 20],
    ["ELOA", "15.00", 15],
    ["FLAVIAROSSETTI", "15.00", 15],
    ["MIZZY", "15.00", 15],
  ])("%s is emailed %s as %i%%", (code, stored, expected) => {
    const percent = resolve([undefined, stored, 10]);
    expect(percent).toBe(expected);
    const email = referralCodeAssignedTemplate({
      name: "Ambassador",
      referralCode: code,
      referralLink: `https://www.vantalabsresearch.com/r/${code}`,
      commissionPercent: percent,
      dashboardUrl: "https://www.vantalabsresearch.com/account/ambassador",
    });
    expect(email.html).toContain(`earn ${expected}% commission`);
    expect(email.html).not.toContain("earn 0% commission");
  });
});

describe("the link the ambassador is given", () => {
  it("points at their own code", () => {
    const email = referralCodeAssignedTemplate({
      name: "Jaeley Reynolds",
      referralCode: "MIZZY",
      referralLink: "https://www.vantalabsresearch.com/r/MIZZY",
      commissionPercent: 15,
      dashboardUrl: "https://www.vantalabsresearch.com/account/ambassador",
    });
    expect(email.html).toContain("/r/MIZZY");
    expect(email.text).toContain("/r/MIZZY");
  });

  it("escapes a name rather than rendering it as markup", () => {
    const email = referralCodeAssignedTemplate({
      name: '<img src=x onerror="alert(1)">',
      referralCode: "MIZZY",
      referralLink: "https://www.vantalabsresearch.com/r/MIZZY",
      commissionPercent: 15,
      dashboardUrl: "https://www.vantalabsresearch.com/account/ambassador",
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img");
  });
});
