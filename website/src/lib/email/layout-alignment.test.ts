import { describe, expect, it } from "vitest";

import { renderLayout } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE CALL-TO-ACTION SAT 32 PIXELS LEFT OF EVERYTHING ELSE.
//
// Found by rendering the real templates in Chromium at 390x844 on 2026-09-02,
// which is where most of this store's mail is read. Every text row in
// renderLayout is inset 32px from the card edge; the CTA row was written
// `padding:28px 0 4px` — no horizontal padding at all — so the one element the
// whole email exists to get clicked hung off the left edge, 3px from the border,
// while the heading and body above it lined up neatly.
//
// It is in renderLayout, so it was in all 43 templates: every receipt, every
// shipping update, every ambassador approval and every campaign.
//
// Measured, not eyeballed: heading left = 51px, button left = 19px.
//
// This matters beyond looks. A message that renders like a broken template is
// one a reader is more likely to report, and a spam report costs the sending
// domain far more than a misaligned button costs a campaign.
// ---------------------------------------------------------------------------

/** Horizontal padding from a `padding:` shorthand of 3 or 4 parts. */
function horizontalPadding(style: string): string | null {
  const match = style.match(/padding:\s*([^;"]+)/);
  if (!match) return null;
  const parts = match[1].trim().split(/\s+/);
  // 1 value: all sides. 2: v h. 3: t h b. 4: t r b l.
  if (parts.length === 1) return parts[0];
  return parts[1];
}

const rendered = renderLayout({
  preheader: "A preheader",
  titleHtml: "A heading",
  bodyHtml: "<p>Some body copy.</p>",
  ctaLabel: "Shop the catalog",
  ctaUrl: "https://www.vantalabsresearch.com/products",
});

/** The `<td>` cells of the inner card, in document order. */
const cells = rendered.match(/<td style="[^"]*"/g) ?? [];

describe("renderLayout keeps one left edge", () => {
  it("gives the CTA cell the same horizontal inset as the body copy", () => {
    // Anchored on the button itself, not on a padding value: several cells use
    // a 28px top padding, and matching on that found the header instead.
    const ctaRow = rendered.match(/<td style="([^"]*)"[^>]*>\s*<a href="[^"]*"[^>]*border-radius:999px/);
    expect(ctaRow, "no CTA cell found — has renderLayout changed?").toBeTruthy();
    expect(horizontalPadding(`padding:${(ctaRow as RegExpMatchArray)[1].match(/padding:\s*([^;]+)/)?.[1] ?? ""}`)).toBe("32px");
  });

  it("insets every padded card cell by the same amount", () => {
    // Catches the general form of the bug rather than the one instance of it:
    // any future row added with no horizontal padding fails here.
    const insets = cells
      .map((cell) => horizontalPadding(cell))
      .filter((value): value is string => value !== null)
      // The outer wrapper cell is the page gutter, not a card row.
      .filter((value) => value !== "16px");
    for (const inset of insets) {
      expect(insets, `a card row is inset ${inset} while others are 32px`).toContain("32px");
      expect(inset).not.toBe("0");
    }
  });
});

describe("renderLayout is readable by assistive technology", () => {
  it("declares a document language", () => {
    // Screen readers pick pronunciation from this; with no lang they guess from
    // the user's locale and read English copy in whatever voice that implies.
    expect(rendered).toMatch(/<html[^>]*\slang="en"/);
  });

  it("gives the document a title", () => {
    expect(rendered).toMatch(/<title>[^<]+<\/title>/);
  });
});
