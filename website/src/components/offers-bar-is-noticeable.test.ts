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

  it("still refuses anything that moves on the default band", () => {
    // The half of the original doctrine that was right, and the half that
    // actually costs battery: a shimmer repaints every frame for as long as
    // the page is open, on exactly the phones this has to stay smooth on.
    //
    // NARROWED, NOT RELAXED. The rule used to cover every line from
    // .vl-offer-bar to the sheet, which now includes the seasonal Americana
    // band and its drifting stripes. The band a shopper sees 360 days a year
    // is still absolutely static — that is what this measures — and the
    // exception the flag takes is fenced by the three tests below it.
    const block = css.slice(css.indexOf(".vl-offer-bar {"), css.indexOf("/* --- THE AMERICANA BAND"));
    expect(block, "no keyframe animation on the default offers bar").not.toMatch(/animation:/);
    expect(block, "no marquee/shimmer/pulse on the default offers bar").not.toMatch(/@keyframes/);
  });

  it("moves only a decorative layer, never the words or the controls", () => {
    // The reason the rule above can be narrowed at all. Text that moves is a
    // marquee; a background that drifts behind stationary text is a texture.
    // If an `animation` ever appears on anything but .vl-offer-flag's own
    // pseudo-element, this is the line that should stop it.
    const animated = [...css.matchAll(/([^\s{}]+(?:::?[\w-]+)?)\s*\{[^}]*animation:\s*vl-flag-drift/g)];
    expect(animated.map((m) => m[1]), "only the flag's own layer may animate")
      .toEqual([".vl-offer-flag::after"]);
  });

  it("stops the drift for anyone who asked for less motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .vl-offer-flag"));
    expect(reduced.slice(0, 400), "the flag must stop under prefers-reduced-motion")
      .toMatch(/animation:\s*none/);
  });

  it("drifts slowly enough that it reads as texture rather than a marquee", () => {
    // SPEED IS THE MEASUREMENT, NOT DURATION, and this test asserted duration
    // until the browser showed why that is not the same thing. The travel was
    // `translate3d(-50%, ...)` — 50% of a layer that is itself 200% of the band
    // — so the distance scaled with the viewport and only the TIME was fixed.
    // Measured on the harness: 9.8px/s at 390px against 36px/s at 1440px, from
    // a rule that looked constant and passed a 40s duration check. Pinning
    // pixels per second is what actually holds the design still.
    const duration = css.match(/animation:\s*vl-flag-drift\s+(\d+)s/);
    expect(duration, "the flag drift must declare a duration").toBeTruthy();

    const travel = driftTravel();
    expect(travel.unit, "travel must be in px — a percentage scales with the viewport")
      .toBe("px");

    const pxPerSecond = travel.value / Number(duration![1]);
    expect(pxPerSecond, "faster than ~12px/s starts reading as a marquee")
      .toBeLessThanOrEqual(12);
    expect(pxPerSecond, "slower than ~4px/s is not worth animating at all")
      .toBeGreaterThanOrEqual(4);
  });

  it("loops without a visible seam, which fixes the travel distance", () => {
    // The stripes repeat every 80px along a 101deg axis, so a horizontal shift
    // of Δx advances the pattern by Δx·sin(101°). Only whole multiples of the
    // period land back on an identical frame; anything else jumps once a cycle.
    const travel = driftTravel().value;
    const period = 80 / Math.sin((101 * Math.PI) / 180);
    const periods = travel / period;
    expect(Math.abs(periods - Math.round(periods)), `${travel}px is ${periods.toFixed(3)} stripe periods, not a whole number`)
      .toBeLessThan(0.01);
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

/** The `to` frame's horizontal travel, read out of the drift keyframes. */
function driftTravel(): { value: number; unit: string } {
  const start = css.indexOf("@keyframes vl-flag-drift");
  expect(start, "globals.css must define the vl-flag-drift keyframes").toBeGreaterThan(-1);
  // Past `from { ... }` to the `to` frame — `[^}]*` cannot cross the closing
  // brace of the first frame, which is why this is sliced rather than matched.
  const block = css.slice(start, css.indexOf("\n}", start));
  const to = block.match(/to\s*\{[^}]*translate3d\(\s*(-?[\d.]+)(px|%)/);
  expect(to, "the drift keyframe must declare its travel").toBeTruthy();
  return { value: Math.abs(Number(to![1])), unit: to![2] };
}

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
function inkOf(selector: string, scope = ".vl-offer-bar"): { ink: number[]; alpha: number } {
  return parseInk(colorDeclaredBy(selector, scope), selector);
}

/**
 * THE INK TOKENS DECLARED BY A BAND, e.g. `--offer-ink-soft: rgba(...)`.
 *
 * The bar's ink moved into custom properties when the Americana theme landed,
 * so that a seasonal band redefines a dozen values instead of overriding a
 * dozen rules. That is good for the CSS and it put this suite one indirection
 * away from the numbers it exists to measure — `color: var(--offer-ink-soft)`
 * told the old regex nothing. Resolving the token is what keeps the test
 * measuring the colour a browser will actually paint.
 */
function tokensIn(scope: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of ruleFor(scope).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(name, value.trim());
  }
  return out;
}

/**
 * The `color` a selector paints, with `var(--x)` followed to its value.
 *
 * A theme's tokens are looked up first and the base bar's second, which is
 * exactly the cascade a browser applies: `.vl-offer-bar--americana` redefines
 * some tokens and inherits the rest from `.vl-offer-bar`.
 */
function colorDeclaredBy(selector: string, scope: string): string {
  const declared = ruleFor(selector).match(/[^-]color:\s*([^;]+);/);
  expect(declared, `${selector} must declare a colour`).toBeTruthy();
  let value = declared![1].trim();

  const scopes = scope === ".vl-offer-bar"
    ? [tokensIn(".vl-offer-bar")]
    : [tokensIn(scope), tokensIn(".vl-offer-bar")];

  // Bounded rather than `while (true)`: a token that resolves to itself is a
  // stylesheet bug, and hanging the suite is a poor way to report one.
  for (let hop = 0; hop < 8; hop += 1) {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (!ref) return value;
    const next = scopes.map((s) => s.get(ref[1])).find(Boolean);
    expect(next, `${scope} or .vl-offer-bar must define ${ref[1]}`).toBeTruthy();
    value = next!.trim();
  }
  throw new Error(`${selector}: ${scope} token chain does not terminate`);
}

function parseInk(value: string, selector: string): { ink: number[]; alpha: number } {
  const rgba = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgba) return { ink: [+rgba[1], +rgba[2], +rgba[3]], alpha: rgba[4] ? Number(rgba[4]) : 1 };
  const solid = value.match(/(#[0-9a-f]{6})/i);
  expect(solid, `${selector} must declare a colour this test can read`).toBeTruthy();
  return { ink: hex(solid![1]), alpha: 1 };
}

/** The darkest and lightest stops of a band's gradient — the two worst cases. */
function gradientStops(rule: string, label: string): number[][] {
  const gradient = rule.match(/background:\s*linear-gradient\(([^)]*)\)/);
  expect(gradient, `${label} must declare a linear-gradient background`).toBeTruthy();
  const stops = (gradient![1].match(/#[0-9a-f]{6}/gi) ?? []).map(hex);
  expect(stops.length, `${label}'s gradient must carry hex stops`).toBeGreaterThan(1);
  return stops.slice().sort((a, b) => luminance(a) - luminance(b));
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
// THE AMERICANA BAND IS HELD TO THE SAME FLOOR AS THE GOLD ONE.
//
// A seasonal theme is the easiest place in a stylesheet to lose accessibility,
// because it is written once, in a hurry, against a deadline nobody controls,
// and looked at on one monitor. It inverts the whole band — ivory ink on navy
// instead of dark ink on gold — so every contrast the gold bar earned has to be
// earned again rather than assumed.
//
// The worst case is the LIGHTEST stop here, not the darkest: light ink loses
// contrast as the ground brightens, which is the mirror of the gold band. The
// stripes add at most 0.14 alpha of #8f2233 and 0.055 of ivory on top of that,
// which moves the ground by a few points either way — the floors below are
// cleared with enough margin to absorb it.
// ---------------------------------------------------------------------------
describe("ivory ink on the Americana band clears AA where the band is lightest", () => {
  const americana = ".vl-offer-bar--americana";
  const lightest = gradientStops(ruleFor(americana), americana).slice(-1)[0];

  const inks: [string, string, number][] = [
    ["headline", ".vl-offer-headline", 4.5],
    ["eyebrow", ".vl-offer-eyebrow", 4.5],
    ["ends label", ".vl-offer-ends", 4.5],
    ["details link", ".vl-offer-link", 4.5],
    ["automatic note", ".vl-offer-auto", 4.5],
    ["dismiss ✕", ".vl-offer-close", 3],
  ];

  for (const [name, selector, floor] of inks) {
    it(`${name} clears ${floor}:1 on the lightest stop`, () => {
      const { ink, alpha } = inkOf(selector, americana);
      expect(contrast(over(ink, alpha, lightest), lightest)).toBeGreaterThanOrEqual(floor);
    });
  }

  it("puts the focus ring back to ivory, which passes on navy", () => {
    // The gold band overrides the shared white ring to dark ink because white
    // fails there. On navy that override would be 1.4:1 — worse than the
    // problem it was written to solve — so the theme has to undo it.
    const ring = tokensIn(americana).get("--offer-focus");
    expect(ring, "the Americana band must redefine --offer-focus").toBeTruthy();
    expect(contrast(parseInk(ring!, "--offer-focus").ink, lightest)).toBeGreaterThanOrEqual(3);
    expect(contrast([20, 17, 10], lightest), "the gold band's dark ring is why")
      .toBeLessThan(3);
  });

  it("inverts the claim pill so its code stays legible on its own fill", () => {
    // The pill is the one control on the band. On gold it is dark-filled with
    // gold text; inverted to an ivory fill, the code has to darken with it or
    // it disappears into its own button.
    const tokens = tokensIn(americana);
    const fill = parseInk(tokens.get("--offer-pill")!, "--offer-pill").ink;
    const code = parseInk(tokens.get("--offer-pill-code")!, "--offer-pill-code").ink;
    expect(contrast(code, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("carries no gold anywhere, which is the whole point of the theme", () => {
    // The brand accent is #c7ae5e and its relatives. This band is the one
    // surface allowed to leave it behind, and "premium, not gold" was the
    // brief — a stray var(--accent-gold) inherited from the base bar would
    // undo it silently.
    const block = css.slice(css.indexOf("/* --- THE AMERICANA BAND"), css.indexOf("/* --- VIEW ALL OFFERS"));
    expect(block, "no gold token may survive into the Americana band").not.toMatch(/accent-gold/);
    expect(block, "no literal brand gold either").not.toMatch(/#c7ae5e|#bd9d52|#e6d296|#cdb264|#b3974a/i);
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
