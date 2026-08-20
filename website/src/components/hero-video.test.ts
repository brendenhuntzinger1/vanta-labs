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

  it("sets muted and playsinline BEFORE the source, which is the whole fix", () => {
    // Assigning src is when iOS decides whether a video may play inline. Written
    // as JSX, React applied src second — before muted and playsinline — so iOS
    // classified the hero as media the visitor wanted to watch and took the
    // screen with its own player. Order is explicit now, so this checks it.
    const inlineAt = source.indexOf('video.setAttribute("playsinline"');
    const mutedAt = source.indexOf("video.muted = true;");
    const srcAt = source.indexOf("video.src = src;");
    const appendAt = source.indexOf("host.appendChild(video);");
    expect(mutedAt).toBeGreaterThan(-1);
    expect(inlineAt).toBeGreaterThan(-1);
    expect(srcAt).toBeGreaterThan(-1);
    expect(mutedAt, "muted must be set before the source").toBeLessThan(srcAt);
    expect(inlineAt, "playsinline must be set before the source").toBeLessThan(srcAt);
    expect(srcAt, "the source must be assigned before the element is inserted").toBeLessThan(appendAt);
    // Built by hand precisely so the order cannot be reshuffled by JSX.
    expect(source).toContain('document.createElement("video")');
    // Code only: the comment above the fix quotes the old broken markup as an
    // illustration, and that is not a JSX element.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly, "the element must be built by hand, not as JSX").not.toMatch(/<video\b/);
  });

  it("never listens for a user gesture in order to start playing", () => {
    // Gesture listeners are what made a tap look like a request to watch the
    // video, which is how iOS came to hand over its fullscreen player.
    for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
      expect(source, `a ${ev} listener would tie playback to a tap again`)
        .not.toContain(`"${ev}"`);
    }
    // Playback comes from the attribute, not from script.
    expect(source).toContain('video.setAttribute("autoplay", "")');
    expect(source).toContain("video.muted = true;");
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

// ---------------------------------------------------------------------------
// Reported from a phone: ticking an age-gate checkbox made the hero vial
// appear OVER the gate. Only in TikTok's browser; never in Safari or Chrome.
//
// The tap that ticked the box was also the page's FIRST USER GESTURE, and the
// gesture listeners are bound to `document` — so it started playback behind the
// gate. Chromium keeps a hidden video hidden. WebKit promotes a PLAYING video
// to its own compositing layer, and on iOS that layer paints through an
// ancestor's `visibility: hidden`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reported: entering from TikTok landed "inside the vial video on a white
// background". Nothing navigates to the asset — it appears exactly once in the
// codebase, as this component's src — so that was iOS's NATIVE FULLSCREEN
// PLAYER, whose chrome is light.
//
// Two iOS rules open it, and the entry tap hit both at once: play() called
// synchronously inside a gesture handler reads as "the user asked to watch
// this", and an element with no layout box cannot play inline (behind the gate
// the video is display:none).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE STRUCTURAL SEPARATION.
//
// Completing the age gate on an iPhone, inside the TikTok and Instagram
// browsers, kept opening Apple's native fullscreen player: the vial alone on
// white chrome. Nothing navigated to the asset. iOS was deciding the visitor
// had asked to watch a video, because the entry tap and the video were
// connected — and every attempt to manage that connection with timing passed in
// Chromium and failed on the device.
//
// The connection is now absent rather than managed. A–H below are the
// properties that make it absent; each is one careless edit from returning, and
// none of them shows up in a desktop browser.
// ---------------------------------------------------------------------------
describe("the entry gate and the hero video are separate systems", () => {
  // Comments in these files DESCRIBE the bug — they say "play()",
  // "MutationObserver", "video" and so on while explaining what was removed.
  // Assertions about what the code does must read the code, not the prose.
  const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");

  const hero = read("src/components/hero-video.tsx");
  const heroCode = codeOnly(hero);
  const gateCode = codeOnly(read("src/components/age-gate.tsx"));
  const page = read("src/app/page.tsx");
  const css = read("src/app/globals.css");

  // A. No <video> exists while the gate is active.
  it("A — does not render a video element until access is granted", () => {
    // Not hidden. Absent. An early return before any JSX.
    expect(heroCode).toMatch(/if \(!granted \|\| !settled\) return null;/);
    expect(heroCode).toMatch(/const granted = useAccessGranted\(\);/);
  });

  // D. It mounts only after the gate completes AND in a later task.
  it("D — mounts in a later task, after the entry interaction has finished", () => {
    // setTimeout schedules past the current task, so creating the element is
    // never part of the tap that let the visitor in.
    expect(heroCode).toMatch(/const t = setTimeout\(\(\) => setSettled\(true\), 0\);/);
    expect(heroCode).toMatch(/if \(!granted\) return;/);
  });

  // B + C. Nothing in the entry path can reach the video.
  it("B, C — the gate holds no video reference and cannot call play()", () => {
    for (const forbidden of ["play(", "video", "HTMLMediaElement", "webkitEnterFullscreen", "MutationObserver"]) {
      expect(gateCode, `the entry path must not touch ${forbidden}`)
        .not.toContain(forbidden);
    }
    // It publishes a boolean; the video subscribes. Never the other way round.
    expect(gateCode).toContain("AccessContext.Provider");
    expect(gateCode).toContain("export function useAccessGranted()");
  });

  // G. No entry action can produce a gesture-initiated play().
  it("G — playback is never started from a user gesture", () => {
    for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
      expect(heroCode, `a ${ev} listener re-creates the bug`).not.toContain(`"${ev}"`);
    }
    // And no attribute-watching wake-up either.
    expect(heroCode).not.toContain("MutationObserver");
    expect(heroCode).not.toContain("data-age-verified");
  });

  // E. It stays a decorative, non-interactive, inline background.
  it("E — inline, muted, looping, autoplaying, uncontrollable and untappable", () => {
    expect(heroCode).toContain('video.setAttribute("playsinline", "")');
    expect(heroCode).toContain('video.setAttribute("webkit-playsinline", "true")');
    expect(heroCode).toContain("video.muted = true;");
    expect(heroCode).toContain("video.loop = true;");
    expect(heroCode).toContain("video.controls = false;");
    expect(heroCode).toContain("video.disablePictureInPicture = true;");
    expect(heroCode).toContain('video.setAttribute("aria-hidden", "true")');
    const rule = css.slice(css.indexOf(".vl2-hero-video"), css.indexOf(".vl2-hero-scrim"));
    expect(rule).toMatch(/pointer-events:\s*none/);
  });

  // F. Nothing links to the asset.
  it("F — the asset is a video source and nothing else", () => {
    // One reference, as a src prop. Not an href, not a route.
    expect(page).toContain('<HeroVideo className="vl2-hero-video" src="/videos/vanta-labs-hero.mp4" />');
    expect(page).not.toMatch(/href="[^"]*\.mp4/);
    expect(heroCode).not.toMatch(/href=/);
    expect(heroCode).not.toMatch(/<a\b/);
  });

  // The failsafe, which is explicitly not the fix.
  it("keeps a fullscreen failsafe, while not relying on it", () => {
    expect(hero).toContain('addEventListener("webkitbeginfullscreen"');
    expect(hero).toContain("webkitExitFullscreen");
  });
});

// ---------------------------------------------------------------------------
// A media file is not a landing page.
//
// Opening a .mp4 as a page gives the browser's bare media viewer: the clip on a
// blank white background, no site, no gate. Reported only from TikTok and the
// ad platforms — which is where a destination link is configured, and exactly
// what a link pointing at the hero file (or an old redirect resolving to it)
// produces every time, while typing the domain into Safari looks perfect.
// ---------------------------------------------------------------------------
describe("an ad link cannot land someone inside a media file", () => {
  const mw = read("middleware.ts");

  it("redirects a top-level navigation to a media file to the home page", () => {
    expect(mw).toMatch(/const MEDIA_EXTENSIONS = \/\\\.\(mp4\|webm\|mov/);
    expect(mw).toMatch(/if \(MEDIA_EXTENSIONS\.test\(pathname\) && isTopLevelNavigation\(request\)\)/);
    expect(mw).toMatch(/home\.pathname = "\/";/);
  });

  it("only redirects real page loads, never the hero fetching its source", () => {
    // A <video> requests its source with Sec-Fetch-Dest: video, and range
    // requests are a player pulling bytes. Redirecting either would break the
    // animation this whole exercise exists to protect.
    expect(mw).toMatch(/sec-fetch-dest"\) === "document"/);
    expect(mw).toMatch(/!request\.headers\.get\("range"\)/);
    expect(mw).toMatch(/request\.method === "GET"/);
  });
});
