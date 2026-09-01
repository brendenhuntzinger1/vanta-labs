import { describe, expect, it } from "vitest";
import {
  AFFILIATE_MERGE_FIELDS,
  MISSING_FIRST_NAME_FALLBACK,
  buildSampleMergeContext,
  findUnknownMergeFields,
  formatCommissionPercent,
  renderAffiliateMergeFields,
  validateMergeFields,
  type AffiliateMergeContext,
} from "@/lib/email/affiliate-merge";

const SITE = "https://vantalabsresearch.com";

function context(overrides: Partial<AffiliateMergeContext> = {}): AffiliateMergeContext {
  return {
    firstName: "Jordan",
    referralCode: "JORDAN10",
    referralLink: `${SITE}/r/JORDAN10`,
    commissionPercent: 15,
    dashboardLink: `${SITE}/account/ambassador`,
    ...overrides,
  };
}

describe("every advertised variable actually resolves", () => {
  // The list in AFFILIATE_MERGE_FIELDS is what the composer offers the owner as
  // clickable chips. A token advertised there but not handled by the renderer
  // would reach a real affiliate as literal "{{...}}" text, which is the exact
  // failure this pairing exists to prevent.
  it.each(AFFILIATE_MERGE_FIELDS.map((field) => field.token))("resolves {{%s}}", (token) => {
    const rendered = renderAffiliateMergeFields(`value: {{${token}}}`, context());
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toBe("value: ");
  });
});

describe("substitution", () => {
  it("fills a realistic campaign body", () => {
    const body = "Hey {{first_name}},\n\nShare your link: {{referral_link}}\nYour code is {{referral_code}} and you earn {{commission_percent}}%.";
    expect(renderAffiliateMergeFields(body, context())).toBe(
      "Hey Jordan,\n\nShare your link: https://vantalabsresearch.com/r/JORDAN10\nYour code is JORDAN10 and you earn 15%.",
    );
  });

  it("replaces every occurrence, not just the first", () => {
    expect(renderAffiliateMergeFields("{{first_name}} {{first_name}} {{first_name}}", context()))
      .toBe("Jordan Jordan Jordan");
  });

  it("tolerates inner whitespace, because people type it", () => {
    expect(renderAffiliateMergeFields("Hey {{ first_name }},", context())).toBe("Hey Jordan,");
  });

  it("is case-insensitive on the token", () => {
    expect(renderAffiliateMergeFields("Hey {{First_Name}},", context())).toBe("Hey Jordan,");
  });

  it("leaves an unknown token untouched rather than deleting the text", () => {
    // Visible is recoverable; silently vanishing is not. Compose-time
    // validation is what actually stops this reaching anyone.
    expect(renderAffiliateMergeFields("Hey {{firstname}},", context())).toBe("Hey {{firstname}},");
  });
});

describe("a merge value is data, never a template", () => {
  // An affiliate who sets their first name to "{{referral_link}}" must not
  // cause a second expansion pass. Substitution is single-pass by construction.
  it("does not re-expand a token that appears inside a value", () => {
    const rendered = renderAffiliateMergeFields("Hey {{first_name}}", context({ firstName: "{{referral_link}}" }));
    expect(rendered).toBe("Hey {{referral_link}}");
  });

  // This function must NOT escape. campaignTemplate escapes the whole body
  // afterwards; escaping here too would render "Ben &amp; Co" to the affiliate.
  // Asserted on the code rather than the name, because first_name deliberately
  // keeps only the first word and would hide the property being tested.
  it("leaves HTML-significant characters for the template layer to escape", () => {
    expect(renderAffiliateMergeFields("{{referral_code}}", context({ referralCode: "BEN&CO" }))).toBe("BEN&CO");
    expect(renderAffiliateMergeFields("Hey {{first_name}}", context({ firstName: "Ben&Co" }))).toBe("Hey Ben&Co");
  });
});

describe("missing values degrade to something sendable", () => {
  it("falls back to a neutral greeting when there is no first name", () => {
    // "Hey ," is worse than "Hey there," and both are better than a crash
    // partway through a send.
    expect(renderAffiliateMergeFields("Hey {{first_name}},", context({ firstName: null })))
      .toBe(`Hey ${MISSING_FIRST_NAME_FALLBACK},`);
  });

  it("falls back when the stored name is only whitespace", () => {
    expect(renderAffiliateMergeFields("Hey {{first_name}},", context({ firstName: "   " })))
      .toBe(`Hey ${MISSING_FIRST_NAME_FALLBACK},`);
  });

  it("uses only the first word of a full name stored in the first-name field", () => {
    expect(renderAffiliateMergeFields("Hey {{first_name}},", context({ firstName: "Jordan Alvarez" })))
      .toBe("Hey Jordan,");
  });
});

describe("commission percent reads like a rate, not a database column", () => {
  it.each([
    [15, "15"],
    [15.0, "15"],
    [12.5, "12.5"],
    [7.25, "7.25"],
    [0, "0"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatCommissionPercent(input)).toBe(expected);
  });

  it("renders a numeric(5,2) value without its trailing zeros", () => {
    // Supabase hands back 15.00 for numeric(5,2); "you earn 15.00%" reads wrong.
    expect(renderAffiliateMergeFields("{{commission_percent}}%", context({ commissionPercent: 15.0 }))).toBe("15%");
  });

  it("falls back to 0 for a corrupt rate rather than printing NaN", () => {
    expect(formatCommissionPercent(Number.NaN)).toBe("0");
  });
});

describe("compose-time validation is where a typo gets caught", () => {
  it("accepts a body using only known variables", () => {
    expect(validateMergeFields("Hey {{first_name}}, code {{referral_code}}")).toEqual({ ok: true });
  });

  it("accepts a body with no variables at all", () => {
    expect(validateMergeFields("Flash sale is live.")).toEqual({ ok: true });
  });

  it("names the unknown variable so the owner can fix it", () => {
    const result = validateMergeFields("Hey {{firstname}},");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("{{firstname}}");
  });

  it("reports every unknown variable, not only the first", () => {
    expect(findUnknownMergeFields("{{firstname}} {{promo}} {{first_name}}")).toEqual(["firstname", "promo"]);
  });

  it("does not report a known variable as unknown", () => {
    expect(findUnknownMergeFields("{{first_name}}{{referral_code}}{{referral_link}}{{commission_percent}}{{affiliate_dashboard_link}}")).toEqual([]);
  });

  it("checks every field it is given, so a typo in the subject is caught too", () => {
    const result = validateMergeFields("fine {{first_name}}", "broken {{nope}}");
    expect(result.ok).toBe(false);
  });
});

describe("the sample context behind Preview and Test Send", () => {
  const sample = buildSampleMergeContext(SITE);

  it("fills every variable, so a preview never shows a blank", () => {
    const body = AFFILIATE_MERGE_FIELDS.map((field) => `{{${field.token}}}`).join(" ");
    const rendered = renderAffiliateMergeFields(body, sample);
    expect(rendered).not.toContain("{{");
    expect(rendered.split(" ").every((part) => part.length > 0)).toBe(true);
  });

  it("points its links at this site, so a test send is clickable", () => {
    expect(sample.referralLink.startsWith(SITE)).toBe(true);
    expect(sample.dashboardLink.startsWith(SITE)).toBe(true);
  });

  it("is obviously an example, so a preview is never mistaken for real data", () => {
    expect(sample.referralCode).toMatch(/SAMPLE/i);
  });
});

describe("older variable spellings keep working", () => {
  // A draft written before the canonical names settled must not start rendering
  // literal "{{affiliate_code}}" text at a real affiliate.
  it.each([
    ["{{affiliate_code}}", "JORDAN10"],
    ["{{dashboard_link}}", `${SITE}/account/ambassador`],
  ])("resolves the alias %s", (token, expected) => {
    expect(renderAffiliateMergeFields(token, context())).toBe(expected);
  });

  it("does not flag an alias as an unknown variable", () => {
    expect(validateMergeFields("{{affiliate_code}} {{dashboard_link}}")).toEqual({ ok: true });
  });

  it("keeps aliases out of the composer's chip list, so one idea has one name", () => {
    const offered = AFFILIATE_MERGE_FIELDS.map((field) => field.token);
    expect(offered).not.toContain("affiliate_code");
    expect(offered).not.toContain("dashboard_link");
    expect(offered).toContain("referral_code");
    expect(offered).toContain("affiliate_dashboard_link");
  });
});
