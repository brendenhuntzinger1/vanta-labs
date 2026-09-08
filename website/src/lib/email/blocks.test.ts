import { describe, expect, it } from "vitest";
import { renderBlocks, parseBlocks, BLOCK_TYPES, type EmailBlock } from "@/lib/email/blocks";

// ---------------------------------------------------------------------------
// BLOCK-COMPOSED CAMPAIGN BODIES.
//
// Writing a campaign meant editing templates.ts — 130KB of TypeScript — and
// shipping a deploy. That is a developer-only workflow for what is a marketing
// task, and it is the single biggest thing an ESP was buying.
//
// The blocks are deliberately few and deliberately dumb. An operator composing
// from seven primitives cannot produce an email that fails template-standards,
// because each primitive already satisfies it. A free-HTML field could, which
// is why there isn't one.
//
// THE STANDARDS THIS MUST NOT BREAK (template-standards.test.ts enforces them
// for the hand-written templates; these tests hold blocks to the same bar):
//   * a plain-text alternative exists
//   * every link in the HTML also appears in the text part
//   * a CTA is a real button, not a naked anchor
//   * nothing renders "undefined", "NaN" or "[object Object]"
// ---------------------------------------------------------------------------

describe("rendering", () => {
  it("renders a heading and a paragraph into both parts", () => {
    const out = renderBlocks([
      { type: "heading", text: "Restock is live" },
      { type: "paragraph", text: "The full catalogue is back." },
    ]);

    expect(out.html).toContain("Restock is live");
    expect(out.html).toContain("The full catalogue is back.");
    expect(out.text).toContain("Restock is live");
    expect(out.text).toContain("The full catalogue is back.");
  });

  it("renders a button as a real button rather than a naked anchor", () => {
    const out = renderBlocks([{ type: "button", label: "Browse the catalog", url: "https://vantalabsresearch.com/products" }]);

    // renderCtaButton's table wrapper is what template-standards uses to tell a
    // real CTA from a bare <a>. Reusing it means blocks pass the same check.
    expect(out.html).toContain("<table");
    expect(out.html).toContain("Browse the catalog");
  });

  // THE STANDARD MOST EASILY BROKEN BY A BLOCK EDITOR. A link that exists only
  // in the HTML is invisible to anyone reading the plain-text part.
  it("repeats every link from the HTML in the text part", () => {
    const out = renderBlocks([
      { type: "button", label: "Shop", url: "https://vantalabsresearch.com/products" },
      { type: "paragraph", text: "Questions? Reply to this email." },
    ]);

    const urls = [...out.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(out.text).toContain(url);
  });

  it("renders a bulleted list in both parts", () => {
    const out = renderBlocks([{ type: "list", items: ["COA on every batch", "Cold-chain shipping"] }]);

    expect(out.html).toContain("COA on every batch");
    expect(out.text).toContain("COA on every batch");
    expect(out.text).toContain("Cold-chain shipping");
  });

  it("renders an image with its alt text", () => {
    const out = renderBlocks([{ type: "image", url: "https://vantalabsresearch.com/a.png", alt: "A vial" }]);

    expect(out.html).toContain('alt="A vial"');
    // Most clients block images by default, so the alt text is the message for
    // a large share of recipients and belongs in the text part too.
    expect(out.text).toContain("A vial");
  });

  it("renders dividers and spacers without emitting text noise", () => {
    const out = renderBlocks([{ type: "divider" }, { type: "spacer" }]);

    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.trim()).toBe("");
  });

  it("lists the block types the editor may offer", () => {
    expect(BLOCK_TYPES).toContain("heading");
    expect(BLOCK_TYPES).toContain("button");
    expect(BLOCK_TYPES).toContain("paragraph");
  });
});

describe("operator-typed content cannot become markup", () => {
  it("escapes HTML in a paragraph", () => {
    const out = renderBlocks([{ type: "paragraph", text: '<script>alert(1)</script>' }]);

    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("escapes HTML in a heading, a list item and an alt text", () => {
    const out = renderBlocks([
      { type: "heading", text: "<img src=x onerror=1>" },
      { type: "list", items: ["<b>bold</b>"] },
      { type: "image", url: "https://vantalabsresearch.com/a.png", alt: '"><script>' },
    ]);

    expect(out.html).not.toContain("<img src=x");
    expect(out.html).not.toContain("<b>bold</b>");
    expect(out.html).not.toContain('"><script>');
  });

  // A javascript: URL in a button is the one that actually reaches a customer.
  it("drops a button whose URL is not a real web address", () => {
    const out = renderBlocks([{ type: "button", label: "Click", url: "javascript:alert(1)" }]);

    expect(out.html).not.toContain("javascript:");
  });
});

describe("nothing renders as a broken value", () => {
  it.each([
    ["a heading with no text", { type: "heading" }],
    ["a paragraph with no text", { type: "paragraph" }],
    ["a button with no label", { type: "button", url: "https://vantalabsresearch.com" }],
    ["a list with no items", { type: "list" }],
    ["an image with no url", { type: "image", alt: "x" }],
    ["an unknown block type", { type: "carousel", slides: 3 }],
  ])("skips %s rather than rendering a broken one", (_label, block) => {
    const out = renderBlocks([block as EmailBlock, { type: "paragraph", text: "Still here." }]);

    expect(out.html).not.toContain("undefined");
    expect(out.html).not.toContain("NaN");
    expect(out.html).not.toContain("[object Object]");
    expect(out.text).not.toContain("undefined");
    // The valid block beside it still renders — one bad block is not a dead email.
    expect(out.html).toContain("Still here.");
  });

  it("renders an empty body for an empty block list rather than throwing", () => {
    expect(renderBlocks([]).html).toBe("");
    expect(renderBlocks([]).text).toBe("");
  });

  // An image with no alt is not skipped — it is rendered with empty alt, which
  // is the correct treatment for a decorative image and is what a screen reader
  // expects. Skipping it would silently drop artwork the operator placed.
  it("renders an image with no alt as decorative rather than dropping it", () => {
    const out = renderBlocks([{ type: "image", url: "https://vantalabsresearch.com/a.png" } as EmailBlock]);

    expect(out.html).toContain('alt=""');
  });
});

describe("parseBlocks", () => {
  it("accepts a well-formed list", () => {
    const parsed = parseBlocks([{ type: "heading", text: "Hi" }, { type: "paragraph", text: "There" }]);
    expect(parsed).toHaveLength(2);
  });

  it("accepts a JSON string", () => {
    expect(parseBlocks('[{"type":"heading","text":"Hi"}]')).toHaveLength(1);
  });

  it("drops blocks it does not recognise instead of failing the whole body", () => {
    const parsed = parseBlocks([{ type: "heading", text: "Hi" }, { type: "carousel" }]);
    expect(parsed).toHaveLength(1);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["not an array", { type: "heading" }],
    ["null", null],
  ])("returns null for %s", (_label, input) => {
    expect(parseBlocks(input)).toBeNull();
  });

  it("caps the number of blocks so one body cannot be unbounded", () => {
    const many = Array.from({ length: 500 }, () => ({ type: "paragraph", text: "x" }));
    expect(parseBlocks(many)?.length).toBeLessThanOrEqual(100);
  });
});
