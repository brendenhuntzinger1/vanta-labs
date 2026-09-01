import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://vantalabsresearch.com" }));

const { affiliateAudienceLabel, isAllowedAffiliateLink, validateAffiliateCampaignInput } =
  await import("@/lib/admin-affiliate-email");

function draft(overrides: Record<string, unknown> = {}) {
  return {
    name: "September affiliate update",
    subject: "New product just launched",
    headline: "TB-500 is live",
    body: "Hey {{first_name}},\n\nIt is live. Your code is {{referral_code}}.",
    ctaLabel: "VIEW THE PRODUCT",
    ctaPath: "/products/tb-500",
    linkButtons: [],
    affiliateFilter: "all_active",
    affiliateIds: [],
    ...overrides,
  };
}

function expectRejected(input: Record<string, unknown>): string {
  const result = validateAffiliateCampaignInput(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  return result.error;
}

describe("required fields", () => {
  it("accepts a complete draft", () => {
    expect(validateAffiliateCampaignInput(draft()).ok).toBe(true);
  });

  it.each(["name", "subject", "headline", "body"])("refuses a missing %s", (field) => {
    expect(expectRejected(draft({ [field]: "" }))).toBeTruthy();
  });

  it("refuses a field that is only whitespace", () => {
    expect(expectRejected(draft({ subject: "    " }))).toContain("Subject");
  });

  it("supplies a sensible default button when none is given", () => {
    const result = validateAffiliateCampaignInput(draft({ ctaLabel: "", ctaPath: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctaLabel).toBeTruthy();
    expect(result.value.ctaPath).toBe("/products");
  });
});

describe("a mistyped variable is caught before it can be sent", () => {
  it("refuses an unknown variable in the body", () => {
    expect(expectRejected(draft({ body: "Hey {{firstname}}," }))).toContain("{{firstname}}");
  });

  it("refuses an unknown variable in the subject", () => {
    expect(expectRejected(draft({ subject: "Hi {{name}}" }))).toContain("{{name}}");
  });

  it("refuses an unknown variable hiding in a button label", () => {
    expect(expectRejected(draft({ linkButtons: [{ label: "For {{you}}", url: "/products" }] }))).toContain("{{you}}");
  });

  it("accepts every advertised variable", () => {
    const body = "{{first_name}} {{referral_code}} {{referral_link}} {{commission_percent}} {{affiliate_dashboard_link}}";
    expect(validateAffiliateCampaignInput(draft({ body })).ok).toBe(true);
  });
});

describe("which links an affiliate button may point at", () => {
  it.each([
    ["/products", "a site path"],
    ["https://drive.google.com/folder", "an external resource"],
    ["http://example.com/asset.png", "plain http"],
    ["{{referral_link}}", "a personalised link"],
  ])("allows %s (%s)", (url) => {
    expect(isAllowedAffiliateLink(url)).toBe(true);
  });

  it.each([
    ["javascript:alert(1)", "script"],
    ["data:text/html,<script>", "data url"],
    ["", "empty"],
    ["//evil.com", "protocol-relative"],
    ["/\\evil.com", "backslash authority"],
  ])("refuses %s (%s)", (url) => {
    expect(isAllowedAffiliateLink(url)).toBe(false);
  });

  it("refuses a campaign whose primary button is a javascript: url", () => {
    expect(expectRejected(draft({ ctaPath: "javascript:alert(1)" }))).toBeTruthy();
  });

  it("drops a javascript: extra button rather than storing it", () => {
    const result = validateAffiliateCampaignInput(draft({
      linkButtons: [{ label: "Bad", url: "javascript:alert(1)" }, { label: "Good", url: "/products" }],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.linkButtons).toEqual([{ label: "Good", url: "/products" }]);
  });
});

describe("audience choice", () => {
  it.each(["all_active", "no_sales", "has_sales"])("accepts the %s group", (affiliateFilter) => {
    expect(validateAffiliateCampaignInput(draft({ affiliateFilter })).ok).toBe(true);
  });

  it("refuses an unknown audience", () => {
    expect(expectRejected(draft({ affiliateFilter: "everyone" }))).toContain("Unknown affiliate audience");
  });

  it("refuses 'choose affiliates' with nobody chosen", () => {
    // The dangerous shape: an empty pick must never silently resolve to the
    // whole programme, and must not silently send to nobody either.
    expect(expectRejected(draft({ affiliateFilter: "selected", affiliateIds: [] }))).toContain("at least one affiliate");
  });

  it("accepts 'choose affiliates' with a selection, and de-duplicates it", () => {
    const result = validateAffiliateCampaignInput(draft({ affiliateFilter: "selected", affiliateIds: ["a", "b", "a"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affiliateIds).toEqual(["a", "b"]);
  });

  it("ignores a non-array selection instead of throwing", () => {
    const result = validateAffiliateCampaignInput(draft({ affiliateIds: "a,b" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affiliateIds).toEqual([]);
  });
});

describe("the audience label shown in history", () => {
  it.each([
    ["all_active", "All active affiliates"],
    ["no_sales", "No qualifying sales yet"],
    ["has_sales", "Has qualifying sales"],
  ])("describes %s", (filter, expected) => {
    expect(affiliateAudienceLabel(filter, 0)).toBe(expected);
  });

  it("counts a hand-picked audience", () => {
    expect(affiliateAudienceLabel("selected", 3)).toBe("3 selected affiliates");
    expect(affiliateAudienceLabel("selected", 1)).toBe("1 selected affiliate");
  });

  it("falls back to the raw value rather than showing nothing", () => {
    expect(affiliateAudienceLabel("mystery", 0)).toBe("mystery");
  });
});
