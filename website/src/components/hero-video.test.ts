import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// These guard a bug reported from a real phone: a visitor opened the site from
// the Instagram bio link, cleared the age gate, and landed on a still hero vial
// with a play button stamped on it — then tapped "Shop the catalog" and nothing
// happened.
//
// Two separate causes, both asserted here because both are one careless edit
// away from returning and neither shows up in a desktop browser.
// ---------------------------------------------------------------------------

describe("the hero video can never present itself as a broken embed", () => {
  const source = read("src/components/hero-video.tsx");
  const css = read("src/app/globals.css");

  // REVERSED DELIBERATELY. This used to require the opposite: the element hid
  // itself until the "playing" event fired, so that a refused autoplay could
  // not show a paused frame with iOS's play glyph on it.
  //
  // On a real phone that produced a worse bug than the one it prevented. In an
  // in-app browser, on a weak signal, or simply before the first frame had
  // decoded, the hero was BLACK — the vial, which is the entire hero, was gone.
  // The owner reported exactly that. A still vial is a product shot; an empty
  // black panel is a broken page.
  it("is always on screen, never hidden by playback state", () => {
    expect(source).not.toMatch(/opacity:\s*isPlaying/);
    expect(source).not.toMatch(/setIsPlaying/);
    expect(source).not.toMatch(/style=\{\{\s*opacity/);
  });

  it("keeps asking to play so a deferred autoplay eventually starts", () => {
    // iOS defers autoplay until a gesture rather than refusing outright, so the
    // vial starts spinning on the visitor's first tap or scroll.
    expect(source).toContain('addEventListener("pause"');
    for (const ev of ["pointerdown", "touchstart", "click", "keydown", "scroll"]) {
      expect(source).toContain(`"${ev}"`);
    }
  });

  it("cannot be tapped, so it can never open the native fullscreen player", () => {
    const rule = css.slice(css.indexOf(".vl2-hero-video"), css.indexOf(".vl2-hero-scrim"));
    expect(rule).toMatch(/pointer-events:\s*none/);
  });

  it("keeps a background on the hero for when no video is showing", () => {
    const rule = css.slice(css.indexOf(".vl2-hero {"), css.indexOf(".vl2-hero-video"));
    expect(rule).toMatch(/background:/);
  });
});

describe("the cookie banner never sits on top of what a visitor must tap", () => {
  const banner = read("src/components/cookie-consent.tsx");
  const css = read("src/app/globals.css");

  it("measures and publishes its own height", () => {
    // Assumed heights are wrong the moment the copy wraps differently, which it
    // does at every viewport width.
    expect(banner).toContain("--cookie-banner-height");
    expect(banner).toContain("offsetHeight");
    expect(banner).toContain('setAttribute("data-cookie-banner"');
  });

  it("clears the flag again once dismissed", () => {
    expect(banner).toContain('removeAttribute("data-cookie-banner")');
    expect(banner).toContain('removeProperty("--cookie-banner-height")');
  });

  it("is no longer lifted above the sticky bottom bars", () => {
    // The old `max-lg:bottom-24` pushed it 6rem up the screen, straight over
    // the homepage hero's CTA cluster. The persistent bars move for it now.
    expect(banner).not.toContain("max-lg:bottom-24");
  });

  it("gives the page room to scroll clear of it", () => {
    expect(css).toMatch(/body\[data-cookie-banner="true"\]\s*\{[^}]*padding-bottom/);
  });

  it("lifts the persistent bottom bars instead of covering them", () => {
    expect(css).toMatch(/body\[data-cookie-banner="true"\]\s*\.vl-bottom-bar\s*\{[^}]*bottom/);
  });

  it("the cart drawer's pay bar gets out of the way too", () => {
    // The drawer's pay bar is NOT fixed — it is the last flex child of a
    // full-height drawer panel — so the .vl-bottom-bar `bottom` shift cannot
    // move it. Below sm that panel fills the viewport, putting "Proceed to
    // checkout" under the consent banner with no way to scroll it clear: a
    // dead checkout button on a phone. It gets padding instead.
    expect(read("src/components/cart-drawer.tsx")).toContain("vl-drawer-paybar");
    expect(css).toMatch(/body\[data-cookie-banner="true"\]\s*\.vl-drawer-paybar\s*\{[^}]*padding-bottom/);
    // Scoped to the small screens where the collision actually happens; above
    // sm the panel is inset (sm:my-4 sm:mr-4) and the two never meet.
    const idx = css.indexOf(".vl-drawer-paybar");
    expect(css.slice(Math.max(0, idx - 400), idx)).toMatch(/@media \(max-width: 639px\)/);
  });

  it("every fixed bottom-anchored bar opts into that lift", () => {
    // A new bar that forgets the class gets silently buried under the banner.
    const files = [
      "src/components/product-detail-client.tsx",
      "src/components/account-dashboard-nav.tsx",
      "src/app/checkout/page.tsx",
      "src/app/layout.tsx",
    ];
    for (const file of files) {
      const contents = read(file);
      const bars = contents.match(/className="[^"]*fixed[^"]*bottom-[^"]*"/g) ?? [];
      for (const bar of bars) {
        expect(bar, `${file}: a fixed bottom-anchored element must carry vl-bottom-bar — ${bar}`)
          .toContain("vl-bottom-bar");
      }
    }
  });
});

describe("product pages do not double the brand in their title", () => {
  it("leaves the brand to the root layout's title template", () => {
    const page = read("src/app/products/[slug]/page.tsx");
    const layout = read("src/app/layout.tsx");
    // The layout appends "| Vanta Labs"; the page must not do it as well, or
    // every product page reads "GLP-1 | Vanta Labs | Vanta Labs".
    expect(layout).toContain('template: "%s | Vanta Labs"');
    expect(page).toContain("const title = product.seoTitle ?? product.name;");
    // Social cards bypass the template, so they still carry the brand — but
    // only when it is not already there.
    expect(page).toMatch(/socialTitle\s*=\s*\/vanta labs\/i\.test\(title\)/);
  });
});

// ---------------------------------------------------------------------------
// From a phone, after entering as a guest: a light grey band washed over half
// the hero. Two causes, both here.
// ---------------------------------------------------------------------------
describe("the hero can never wash out light", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const heroRule = css.slice(css.indexOf(".vl2-hero-video"), css.indexOf(".vl2-hero-scrim"));

  it("the video paints on its own dark ground before any frame decodes", () => {
    // A <video> with nothing decoded yet shows whatever the compositor holds.
    // The file is 6.4 MB, so that window always exists.
    expect(heroRule).toMatch(/background-color:\s*#0a0a0a/);
  });

  it("the mobile scrim never falls close to transparent", () => {
    // Its middle stop used to drop to 0.18, which a bright stretch of video
    // glared straight through.
    const scrim = css.slice(css.indexOf(".vl2-hero-scrim"), css.indexOf(".vl2-hero-content"));
    const mobile = scrim.slice(0, scrim.indexOf("@media"));
    const alphas = [...mobile.matchAll(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)/g)].map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(0);
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.4);
  });
});

// ---------------------------------------------------------------------------
// The gate must cover the VISUAL viewport. `fixed inset-0` sizes against the
// layout viewport, and an in-app webview's toolbar collapses as you interact —
// growing the visual viewport past the overlay and exposing a strip of the
// storefront underneath.
// ---------------------------------------------------------------------------
describe("the gate covers a viewport that changes size", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("sizes itself in dvh, with a vh fallback", () => {
    // Anchored to the start of a line so this finds the standalone rule rather
    // than the `html[data-age-verified="true"] [data-age-gate]` one above it.
    const rule = css.slice(css.indexOf("\n[data-age-gate] {") + 1);
    expect(rule.slice(0, 120)).toMatch(/min-height:\s*100vh/);
    expect(rule.slice(0, 120)).toMatch(/min-height:\s*100dvh/);
  });
});
