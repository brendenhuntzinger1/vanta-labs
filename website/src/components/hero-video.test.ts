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

  it("stays invisible until it is genuinely playing", () => {
    // iOS refuses autoplay in Low Power Mode and in some in-app webviews, and
    // paints its OWN play glyph over a paused video — `controls={false}` does
    // not suppress it. Hiding the element until playback starts is what keeps
    // a refused autoplay looking like a still hero instead of a dead player.
    expect(source).toMatch(/opacity:\s*isPlaying\s*\?\s*undefined\s*:\s*0/);
    expect(source).toContain('addEventListener("playing"');
  });

  it("hides itself again if playback stops or errors", () => {
    expect(source).toContain('addEventListener("pause"');
    expect(source).toContain('addEventListener("error"');
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
