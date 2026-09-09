import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE CYCLE BETWEEN templates.ts AND blocks.ts, AND WHY IT IS ALLOWED.
//
// blocks.ts imports escapeHtml and renderCtaButton from templates.ts; templates.ts
// imports parseBlocks and renderBlocks from blocks.ts. That is a genuine cycle,
// and it is deliberate.
//
// The alternative was to give campaignTemplate optional pre-rendered body
// parts and make each CALLER decide whether the body was blocks. That removes
// the cycle and replaces it with a worse failure: a caller that forgets puts
// the stored JSON into a customer's inbox. The cycle keeps the decision at one
// choke point where it cannot be forgotten.
//
// A cycle is safe exactly while NEITHER module calls the other's imports during
// module initialisation — an ES module in a cycle sees a partially-initialised
// namespace, and a top-level call into it throws. Nothing about that is
// obvious to somebody adding a line to either file, so it is asserted here
// rather than left as folklore.
// ---------------------------------------------------------------------------

describe("the cycle is safe in both directions", () => {
  it("loads when blocks is imported first", async () => {
    const blocks = await import("@/lib/email/blocks");
    const templates = await import("@/lib/email/templates");

    expect(typeof blocks.renderBlocks).toBe("function");
    expect(typeof templates.campaignTemplate).toBe("function");
    // Actually exercise the direction that crosses the cycle: a button block
    // reaches renderCtaButton, which lives in the other module.
    const out = blocks.renderBlocks(
      [{ type: "button", label: "Shop" }],
      { ctaUrl: "https://vantalabsresearch.com/products" },
    );
    expect(out.html).toContain("Shop");
  });

  it("loads when templates is imported first", async () => {
    const templates = await import("@/lib/email/templates");
    const blocks = await import("@/lib/email/blocks");

    // And the other direction: a campaign body reaches parseBlocks/renderBlocks.
    const out = templates.campaignTemplate({
      subject: "s",
      headline: "h",
      body: JSON.stringify([{ type: "paragraph", text: "Body from a block." }]),
      ctaLabel: "GO",
      ctaUrl: "https://vantalabsresearch.com/products",
      postalAddress: "addr",
    });
    expect(out.html).toContain("Body from a block.");
    expect(typeof blocks.parseBlocks).toBe("function");
  });
});

describe("neither module calls across the cycle at module scope", () => {
  const BLOCKS = readFileSync(join(process.cwd(), "src/lib/email/blocks.ts"), "utf8");

  /** Strip everything indented — i.e. everything inside a function body. */
  function topLevelLines(source: string): string[] {
    return source
      .split("\n")
      .filter((line) => line.length > 0 && !/^\s/.test(line) && !line.startsWith("//") && !line.startsWith("*"));
  }

  // The specific hazard: `const X = renderCtaButton(...)` at module scope in
  // blocks.ts would run while templates.ts is still initialising, and throw.
  it("blocks.ts never invokes its templates.ts imports at module scope", () => {
    const offenders = topLevelLines(BLOCKS).filter((line) =>
      /\b(renderCtaButton|escapeHtml)\s*\(/.test(line) && !line.startsWith("import"));

    expect(offenders).toEqual([]);
  });
});
