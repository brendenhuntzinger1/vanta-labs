import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const css = read("src/app/globals.css");
const bar = read("src/components/storefront-offers-bar.tsx");

/** The `.vl-offer-bar { ... }` declaration block, on its own. */
function barRule(): string {
  const start = css.indexOf(".vl-offer-bar {");
  expect(start, "globals.css must still define .vl-offer-bar").toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

// ---------------------------------------------------------------------------
// THE PROMOTION HAS TO BE THE THING YOU SEE FIRST.
//
// The offers bar was built to state an offer "once, quietly, in good type":
// a #0a0a0a ribbon on a #0a0a0a page, 49px tall, with a 16px headline and one
// hairline of gold. Measured on the harness at 390x844, that is a background
// one point away from the page behind it — and the store owner's report was
// "it's kinda hidden up top".
//
// That is not a taste dispute, it is the measurement. A discount nobody
// notices costs the same to honour as one they do. So this file pins the two
// properties that made it invisible, because both are the kind of thing a
// later tidy-up reverts on aesthetic grounds without ever seeing the band on a
// phone.
// ---------------------------------------------------------------------------
describe("the offers bar is louder than the page it sits on", () => {
  it("does not paint itself the near-black of the page behind it", () => {
    const rule = barRule();
    // The specific value that made it disappear. Any near-black ground has the
    // same effect, but this one is the documented regression.
    expect(rule, "#0a0a0a is the page's own ground — the band vanishes into it")
      .not.toMatch(/background:\s*#0a0a0a/);
    expect(rule, "the band needs a fill of its own, not a hairline on black")
      .toMatch(/background:\s*linear-gradient/);
  });

  it("sets the benefit at least half again the body size on a phone", () => {
    const headline = css.slice(css.indexOf(".vl-offer-headline {"));
    const size = headline.match(/font-size:\s*([\d.]+)rem/);
    expect(size, ".vl-offer-headline must set a font-size").toBeTruthy();
    // 1rem — the old value — is body copy. The headline is the offer.
    expect(Number(size![1])).toBeGreaterThanOrEqual(1.25);
  });

  it("keeps the claim control a filled button, not a chip to read", () => {
    const code = css.slice(css.indexOf(".vl-offer-code {"), css.indexOf("}", css.indexOf(".vl-offer-code {")));
    // It fills its slot on a phone, where that slot is most of the second row —
    // measured 279px of 390, against a 32px ✕ beside it.
    expect(code).toMatch(/width:\s*100%/);
    const minHeight = code.match(/min-height:\s*([\d.]+)rem/);
    expect(minHeight, "the claim button must set a min-height").toBeTruthy();
    expect(Number(minHeight![1]), "a thumb target, not a 24px floor").toBeGreaterThanOrEqual(2.5);
  });

  it("still refuses anything that moves", () => {
    // The half of the original doctrine that was right, and the half that
    // actually costs battery: a shimmer repaints every frame for as long as
    // the page is open, on exactly the phones this has to stay smooth on.
    const block = css.slice(css.indexOf(".vl-offer-bar {"), css.indexOf("/* --- VIEW ALL OFFERS"));
    expect(block, "no keyframe animation on the offers bar").not.toMatch(/animation:/);
    expect(block, "no marquee/shimmer/pulse on the offers bar").not.toMatch(/@keyframes/);
  });
});

// ---------------------------------------------------------------------------
// TAPPING "CLAIM" MUST CLAIM, AND DO NOTHING ELSE.
//
// The code button used to be rendered INSIDE the <a> that wraps the offer text
// — invalid HTML (interactive content inside an anchor), and it behaved as
// badly as it reads: the tap copied the code and then bubbled to the anchor,
// so the shopper was navigated to /products mid-tap. Confirmed fixed in the
// browser on 2026-09-02: clicking .vl-offer-code from `/` copies the code and
// leaves location.pathname at `/`.
// ---------------------------------------------------------------------------
describe("the claim control is a button and not a link's passenger", () => {
  it("renders the claim control outside the offer link", () => {
    // The Link renders OfferText only. OfferClaim is its sibling in the row.
    const link = bar.slice(bar.indexOf("<Link href={current.href}"), bar.indexOf("</Link>"));
    expect(link, "a <button> inside an <a> navigates on tap as well as copying")
      .not.toMatch(/OfferClaim/);
    expect(link).toMatch(/OfferText/);
    expect(bar, "the claim control must be its own item in the bar's row")
      .toMatch(/vl-offer-cta[\s\S]{0,200}<OfferClaim/);
  });

  it("says what it does, to a screen reader as well as to an eye", () => {
    expect(bar, 'the visible verb the owner asked for').toMatch(/>Claim</);
    // "Claim" alone would promise more than a clipboard write performs.
    expect(bar, "the accessible name must state that claiming copies the code")
      .toMatch(/aria-label=\{`Claim this offer — copy promo code \$\{offer\.code\} to your clipboard`\}/);
  });

  it("confirms in place rather than through a toast", () => {
    expect(bar).toMatch(/copied \? "Copied" : "Copy"/);
    expect(bar).toMatch(/aria-live="polite"/);
  });
});

// ---------------------------------------------------------------------------
// TAB ORDER FOLLOWS THE DOM. CSS `order` DOES NOT.
//
// The first version of the phone layout set `order: 1/2/3` on
// main/actions/cta, so the ✕ and DETAILS stayed up on the headline's row
// while the claim button dropped below them. It looked right, and it moved
// the focus ring backwards: the DOM runs main -> cta -> actions, so tabbing
// went headline (y=97) -> claim (y=144) -> DETAILS (y=100) -> ✕ (y=100).
// Down the bar, then back up. WCAG 2.4.3 Focus Order, Level A — caught by the
// Vercel review bot on #133, after that PR had already merged.
//
// The fix was to stop needing `order` at all: .vl-offer-main takes the whole
// first line on a phone, and the two controls share the second in the order
// they are written. So the property to pin is not "the layout looks like X",
// it is that the bar reorders NOTHING — that is the thing which cannot be
// reintroduced without the focus ring jumping again.
// ---------------------------------------------------------------------------
describe("the offers bar never reorders itself away from its DOM", () => {
  const block = css.slice(css.indexOf(".vl-offer-bar {"), css.indexOf("/* --- VIEW ALL OFFERS"));

  it("declares no CSS order anywhere in the bar", () => {
    // Comments in this block discuss `order:` by name; strip them first so the
    // history can stay written down without failing the test that records it.
    const declarations = block.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations, "tab order does not follow CSS order — see this block's header")
      .not.toMatch(/(^|[;{\s])order\s*:/);
  });

  it("gets the phone's two rows from the headline's basis instead", () => {
    const main = css.slice(css.indexOf(".vl-offer-main {"), css.indexOf("}", css.indexOf(".vl-offer-main {")));
    // 100% basis = the headline claims the whole first line, so the claim
    // button and the actions wrap onto the second one in source order.
    expect(main).toMatch(/flex:\s*1 1 100%/);
    // ...and from 36rem it gives that up so all three share one row.
    expect(css).toMatch(/@media \(min-width: 36rem\) \{[\s\S]{0,200}?\.vl-offer-main \{ flex: 1 1 10rem; \}/);
  });

  it("keeps the claim control ahead of the dismiss ✕ in the markup", () => {
    // Source order IS tab order here, so this is the assertion that the ring
    // moves forward: claim, then details, then dismiss.
    const inner = bar.slice(bar.indexOf('className="vl-offer-inner"'), bar.indexOf("</section>"));
    expect(inner.indexOf("vl-offer-cta"), "the claim control must come first")
      .toBeLessThan(inner.indexOf("vl-offer-actions"));
  });
});

// ---------------------------------------------------------------------------
// DARK INK ON GOLD, AND IT HAS TO CLEAR AA AT THE BAND'S DARKEST POINT.
//
// The band is a gradient, so "is the text readable" has exactly one honest
// answer: readable against the DARKEST stop, because that is where the worst
// case lands and the gradient's angle moves it under different text at
// different widths. Checking the mid-tone passes labels that fail in the field.
//
// Measured from the rendered PNG at 390px on 2026-09-02, the darkest pixel the
// band paints is rgb(179,151,74) — the #b3974a stop — and every ink used on it
// cleared its floor. This test recomputes that from the CSS so a future tweak
// to either the gradient or an alpha cannot quietly drop one below.
// ---------------------------------------------------------------------------
const srgb = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const luminance = ([r, g, b]: number[]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** How the browser composites a partly transparent ink over the band. */
const over = (ink: number[], alpha: number, ground: number[]) =>
  ink.map((c, i) => alpha * c + (1 - alpha) * ground[i]);

/** The declaration block for a single selector. */
function ruleFor(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `globals.css must define ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

/**
 * THE INK A SELECTOR ACTUALLY DECLARES, read out of the stylesheet.
 *
 * This used to be a hardcoded table of alphas, which made the whole suite a
 * check on arithmetic rather than on the CSS: dropping .vl-offer-eyebrow back
 * to the 0.62 it had before left every contrast test green while the label
 * measured 3.4:1 on the band. Parsing the real declaration is the difference
 * between a test that pins the design and one that pins a comment.
 */
function inkOf(selector: string): { ink: number[]; alpha: number } {
  const rule = ruleFor(selector);
  const rgba = rule.match(/color:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (rgba) return { ink: [+rgba[1], +rgba[2], +rgba[3]], alpha: Number(rgba[4]) };
  const solid = rule.match(/color:\s*(#[0-9a-f]{6})/i);
  expect(solid, `${selector} must declare a colour this test can read`).toBeTruthy();
  return { ink: hex(solid![1]), alpha: 1 };
}

describe("dark ink on the gold band clears AA where the band is darkest", () => {
  const gradient = barRule().match(/background:\s*linear-gradient\(([^)]*)\)/);

  it("the band is a gradient with parseable stops", () => {
    expect(gradient, ".vl-offer-bar must declare a linear-gradient background").toBeTruthy();
  });

  const stops = (gradient?.[1].match(/#[0-9a-f]{6}/gi) ?? []).map(hex);
  const darkest = stops.slice().sort((a, b) => luminance(a) - luminance(b))[0];

  it("finds a darkest stop to measure against", () => {
    expect(stops.length, "the gradient must carry hex stops").toBeGreaterThan(1);
  });

  // selector -> WCAG floor. 4.5:1 is AA for text; 3:1 is AA for a non-text
  // indicator (the ✕ glyph and the focus ring, WCAG 2.2 1.4.11).
  const inks: [string, string, number][] = [
    ["headline", ".vl-offer-headline", 4.5],
    ["eyebrow", ".vl-offer-eyebrow", 4.5],
    ["ends label", ".vl-offer-ends", 4.5],
    ["details link", ".vl-offer-link", 4.5],
    ["dismiss ✕", ".vl-offer-close", 3],
  ];

  for (const [name, selector, floor] of inks) {
    it(`${name} clears ${floor}:1 on the darkest stop`, () => {
      const { ink, alpha } = inkOf(selector);
      expect(contrast(over(ink, alpha, darkest), darkest)).toBeGreaterThanOrEqual(floor);
    });
  }

  it("inverts the focus ring, because the shared white one fails on gold", () => {
    // .vl-focus-ring is `outline: 2px solid rgba(255,255,255,0.86)`, which is
    // 2.2:1 on this band — below the 3:1 floor for a focus indicator.
    expect(css, "the bar must override the shared white focus ring")
      .toMatch(/\.vl-offer-bar \.vl-focus-ring:focus-visible \{[^}]*outline-color/);
    expect(contrast([255, 255, 255], darkest), "white is why the override exists")
      .toBeLessThan(3);
    expect(contrast([20, 17, 10], darkest), "dark ink is what replaces it")
      .toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// THE BAND SHARES THE HEADER'S GUTTER.
//
// `.vl2-nav` runs `mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-12`. The bar ran
// max-width: 80rem with its own padding, which put its first glyph at x=80 on
// a 1440 desktop while the logo and the <h1> both start at x=48. On a
// near-black ribbon that was invisible; on a gold band it is a step in the
// left edge of the page.
// ---------------------------------------------------------------------------
describe("the band lines up with the header above it", () => {
  it("uses the header's measure", () => {
    const inner = css.slice(css.indexOf(".vl-offer-inner {"), css.indexOf("}", css.indexOf(".vl-offer-inner {")));
    expect(inner).toMatch(/max-width:\s*1440px/);
  });

  it("steps its gutter at the header's own breakpoints", () => {
    // px-4 (1rem) -> sm:px-6 (1.5rem, 40rem) -> lg:px-12 (3rem, 64rem).
    expect(barRule()).toMatch(/padding:[^;]*\s1rem\s/);
    expect(css).toMatch(/@media \(min-width: 40rem\) \{\s*\.vl-offer-bar \{[^}]*padding-left:\s*1\.5rem/);
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*\.vl-offer-bar \{[^}]*padding-left:\s*3rem/);
  });
});
