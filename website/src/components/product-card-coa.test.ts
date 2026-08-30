import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasCoa } from "@/lib/coa-url";

const CARD = readFileSync(
  join(process.cwd(), "src/components/product-card.tsx"),
  "utf8",
);

/**
 * Where the COA ANCHOR is, specifically.
 *
 * The two positional assertions below used `indexOf("hasCoa(product.coaUrl)")`
 * as a stand-in for it, which held only while the card had exactly one gated
 * COA element. It has two now — the badge inside the card-wide Link and the
 * action outside it — and the badge comes first, so the proxy silently started
 * describing the wrong element. Anchoring on the `<a href={product.coaUrl}`
 * itself says what these tests actually mean.
 */
const COA_ANCHOR = CARD.indexOf("<a\n            href={product.coaUrl}");

// The COA action is the strongest honest trust signal on a card, which is
// exactly why it must never appear without a document behind it.
describe("the card's COA action", () => {
  it("the anchor this suite is about is findable", () => {
    expect(COA_ANCHOR, "the COA <a href={product.coaUrl}> moved or was reformatted")
      .toBeGreaterThan(-1);
  });

  it("is gated on hasCoa, not on plain truthiness", () => {
    expect(CARD).toContain("hasCoa(product.coaUrl)");
    // `product.coaUrl ? ` guarding a "View COA" action would let " ",
    // "pending" and "TBD" advertise a document that opens nothing.
    expect(CARD).not.toMatch(/\{product\.coaUrl \?\s*\(\s*<a/);
  });

  it("rejects the placeholder values operators actually type", () => {
    for (const junk of [" ", "", "n/a", "N/A", "none", "pending", "TBD", "coming soon", "---"]) {
      expect(hasCoa(junk)).toBe(false);
    }
    expect(hasCoa("javascript:alert(1)")).toBe(false);
    expect(hasCoa("https://example.com/coa/a.pdf")).toBe(true);
  });

  it("opens in a new tab without handing over the opener", () => {
    const anchor = CARD.slice(COA_ANCHOR);
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
  });

  it("sits outside the card-wide Link, so no anchor nests inside another", () => {
    expect(COA_ANCHOR).toBeGreaterThan(CARD.indexOf("</Link>"));
  });

  it("gates the COA BADGE on the same evidence as the COA link", () => {
    // The badge read `{product.coaUrl ? (` — plain truthiness — while the link
    // forty lines below was correctly gated on hasCoa(). So a product whose
    // coaUrl is "pending" wore a badge asserting a document exists and offered
    // nothing to open, on every card in the grid. The assertion above ("not
    // /\{product\.coaUrl \?\s*\(\s*<a/") missed it because the badge is a
    // <span>, not an <a>.
    expect(CARD, "no COA element may be gated on plain truthiness")
      .not.toMatch(/\{product\.coaUrl \?/);
    // Two gated uses now: the badge inside the card Link, the action outside it.
    expect(CARD.match(/hasCoa\(product\.coaUrl\)/g) ?? []).toHaveLength(2);
  });
});
