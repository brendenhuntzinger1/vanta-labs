import { describe, expect, it } from "vitest";
import {
  buildAffiliateCampaignEmail,
  isTrackableLink,
  normalizeLinkButtons,
} from "@/lib/email/affiliate-campaign-template";
import type { AffiliateMergeContext } from "@/lib/email/affiliate-merge";

const SITE = "https://vantalabsresearch.com";
const POSTAL = "Vanta Labs, 1 Example Way, Austin TX";

const merge: AffiliateMergeContext = {
  firstName: "Jordan",
  referralCode: "JORDAN10",
  referralLink: `${SITE}/r/JORDAN10`,
  commissionPercent: 15,
  dashboardLink: `${SITE}/account/ambassador`,
};

function build(overrides: Partial<Parameters<typeof buildAffiliateCampaignEmail>[0]> = {}) {
  return buildAffiliateCampaignEmail({
    subject: "Flash sale is live",
    previewText: null,
    headline: "Buy 2 Get 1 Free starts now",
    body: "Hey {{first_name}},\n\nThe sale is live.",
    ctaLabel: "SHOP THE SALE",
    ctaPath: "/products",
    linkButtons: [],
    mergeContext: merge,
    siteUrl: SITE,
    postalAddress: POSTAL,
    // Injected so link-tracking POLICY is testable without a signing secret.
    trackedUrlFor: (index) => `${SITE}/api/email/click?c=CID&l=${index}`,
    ...overrides,
  });
}

describe("the message the owner wrote is the message that goes out", () => {
  it("renders the headline and body", () => {
    const email = build();
    expect(email.html).toContain("Buy 2 Get 1 Free starts now");
    expect(email.html).toContain("The sale is live.");
  });

  it("personalises the body from the affiliate's own record", () => {
    expect(build().html).toContain("Hey Jordan,");
  });

  it("personalises the subject line too", () => {
    expect(build({ subject: "{{first_name}}, the sale is live" }).subject).toBe("Jordan, the sale is live");
  });

  it("personalises the headline", () => {
    expect(build({ headline: "Nice work, {{first_name}}" }).html).toContain("Nice work, Jordan");
  });

  it("invents nothing — no discount, deadline or bonus the owner did not type", () => {
    const email = build({ body: "Plain message.", headline: "Update", ctaLabel: "OPEN" });
    for (const invented of ["%", "$", "bonus", "expires", "hurry", "limited time"]) {
      expect(email.html.toLowerCase().split("vanta labs")[1] ?? "").not.toContain(invented.toLowerCase());
    }
  });

  it("keeps paragraph breaks the owner typed", () => {
    const email = build({ body: "First para.\n\nSecond para." });
    expect(email.html).toContain("<p>First para.</p>");
    expect(email.html).toContain("<p>Second para.</p>");
  });
});

describe("body content cannot become markup", () => {
  it("escapes HTML typed into the body", () => {
    const email = build({ body: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("escapes a merge value, because the value is data", () => {
    const email = build({
      body: "Hey {{first_name}}",
      mergeContext: { ...merge, firstName: "<img src=x onerror=alert(1)>" },
    });
    expect(email.html).not.toContain("<img src=x");
  });
});

describe("the primary call to action", () => {
  it("uses the owner's button text", () => {
    expect(build().html).toContain("SHOP THE SALE");
  });

  it("is click-tracked, because it is a site path", () => {
    // "&" is correctly escaped to "&amp;" inside an href attribute.
    expect(build().html).toContain(`${SITE}/api/email/click?c=CID&amp;l=null`);
    expect(build().text).toContain(`${SITE}/api/email/click?c=CID&l=null`);
  });
});

describe("extra resource buttons", () => {
  const linkButtons = [
    { label: "Product page", url: "/products/bpc-157" },
    { label: "Marketing images", url: "https://drive.google.com/folder/abc" },
    { label: "Your referral link", url: "{{referral_link}}" },
  ];

  it("renders a button for every resource", () => {
    const email = build({ linkButtons });
    expect(email.html).toContain("Product page");
    expect(email.html).toContain("Marketing images");
    expect(email.html).toContain("Your referral link");
  });

  it("click-tracks a plain site path", () => {
    expect(build({ linkButtons }).html).toContain(`${SITE}/api/email/click?c=CID&amp;l=0`);
  });

  it("links an EXTERNAL resource directly, never through the redirect", () => {
    // The click redirect resolves its destination from the campaign row and is
    // constrained to this site. Routing an off-site URL through it would turn a
    // tracking link into an open redirect on a domain affiliates trust.
    const html = build({ linkButtons }).html;
    expect(html).toContain("https://drive.google.com/folder/abc");
    expect(html).not.toContain(`${SITE}/api/email/click?c=CID&amp;l=1`);
  });

  it("links a PERSONALISED url directly, resolved for this affiliate", () => {
    // A per-recipient destination cannot be resolved from the campaign row at
    // click time, so it is never tracked — it is merged and linked directly.
    const html = build({ linkButtons }).html;
    expect(html).toContain(`${SITE}/r/JORDAN10`);
    expect(html).not.toContain(`${SITE}/api/email/click?c=CID&amp;l=2`);
  });

  it("lists every button in the plain-text part", () => {
    const email = build({ linkButtons });
    expect(email.text).toContain("Product page:");
    expect(email.text).toContain("Marketing images: https://drive.google.com/folder/abc");
    expect(email.text).toContain(`Your referral link: ${SITE}/r/JORDAN10`);
  });

  it("renders no button block at all when there are no extra links", () => {
    expect(build({ linkButtons: [] }).html).not.toContain("resource-buttons");
  });
});

describe("which links can be click-tracked", () => {
  it.each([
    ["/products", true],
    ["/products/bpc-157?x=1", true],
    ["/", true],
  ])("tracks the site path %s", (url, expected) => {
    expect(isTrackableLink(url, SITE)).toBe(expected);
  });

  it.each([
    ["https://drive.google.com/x", "off-site"],
    ["{{referral_link}}", "personalised"],
    ["/r/{{referral_code}}", "personalised"],
    ["//evil.com", "protocol-relative"],
    ["/\\evil.com", "backslash authority"],
    ["", "empty"],
  ])("refuses to track %s (%s)", (url) => {
    expect(isTrackableLink(url, SITE)).toBe(false);
  });
});

describe("link buttons are normalised before they are stored", () => {
  it("drops a button with no label or no url", () => {
    expect(normalizeLinkButtons([{ label: "", url: "/x" }, { label: "Y", url: "  " }])).toEqual([]);
  });

  it("trims and keeps a good button", () => {
    expect(normalizeLinkButtons([{ label: "  Shop  ", url: " /products " }])).toEqual([{ label: "Shop", url: "/products" }]);
  });

  it("caps the number of buttons, so an email cannot become a link farm", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, url: `/p${i}` }));
    expect(normalizeLinkButtons(many).length).toBeLessThanOrEqual(6);
  });

  it("ignores junk instead of throwing", () => {
    expect(normalizeLinkButtons(null)).toEqual([]);
    expect(normalizeLinkButtons("nope" as unknown as unknown[])).toEqual([]);
    expect(normalizeLinkButtons([null, 5, { label: "A", url: "/a" }] as unknown[])).toEqual([{ label: "A", url: "/a" }]);
  });

  it("refuses a javascript: url outright", () => {
    expect(normalizeLinkButtons([{ label: "Bad", url: "javascript:alert(1)" }])).toEqual([]);
  });
});

describe("compliance", () => {
  it("carries the postal address", () => {
    expect(build().html).toContain("Vanta Labs, 1 Example Way, Austin TX");
    expect(build().text).toContain("Vanta Labs, 1 Example Way, Austin TX");
  });

  it("uses the preview text when one is given, and the headline otherwise", () => {
    expect(build({ previewText: "Two days only" }).html).toContain("Two days only");
    expect(build({ previewText: null }).html).toContain("Buy 2 Get 1 Free starts now");
  });
});
