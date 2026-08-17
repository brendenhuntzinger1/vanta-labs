import { describe, expect, it } from "vitest";
import { campaignTemplate } from "@/lib/email/templates";
import { validateCampaignInput } from "@/lib/admin-email";

// ---------------------------------------------------------------------------
// The composer takes free text from an operator and sends it to every customer
// on the list. That makes it the highest-blast-radius input in the admin, so
// the escaping is asserted rather than assumed — and the CAN-SPAM postal
// address is asserted to actually appear, because an address that is configured
// but not rendered is worth nothing.
// ---------------------------------------------------------------------------

const ADDRESS = "Vanta Labs, 123 Example St, Suite 4, Denver CO 80202";

function render(overrides: Partial<Parameters<typeof campaignTemplate>[0]> = {}) {
  return campaignTemplate({
    subject: "Limited time",
    previewText: "Ends Friday",
    headline: "Buy 2, Get 1",
    body: "First paragraph.\n\nSecond paragraph.",
    promoCode: "B2G1",
    ctaLabel: "SHOP NOW",
    ctaUrl: "https://vantalabsresearch.com/api/email/click?c=1",
    postalAddress: ADDRESS,
    ...overrides,
  });
}

describe("body copy is text, never markup", () => {
  it("escapes HTML an operator pastes in", () => {
    const email = render({ body: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("escapes the headline too", () => {
    const email = render({ headline: `Sale "<b>50%</b>" & more` });
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("&amp;");
  });

  it("cannot break out of the promo code block", () => {
    const email = render({ promoCode: `X"</span><script>alert(1)</script>` });
    expect(email.html).not.toContain("<script>");
  });

  it("turns blank lines into paragraphs and single newlines into breaks", () => {
    const email = render({ body: "Line one\nLine two\n\nNew paragraph." });
    expect(email.html).toContain("Line one<br/>Line two");
    expect(email.html.match(/<p>/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("CAN-SPAM footer", () => {
  it("renders the postal address in the HTML and the text part", () => {
    const email = render();
    expect(email.html).toContain("123 Example St");
    expect(email.text).toContain("123 Example St");
  });

  it("escapes the address rather than trusting the setting", () => {
    const email = render({ postalAddress: "<script>x</script>" });
    expect(email.html).not.toContain("<script>");
  });
});

describe("the rest of the message", () => {
  it("carries the CTA url exactly, so the tracking link is not mangled", () => {
    const url = "https://vantalabsresearch.com/api/email/click?c=abc&e=x%40y.com&t=deadbeef";
    const email = render({ ctaUrl: url });
    // & is escaped in the href attribute, which is correct HTML and resolves
    // back to the same URL in every mail client.
    expect(email.html).toContain("c=abc");
    expect(email.html).toContain("t=deadbeef");
    expect(email.text).toContain(url);
  });

  it("uses the headline as preheader when no preview text is given", () => {
    const email = render({ previewText: null, headline: "Fallback headline" });
    expect(email.html).toContain("Fallback headline");
  });

  it("omits the promo block entirely when there is no code", () => {
    const email = render({ promoCode: null });
    expect(email.html).not.toContain("dashed");
    expect(email.text).not.toContain("Code:");
  });
});

describe("validateCampaignInput", () => {
  const valid = {
    name: "Promo", subject: "Subject", headline: "Headline", body: "Body", ctaPath: "/products", segment: "all",
  };

  it("accepts a well-formed campaign", () => {
    const result = validateCampaignInput(valid);
    expect(result.ok).toBe(true);
  });

  it("requires the fields a customer would actually see", () => {
    for (const missing of ["subject", "headline", "body"] as const) {
      const result = validateCampaignInput({ ...valid, [missing]: "" });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an absolute or protocol-relative button link", () => {
    // The stored path is what the click redirect sends people to, so this is
    // the layer that has to refuse an off-site destination.
    for (const hostile of ["https://evil.com", "//evil.com", "javascript:alert(1)"]) {
      const result = validateCampaignInput({ ...valid, ctaPath: hostile });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("path on this site");
    }
  });

  it("defaults the button link and label rather than sending an empty button", () => {
    const result = validateCampaignInput({ ...valid, ctaPath: "", ctaLabel: "" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctaPath).toBe("/products");
      expect(result.value.ctaLabel).toBe("SHOP NOW");
    }
  });

  it("truncates rather than rejecting oversized copy", () => {
    const result = validateCampaignInput({ ...valid, subject: "x".repeat(500) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subject.length).toBe(200);
  });
});
