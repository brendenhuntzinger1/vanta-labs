import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasCoa } from "@/lib/coa-url";

const CARD = readFileSync(
  join(process.cwd(), "src/components/product-card.tsx"),
  "utf8",
);

// The COA action is the strongest honest trust signal on a card, which is
// exactly why it must never appear without a document behind it.
describe("the card's COA action", () => {
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
    // The anchor block itself; `coaHref` is declared once at the top of the
    // component (legacy link, else the COA-library record) and used here.
    const anchor = CARD.slice(CARD.indexOf("href={coaHref}"));
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
  });

  it("sits outside the card-wide Link, so no anchor nests inside another", () => {
    expect(CARD.indexOf("href={coaHref}")).toBeGreaterThan(
      CARD.indexOf("</Link>"),
    );
  });
});
