import { describe, expect, it } from "vitest";

import { renderCtaButton, renderLayout } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE BUTTON IS THE ONLY PART OF A MARKETING EMAIL THAT HAS A JOB.
//
// Everything else in a message is there to get someone to the button. It was
// rendered as `<a style="display:inline-block;padding:12px 24px;…">` — correct
// CSS, and wrong in the two ways that cost money:
//
//   1. Outlook on Windows renders mail through Word's layout engine, which
//      supports neither inline-block nor padding on an inline element. The
//      padding box collapsed and the button degraded to text on a coloured
//      background. It still linked; it stopped looking clickable.
//   2. At 13px type and 12px of padding it was roughly a 37px tap target,
//      under the 44px both Apple and Google publish. On the phones that carry
//      most of this store's traffic, a near-miss scrolled the message.
//
// It was also off-white — the same treatment for "SHOP NOW" and for "Reset
// Password" — so the commercial ask never looked like the point of the page.
//
// This file pins the replacement: variants, Outlook-safe markup, a real tap
// target, and the blank-CTA behaviour an operator depends on when they clear
// the button text on an automation and expect no button at all.
// ---------------------------------------------------------------------------

const URL = "https://www.vantalabsresearch.com/products";

describe("renderCtaButton variants", () => {
  it("paints the commercial ask in Vanta gold", () => {
    const html = renderCtaButton({ label: "Shop now", url: URL, variant: "primary" });
    expect(html).toContain('bgcolor="#F2C94C"');
    expect(html).toContain("color:#111111");
  });

  it("leaves the functional ask neutral", () => {
    // A password reset dressed as a sales button reads as marketing to a
    // filter and to a reader. Utility keeps the pre-existing off-white.
    const html = renderCtaButton({ label: "Reset password", url: URL, variant: "utility" });
    expect(html).toContain('bgcolor="#F4F4F4"');
    expect(html).not.toContain("#F2C94C");
  });

  it("defaults to utility, so selling is opt-in", () => {
    // The reverse default would turn every receipt gold the moment somebody
    // added a button to it.
    expect(renderCtaButton({ label: "Open", url: URL })).toContain('bgcolor="#F4F4F4"');
  });
});

describe("renderCtaButton survives Outlook on Windows", () => {
  const html = renderCtaButton({ label: "Shop now", url: URL, variant: "primary" });

  it("puts the fill on a table cell, which Word actually honours", () => {
    expect(html).toMatch(/<td[^>]*bgcolor="#F2C94C"/);
  });

  it("gives Word its own padding property", () => {
    // mso-padding-alt is read by Outlook and ignored everywhere else, so it
    // cannot double up with the anchor's real padding.
    expect(html).toContain("mso-padding-alt:16px 28px");
  });

  it("keeps real padding on the anchor so the whole pill stays clickable elsewhere", () => {
    expect(html).toMatch(/<a href="[^"]*"[^>]*padding:16px 28px/);
    expect(html).toMatch(/<a href="[^"]*"[^>]*display:inline-block/);
  });

  it("pins the line box so Word cannot inflate the button", () => {
    expect(html).toContain("mso-line-height-rule:exactly");
  });

  it("carries no percentage or dollar sign", () => {
    // affiliate-campaign-template.test.ts forbids both anywhere below the
    // brand paragraph — it reads them as an invented discount. A VML
    // roundrect (arcsize="50%") or a width="100%" shim would trip it, which
    // is one of two reasons this button is not VML. The other is that VML
    // needs a fixed pixel width, and the label is operator-typed.
    expect(html).not.toContain("%");
    expect(html).not.toContain("$");
  });
});

describe("renderCtaButton is a real tap target", () => {
  it("is at least 44px tall", () => {
    const html = renderCtaButton({ label: "Shop now", url: URL });
    const padding = Number(/padding:(\d+)px/.exec(html)?.[1]);
    const lineHeight = Number(/line-height:(\d+)px/.exec(html)?.[1]);
    expect(padding * 2 + lineHeight).toBeGreaterThanOrEqual(44);
  });

  it("cannot push the email wider than the card", () => {
    // A 40-character label with no space in it is one unbreakable word — the
    // admin's cap allows exactly that. Measured in Chromium at 390px before
    // this was added, the anchor grew to 553px and the whole message scrolled
    // sideways. Both properties are needed: word-break wraps the word,
    // max-width stops a wide viewport stretching the pill across the card.
    const html = renderCtaButton({ label: "A".repeat(40), url: URL });
    expect(html).toContain("word-break:break-word");
    expect(html).toContain("max-width:456px");
  });
});

describe("a blank CTA renders no button at all", () => {
  // An operator who clears the button text on an automation means "no button
  // on this one". The old renderLayout got this right by accident (a truthy
  // check); these cases are the ones that were never covered.
  it.each([
    ["both blank", "", ""],
    ["blank label", "", URL],
    ["blank url", "Shop now", ""],
    ["whitespace label", "   ", URL],
    ["whitespace url", "Shop now", "   "],
  ])("renders nothing for %s", (_name, label, url) => {
    expect(renderCtaButton({ label, url })).toBe("");
  });

  it("leaves no empty row in the layout", () => {
    const html = renderLayout({
      preheader: "A preheader",
      titleHtml: "A heading",
      bodyHtml: "<p>Body.</p>",
      ctaLabel: "",
      ctaUrl: "",
    });
    expect(html).not.toContain("border-radius:999px");
    expect(html).not.toContain('align="center" style="padding:28px 32px 4px;"');
  });
});

describe("a malformed CTA cannot break the message", () => {
  it.each([
    ["javascript", "javascript:alert(1)"],
    ["data uri", "data:text/html,<script>alert(1)</script>"],
    ["vbscript", "vbscript:msgbox(1)"],
    ["bare word", "products"],
    ["protocol-relative", "not-a-url"],
  ])("drops a %s destination rather than rendering it", (_name, url) => {
    // These are inert in a mail client. They are NOT inert in the admin
    // preview iframe, in webmail that renders the message in-page, or in a
    // browser opening a saved copy — so they are refused rather than assumed
    // harmless. A row written before cta-path.ts existed can still reach here.
    expect(renderCtaButton({ label: "Click", url })).toBe("");
  });

  it("escapes a label and a destination rather than letting them close the tag", () => {
    const html = renderCtaButton({
      label: '"><script>alert(1)</script>',
      url: 'https://example.com/"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
  });

  it("still renders for a same-site relative destination", () => {
    // Nothing in templates.ts emits one today — every caller resolves to an
    // absolute URL first — but a relative path is well-formed and must not be
    // silently swallowed if one ever arrives.
    expect(renderCtaButton({ label: "Shop", url: "/products" })).toContain('href="/products"');
  });
});
