import { describe, expect, it } from "vitest";
import { campaignTemplate } from "@/lib/email/templates";

const BASE = {
  subject: "Restock",
  headline: "Restock is live",
  ctaLabel: "SHOP NOW",
  ctaUrl: "https://vantalabsresearch.com/products",
  postalAddress: "Vanta Labs, 1 Example St, Somewhere ST 00000",
};

const blocksBody = (blocks: unknown) => JSON.stringify(blocks);

// ---------------------------------------------------------------------------
// A BLOCK BODY IS STILL A CAMPAIGN BODY.
//
// Blocks replace the BODY REGION only. The layout, the branded chrome, the CTA
// button, the promo-code panel, the offer terms and the postal footer are the
// template's job and stay exactly where they were — so a block campaign passes
// every standard a hand-written one does, because it goes through the same
// renderLayout call.
//
// STORED IN `body`, WITH NO MIGRATION. That column is `text not null` and a
// block body is still the body; parseBlocks answers null for anything that is
// not a JSON array of known blocks, which makes the discriminator total. A
// plain-text body cannot accidentally be read as blocks — "Hello" is not JSON,
// and "[1,2,3]" is JSON but yields no blocks and falls through to the text path.
// ---------------------------------------------------------------------------

describe("a plain-text body is unchanged", () => {
  it("still renders paragraphs", () => {
    const out = campaignTemplate({ ...BASE, body: "First para.\n\nSecond para." });

    expect(out.html).toContain("First para.");
    expect(out.html).toContain("Second para.");
    expect(out.text).toContain("First para.");
  });

  it("still turns a single newline into a line break", () => {
    const out = campaignTemplate({ ...BASE, body: "Line one\nLine two" });
    expect(out.html).toContain("Line one<br/>Line two");
  });

  it("does not treat a JSON array of non-blocks as blocks", () => {
    const out = campaignTemplate({ ...BASE, body: "[1,2,3]" });
    // Falls through to the text path, so the literal text is what renders.
    expect(out.html).toContain("[1,2,3]");
  });
});

describe("a block body renders as blocks", () => {
  const body = blocksBody([
    { type: "heading", text: "Back in stock" },
    { type: "paragraph", text: "Every batch ships with its COA." },
    { type: "list", items: ["Third-party tested", "Cold-chain shipped"] },
    { type: "button", label: "Browse", url: "https://vantalabsresearch.com/products" },
  ]);

  it("renders each block's content", () => {
    const out = campaignTemplate({ ...BASE, body });

    expect(out.html).toContain("Back in stock");
    expect(out.html).toContain("Every batch ships with its COA.");
    expect(out.html).toContain("Third-party tested");
  });

  it("does not print the raw JSON anywhere", () => {
    const out = campaignTemplate({ ...BASE, body });

    expect(out.html).not.toContain('"type"');
    expect(out.text).not.toContain('"type"');
  });

  it("still goes through renderLayout, so it is branded", () => {
    const out = campaignTemplate({ ...BASE, body });

    expect(out.html).toContain("Vanta Labs");
    expect(out.html).toContain("background:#050505");
  });

  it("still carries the campaign's own CTA button and postal address", () => {
    const out = campaignTemplate({ ...BASE, body });

    expect(out.html).toContain("SHOP NOW");
    expect(out.html).toContain(BASE.ctaUrl);
    expect(out.html).toContain("1 Example St");
  });

  it("ships a plain-text part carrying the block content", () => {
    const out = campaignTemplate({ ...BASE, body });

    expect(out.text).toContain("Back in stock");
    expect(out.text).toContain("Every batch ships with its COA.");
    expect(out.text).toContain("Third-party tested");
  });

  // The standard template-standards.test.ts enforces on every hand-written
  // template. A block body must not be the one that breaks it.
  it("repeats every link from the HTML in the text part", () => {
    const out = campaignTemplate({ ...BASE, body });
    // mailto: is excluded for the same reason template-standards.test.ts
    // excludes it — the footer's support address is not a link anyone needs
    // repeated as a URL in the text part.
    const urls = [...out.html.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => !url.startsWith("mailto:"));

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(out.text).toContain(url);
  });

  it("renders no undefined, NaN or [object Object]", () => {
    const out = campaignTemplate({ ...BASE, body });

    for (const part of [out.html, out.text]) {
      expect(part).not.toContain("undefined");
      expect(part).not.toContain("NaN");
      expect(part).not.toContain("[object Object]");
    }
  });

  it("escapes operator-typed content", () => {
    const out = campaignTemplate({ ...BASE, body: blocksBody([{ type: "paragraph", text: "<script>alert(1)</script>" }]) });

    expect(out.html).not.toContain("<script>alert");
  });
});

describe("a block body still carries the campaign's commercial furniture", () => {
  const body = blocksBody([{ type: "paragraph", text: "Something." }]);

  it("renders the promo code panel", () => {
    const out = campaignTemplate({ ...BASE, body, promoCode: "RESTOCK10" });

    expect(out.html).toContain("RESTOCK10");
    expect(out.text).toContain("RESTOCK10");
  });

  // THE ONE THAT MATTERS COMMERCIALLY. Offer terms are written by the sweep
  // from the offer catalogue, never by the operator, and they state what
  // checkout will actually honour. A body format that dropped them would let an
  // email promise a gift on terms the store does not apply.
  it("renders the offer terms", () => {
    const out = campaignTemplate({ ...BASE, body, offerTerms: "One per customer. Ends Friday." });

    expect(out.html).toContain("One per customer.");
    expect(out.text).toContain("One per customer.");
  });
});

describe("a block body that renders to nothing", () => {
  it("still produces a valid, branded email rather than throwing", () => {
    const out = campaignTemplate({ ...BASE, body: blocksBody([{ type: "carousel" }]) });

    expect(out.html).toContain("Vanta Labs");
    expect(out.html).toContain("SHOP NOW");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE DEFECT THIS FILE EXISTS TO KEEP FIXED.
//
// The first version of the button block took a URL of its own. That produced a
// link AROUND /api/email/click: the click went uncounted, and — the part that
// costs money — the offer cookie that arms a campaign's gift was never set. An
// email could promise a gift and land the customer somewhere the store would
// not apply it. Found by looking at the rendered email, not by a test.
//
// A button block now renders the campaign's own tracked CTA, so there is only
// one destination in the message and it is the one that carries the gift.
// ---------------------------------------------------------------------------

describe("a block button cannot bypass the tracked click route", () => {
  const TRACKED = "https://vantalabsresearch.com/api/email/click?c=camp-1&e=buyer%40x.test&s=abc123";
  const body = JSON.stringify([
    { type: "paragraph", text: "The catalogue is back." },
    { type: "button", label: "BROWSE" },
  ]);

  const unescape = (html: string) => html.replace(/&amp;/g, "&");

  it("renders the block button through the campaign's tracked URL", () => {
    const out = campaignTemplate({ ...BASE, body, ctaUrl: TRACKED });
    expect(unescape(out.html)).toContain(TRACKED);
  });

  it("puts no destination in the email that is not the tracked one", () => {
    const out = campaignTemplate({ ...BASE, body, ctaUrl: TRACKED });

    const destinations = [...out.html.matchAll(/href="([^"]+)"/g)]
      .map((match) => unescape(match[1]))
      .filter((url) => !url.startsWith("mailto:"));

    // Every link in the message is the tracked CTA. A second destination here
    // would be a click nobody counts and, with a gift on the campaign, a
    // promise the checkout does not honour.
    expect(new Set(destinations)).toEqual(new Set([TRACKED]));
  });

  it("ignores a url left on a block body saved before this rule existed", () => {
    const legacy = JSON.stringify([{ type: "button", label: "BROWSE", url: "https://evil.example.com" }]);
    const out = campaignTemplate({ ...BASE, body: legacy, ctaUrl: TRACKED });

    expect(out.html).not.toContain("evil.example.com");
    expect(unescape(out.html)).toContain(TRACKED);
  });
});
