import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TITLE_TEMPLATE } from "@/lib/site-identity";

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

  it("puts NO video element on the page at all", () => {
    // The definitive property. On iOS a <video> is not really a page element —
    // it is a request for the system player, which the browser may honour
    // whenever it likes. Four rounds of fixes each removed one route to that
    // decision and each still failed on a phone. A <canvas> has no player, no
    // fullscreen affordance and no native UI; it is a rectangle of pixels.
    expect(source).toContain("<canvas");
    expect(source).toContain('document.createElement("video")');
    // The video is created but NEVER attached, so nothing can present it.
    expect(source).not.toContain("appendChild");
    expect(source).toContain("cover(video, video.videoWidth");
  });

  it("still sets muted and inline before the source on the decoder", () => {
    const inlineAt = source.indexOf('video.setAttribute("playsinline"');
    const mutedAt = source.indexOf("video.muted = true;");
    const srcAt = source.indexOf("video.src = src;");
    expect(mutedAt).toBeGreaterThan(-1);
    expect(inlineAt).toBeGreaterThan(-1);
    expect(mutedAt, "muted must be set before the source").toBeLessThan(srcAt);
    expect(inlineAt, "playsinline must be set before the source").toBeLessThan(srcAt);
  });

  it("never listens for a user gesture in order to start playing", () => {
    // Gesture listeners are what made a tap look like a request to watch the
    // video, which is how iOS came to hand over its fullscreen player.
    for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
      expect(source, `a ${ev} listener would tie playback to a tap again`)
        .not.toContain(`"${ev}"`);
    }
    // Playback comes from the attribute, not from script.
    // A detached element gets no autoplay attribute — playback is started
    // programmatically, which is never a gesture and never a watch request.
    expect(source).toContain("const start = () => {");
    expect(source).toContain("video.play()");
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

  // It no longer sits on top of anything at all. This used to be a bottom-fixed
  // panel that published its own height so bottom bars could move out from
  // under it. Measured across 7 widths x 4 heights on three routes, that panel
  // was covering 140 interactive controls — search, Filters, sort, COA status
  // filters, wishlist buttons — and a tap aimed at any of them landed on Accept
  // or Decline. Shrinking it lowered the count but could never reach zero,
  // because a bottom overlay always covers whatever is at the bottom.
  //
  // So it moved into normal document flow at the top of the page. It takes its
  // own height, pushes content down, and scrolls away. Nothing can be
  // mis-tapped through it, and the height-publishing machinery is gone because
  // there is nothing left to get out of the way of.
  it("is in the document, not fixed over it", () => {
    expect(banner).not.toMatch(/className="fixed[^"]*bottom-/);
    expect(banner).toContain("vl-consent-bar");
  });

  it("no longer needs to publish its height, because nothing must dodge it", () => {
    expect(banner).not.toContain("offsetHeight");
    expect(banner).not.toContain('setAttribute("data-cookie-banner"');
  });

  it("reserves its own space rather than overlapping", () => {
    const rule = css.slice(css.indexOf(".vl-consent-bar {"), css.indexOf(".vl-consent-inner"));
    expect(rule).toMatch(/position:\s*relative/);
    expect(rule).not.toMatch(/position:\s*fixed/);
    // A notch must not eat the first line when this is the topmost element.
    expect(rule).toMatch(/safe-area-inset-top/);
  });

  it("keeps both choices equally weighted", () => {
    // Neither option may be hidden, greyed, or made harder to hit than the
    // other — that is the difference between a consent notice and a nudge.
    expect(banner).toContain(">Decline<");
    expect(banner).toContain(">Accept<");
    const rule = css.slice(css.indexOf(".vl-consent-btn {"), css.indexOf("@media (min-width: 640px)", css.indexOf(".vl-consent-btn {")));
    expect(rule).toMatch(/min-height:\s*2rem/);
  });

  it("still names every pixel that accepting turns on", () => {
    // The substance of the notice. An earlier pass shortened this sentence to
    // save two lines and dropped the platform names; the pixel source tests
    // caught it. Layout does not get to win this one.
    for (const platform of ["TikTok", "Snapchat", "Reddit"]) {
      expect(banner).toContain(platform);
    }
    expect(banner).toContain("/legal/cookies");
  });
});

describe("product pages do not double the brand in their title", () => {
  it("leaves the brand to the root layout's title template", () => {
    const page = read("src/app/products/[slug]/page.tsx");
    const layout = read("src/app/layout.tsx");
    // The layout appends "| Vanta Labs"; the page must not do it as well, or
    // every product page reads "GLP-1 | Vanta Labs | Vanta Labs".
    //
    // Assert the template's VALUE, not its spelling in the source. The literal
    // moved into site-identity.ts when the brand entity was given one home, and
    // a grep for the old inline string failed while the behaviour it guards was
    // completely unchanged. The value is the thing this test actually cares
    // about; the layout still has to wire it through, which is the second half.
    expect(TITLE_TEMPLATE).toBe("%s | Vanta Labs");
    expect(layout).toContain("template: TITLE_TEMPLATE");
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

  // REVERSED DELIBERATELY. This used to require `background-color: #0a0a0a` on
  // the media, to cover the window before the first frame decodes.
  //
  // That premise is gone twice over. There is no <video> in the document to
  // show a stale compositor buffer — it is a <canvas>, which starts fully
  // transparent and is painted from a 36 KB still long before the 460 KB clip
  // arrives. And the media box is now deliberately SMALLER than the hero, so an
  // opaque plate behind it is a second rectangle sitting on the hero's own
  // gradient: the exact defect the rest of this file is now removing.
  it("paints on the hero's ground, not on a plate of its own", () => {
    // Comments in this rule NAME the removed declaration while explaining it.
    expect(heroRule.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/background-color:/);
    // The dark ground still has to come from somewhere. It is the hero's.
    const hero = css.slice(css.indexOf(".vl2-hero {"), css.indexOf(".vl2-hero-video"));
    expect(hero).toMatch(/background:/);
  });

  // NARROWED DELIBERATELY. This used to demand that EVERY stop of the mobile
  // scrim stay at 0.4 or darker, because a full-bleed white-backgrounded clip
  // would otherwise glare through the middle of it.
  //
  // Holding the whole viewport at 42%-to-93% black is also what made the hero
  // read as a dark rectangle with a picture in it, which is half the "black
  // box" complaint. The premise for the blanket floor is gone: the media no
  // longer fills the hero, its own border is black in the file, and the canvas
  // fades it out with real alpha, so nothing bright can reach the top of the
  // section.
  //
  // What the scrim is actually for is holding the copy legible, and that is
  // asserted here instead — on the stops that sit behind the copy rather than
  // on all of them.
  it("keeps the copy end of the mobile scrim dark enough to read on", () => {
    const scrim = css.slice(css.indexOf(".vl2-hero-scrim"), css.indexOf(".vl2-hero-content"));
    const mobile = scrim.slice(0, scrim.indexOf("@media"));
    const stops = [...mobile.matchAll(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)\s+([0-9.]+)%/g)]
      .map((m) => ({ alpha: Number(m[1]), at: Number(m[2]) }));
    expect(stops.length).toBeGreaterThan(2);
    // The copy block is bottom-anchored and roughly the lower half of the hero.
    const overCopy = stops.filter((stop) => stop.at >= 60);
    expect(overCopy.length).toBeGreaterThan(0);
    expect(Math.min(...overCopy.map((stop) => stop.alpha))).toBeGreaterThanOrEqual(0.55);
    // And it must still finish opaque enough for the trust row at the very
    // bottom, which is the smallest, lowest-contrast text in the hero.
    expect(Math.max(...stops.map((stop) => stop.alpha))).toBeGreaterThanOrEqual(0.85);
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
  it("E — decorative: muted, looping, uncontrollable, untappable", () => {
    expect(heroCode).toContain("video.muted = true;");
    expect(heroCode).toContain("video.loop = true;");
    expect(heroCode).toContain("video.controls = false;");
    expect(heroCode).toContain("video.disablePictureInPicture = true;");
    expect(heroCode).toContain('aria-hidden="true"');
    const rule = css.slice(css.indexOf(".vl2-hero-video"), css.indexOf(".vl2-hero-scrim"));
    expect(rule).toMatch(/pointer-events:\s*none/);
  });

  // F. Nothing links to the asset.
  it("F — the asset is a video source and nothing else", () => {
    // One reference, as a src prop. Not an href, not a route.
    expect(page).toMatch(/<HeroVideo className="vl2-hero-video" src="\/videos\/vanta-labs-hero(-opt)?\.mp4" \/>/);
    expect(page).not.toMatch(/href="[^"]*\.mp4/);
    expect(heroCode).not.toMatch(/href=/);
    expect(heroCode).not.toMatch(/<a\b/);
  });

  // The failsafe, which is explicitly not the fix.
  it("needs no fullscreen failsafe, because there is nothing to go fullscreen", () => {
    // The previous build carried a webkitbeginfullscreen handler that tried to
    // back out of the player. It is gone with the element it guarded.
    expect(heroCode).not.toContain("webkitExitFullscreen");
    expect(heroCode).not.toContain("webkitbeginfullscreen");
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

// ---------------------------------------------------------------------------
// THE FALLBACK RULE, set by the owner after five rounds of iOS video fixes:
// if the clip cannot be made to play reliably inside an in-app browser, show a
// clean still hero rather than ever throwing the customer into a fullscreen
// player. A still vial is a product shot.
// ---------------------------------------------------------------------------
describe("the hero fails to a still vial, never to nothing", () => {
  const source = read("src/components/hero-video.tsx");
  const page = read("src/app/page.tsx");

  it("paints a poster frame before any video decoding", () => {
    expect(source).toContain('poster = "/images/hero-vial-poster.jpg"');
    expect(source).toContain("const stillFrame = new Image();");
    expect(source).toContain("stillFrame.src = poster;");
    // Drawn on load, independently of the video.
    expect(source).toMatch(/stillFrame\.onload = \(\) => \{[\s\S]*?cover\(stillFrame/);
  });

  it("leaves the still frame up when nothing has decoded", () => {
    // The paint loop must RETURN rather than paint an empty frame.
    expect(source).toMatch(/if \(video\.readyState < 2 \|\| !video\.videoWidth\) return;/);
  });

  // THIS IS THE ONE THE PREVIOUS BUILD PASSED BY ACCIDENT.
  //
  // That build never cleared the canvas, so a `drawImage(video)` that produced
  // nothing left the poster where it was. Correct behaviour, no reasoning
  // behind it — and the moment a clear became necessary (the canvas carries
  // alpha now, and without a clear the previous frame shows through the new
  // one's faded edges) the accident turned into a blank hero.
  //
  // It is not hypothetical. Measured in WebKit against this very page: the
  // detached element reported readyState 4 and videoWidth 720, was not paused,
  // and every drawImage was a no-op with currentTime frozen at 0. Clear-then-
  // draw in that state paints nothing at all.
  //
  // So the frames are composed in an opaque offscreen buffer that is never
  // cleared, and the visible canvas is repainted from the buffer. A draw that
  // yields nothing leaves the last good picture — the poster, at worst.
  it("composes into a buffer that a dead decoder cannot wipe", () => {
    expect(source).toContain("const picture = document.createElement(\"canvas\");");
    // The buffer is opaque and IS NEVER CLEARED — that is the whole guarantee.
    expect(source).toContain('picture.getContext("2d", { alpha: false })');
    expect(source, "clearing the buffer would reinstate the blank-hero bug")
      .not.toMatch(/pictureContext\.clearRect/);
    // The only clear is on the visible canvas, inside present(), which refuses
    // to run until there is something to present.
    const clears = [...source.matchAll(/\.clearRect\(/g)];
    expect(clears.length, "exactly one clear, on the visible canvas").toBe(1);
    const present = source.slice(source.indexOf("const present = () => {"));
    expect(present.slice(0, 200)).toMatch(/if \(!hasPicture\) return;/);
    expect(present.indexOf("context.clearRect")).toBeLessThan(present.indexOf("context.drawImage(picture"));
  });

  it("stops asking a decoder that has proved it will not deliver", () => {
    // Otherwise a browser in that state repaints one still picture at 60 Hz
    // for as long as the page is open — the battery cost of an animation,
    // without the animation. currentTime advances if and only if frames are
    // being presented, and reading it cannot be refused by an origin rule the
    // way sampling the canvas can.
    expect(source).toContain("video.currentTime !== lastTime");
    expect(source).toMatch(/window\.clearInterval\(liveness\);[\s\S]{0,120}cancelAnimationFrame\(raf\)/);
    // ...and it settles on the still rather than on nothing.
    expect(source).toMatch(/if \(stillReady\) cover\(stillFrame/);
  });

  it("uses the compressed, audio-free clip", () => {
    // 6.4 MB with an audio track became 520 KB without one. An audio track
    // makes iOS treat a video as real media rather than decoration, and the
    // size was what left the hero black on a weak signal.
    expect(page).toContain("/videos/vanta-labs-hero-opt.mp4");
  });
});

// ---------------------------------------------------------------------------
// NO VIDEO AT ALL INSIDE AN APP'S BROWSER.
//
// Five rounds of work could not keep a clip playing inline in the TikTok
// WebView. Each fix was correct and each passed in every engine available
// here; each still ended with an iPhone showing the vial alone on white. So in
// those browsers there is nothing to decode — a still frame is the whole hero.
// ---------------------------------------------------------------------------
describe("an app's browser gets a still hero, never a clip", () => {
  const hero = read("src/components/hero-video.tsx");
  const detect = read("src/lib/in-app-browser.ts");

  // CHANGED FROM <img> TO A STILL-ONLY CANVAS, and the rule it enforces is
  // unchanged: NO VIDEO IS CREATED. The <img> was one way to guarantee that;
  // passing the canvas a null source is another, and it is the better one here
  // because the still then gets the same alpha falloff as the animated hero
  // instead of being a bare rectangle of a white-backgrounded JPEG — which is
  // the white-box report itself, handed straight to the WebViews that produce
  // it. Nothing about the fullscreen-player rule is relaxed: a canvas has no
  // player to hand over, and with src === null no decoder is started at all.
  it("creates no video at all in an in-app browser", () => {
    expect(hero).toContain("detectInAppBrowser");
    // The still-only branch is chosen by data, and it is what suppresses the
    // source. `src={still ? null : src}` is the whole mechanism.
    expect(hero).toMatch(/src=\{still \? null : src\}/);
    // ...and a null source must short-circuit BEFORE the video element exists.
    const nullGuard = hero.indexOf("if (src === null)");
    const createVideo = hero.indexOf('document.createElement("video")');
    expect(nullGuard).toBeGreaterThan(-1);
    expect(nullGuard, "the still-only return must precede any video").toBeLessThan(createVideo);
  });

  it("also stands down for a visitor who asked for reduced motion", () => {
    // A ten-second looping background clip is exactly what the setting is for,
    // and the honest way to honour it is not to fetch or decode it at all.
    expect(hero).toContain('window.matchMedia("(prefers-reduced-motion: reduce)").matches');
  });

  it("keeps the animation everywhere else", () => {
    expect(hero).toContain("return <HeroVialCanvas");
  });

  it("recognises the browsers that actually cause this", () => {
    for (const app of ["tiktok", "musical_ly", "instagram", "fbav", "snapchat"]) {
      expect(detect, `${app} must be treated as an in-app browser`).toContain(`"${app}"`);
    }
    // Compared lower-case, so a capitalised UA still matches.
    expect(detect).toContain("userAgent.toLowerCase()");
  });
});

// ---------------------------------------------------------------------------
// An app's embedded browser gives the page no browser UI worth using: TikTok's
// back arrow leaves the site entirely, and there is no in-page way to retrace a
// step, so a visitor who opens a product can get stuck on it.
// ---------------------------------------------------------------------------
describe("the site carries its own back control", () => {
  const header = read("src/components/site-header-v2.tsx");

  it("offers a back button below lg, where the nav row is hidden", () => {
    expect(header).toContain('aria-label="Go back"');
    expect(header).toContain("router.back()");
    expect(header).toMatch(/lg:hidden/);
  });

  it("shows it only when there is somewhere to go back to", () => {
    // Not on the home page — there, back means leaving the site.
    expect(header).toMatch(/const canGoBack = hasHistory && pathname !== "\/";/);
    expect(header).toContain("window.history.length > 1");
  });

  it("gives it a real tap target", () => {
    expect(header).toMatch(/aria-label="Go back"[\s\S]{0,400}h-11/);
  });
});

// ---------------------------------------------------------------------------
// Reported from a phone, after a link was opened from Snapchat: clearing the
// age gate filled the entire screen with a magnified vial on a white
// background, with the headline landing on top of the vial's own label text.
//
// It was not the native fullscreen player this time -- the class of bug the
// rest of this file guards. It was our own framing.
//
// THE ASSET IS SQUARE AND THE HERO IS PORTRAIT. The clip is 720x720 and the
// poster 960x960; the hero box on a phone is 390x726. `object-fit: cover`
// resolves that by scaling the square to 726x726 -- a 1.86x magnification that
// throws away 46% of the frame's width and blows the vial up past the width of
// the screen. Measured on the harness at 390x844:
//
//     390x726 box -> painted 726x726 -> 46% of the width cropped away
//     375x628 box -> painted 628x628 -> 40% cropped
//    1440x900 box -> painted 1440x1440 -> 0% of the width cropped
//
// The last line is why nobody caught it: on a laptop the composition survives
// intact, so the defect is invisible in exactly the place it gets reviewed.
//
// The fix is to stop cover-cropping a square into a portrait box. Below the
// desktop breakpoint the media gets a SQUARE box in the upper part of the hero
// and the copy sits on the dark ground beneath it.
// ---------------------------------------------------------------------------
describe("the hero vial is framed on a phone, never magnified and cropped", () => {
  const css = read("src/app/globals.css");

  /** The `.vl2-hero-video` rule inside the media query starting at `at`. */
  const ruleIn = (query: string) => {
    for (let at = css.indexOf(query); at !== -1; at = css.indexOf(query, at + 1)) {
      let depth = 0;
      let i = css.indexOf("{", at);
      const open = i;
      for (; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) break;
      }
      const block = css.slice(open + 1, i);
      const sel = block.indexOf(".vl2-hero-video");
      // Several blocks share a breakpoint (the scrim has one too) — take the
      // one that actually styles the media.
      if (sel !== -1) return block.slice(sel, block.indexOf("}", sel));
    }
    return "";
  };

  /** Comments carry prose with colons in it; strip them before matching. */
  const decl = (rule: string, prop: string) =>
    new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m")
      .exec(rule.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1]
      .trim() ?? null;

  // BOTH breakpoints, because the defect is on both — it just changes axis.
  // A phone crops 46% of the WIDTH; a 1440x900 laptop crops 0% of the width
  // and 37% of the HEIGHT, magnifying the frame 1.5x and landing the vial's
  // label behind the headline at full reading size.
  const breakpoints: Array<[string, string]> = [
    ["phones and portrait tablets", "@media (max-width: 1023px)"],
    ["desktop", "@media (min-width: 1024px)"],
  ];

  for (const [label, query] of breakpoints) {
    describe(label, () => {
      const rule = ruleIn(query);

      it("gives the media a square box, so a square asset loses nothing", () => {
        // cover() discards 1 - min(w,h)/max(w,h) of a square source. That is
        // zero only when the box is square, which is the point of the rule.
        const width = decl(rule, "width");
        const height = decl(rule, "height");
        expect(width, `${label}: the hero media must declare a width`).toBeTruthy();
        expect(height, `${label}: ...and a height`).toBeTruthy();
        expect(height).toBe(width);
      });

      it("stops stretching the media across all four edges of the hero", () => {
        // `inset: 0` on the base rule is what ties the box to the hero's own
        // aspect and forces the magnification. Both breakpoints release it.
        expect(rule).toMatch(/inset:\s*auto/);
      });

      // REVERSED DELIBERATELY, AND THIS IS THE BLACK BOX.
      //
      // This used to REQUIRE a `mask-image` here, on the reasoning that a
      // white-backgrounded shot must be faded at its edges rather than cut off
      // at them. The reasoning was right and the mechanism was wrong, in a way
      // that is arithmetic rather than taste.
      //
      // A radial-gradient mask is sized against the element box, so a gradient
      // whose transparent stop lands outside that box is CLIPPED BY IT, and a
      // clipped ellipse is a rectangle with rounded corners. The phone rule
      // read `ellipse 82% 54% at 50% 31% ... transparent 76%`: the transparent
      // stop sat at 0.82 x 0.76 = 62% of the box width from a centre at 50%,
      // i.e. at -12% and 112% of the width. Straight vertical edges, both
      // sides. Vertically it finished at 72%, which is the straight line that
      // cut the vial through its own label. The desktop rule had the same
      // defect down its left side.
      //
      // So no mask, either breakpoint. The falloff is real alpha painted by
      // the canvas (destination-in), which is bounded by construction and does
      // not depend on a compositing feature a WebView may quietly skip.
      it("fades into the hero with alpha, not with a mask that clips to a box", () => {
        expect(rule).not.toMatch(/mask-image:/);
      });
    });
  }

  it("keeps the base rule intact as the fallback both breakpoints override", () => {
    const base = css.slice(css.indexOf(".vl2-hero-video"), css.indexOf(".vl2-hero-scrim"));
    expect(base).toMatch(/object-fit:\s*cover/);
    expect(base).toMatch(/pointer-events:\s*none/);
  });
});

// ---------------------------------------------------------------------------
// THE WHITE BOX, AT ITS SOURCE.
//
// Every "the vial renders with a white box round it" report traces to one fact
// that no amount of CSS could change: THE ASSET IS A WHITE SQUARE WITH A VIAL
// IN THE MIDDLE. It is a high-key product film, lit on a white studio
// backdrop. Measured on the pre-fix file, frame 60 had a median luminance of
// 217/255 and corners between 172 and 200. There is no alpha channel and never
// was one — H.264 cannot carry it — so nothing about the shot is transparent.
//
// What made the page look right was CSS painted OVER it: an opacity, a scrim,
// and latterly a mask. Every one of those is a compositing feature, and every
// rendering path that skips them shows the asset as it is:
//
//   * a WebView that ignores or mis-composites `mask-image`;
//   * iOS's native fullscreen player, which paints no page CSS at all — "the
//     vial alone on white", the exact wording of the reports;
//   * opening the media URL directly.
//
// So the fix is in the pixels. `scripts/build-hero-media.mjs` burns a vignette
// into both files that reaches true black BEFORE the frame border, on every
// side. After it there is no rendering path — no browser, no player, no failed
// mask, no disabled JavaScript — that can put a bright edge on screen, because
// the file no longer contains one.
//
// This is the assertion that would have caught the original bug, and it is the
// only one in this file that reads the shipped bytes rather than the source.
// ---------------------------------------------------------------------------
describe("the shipped hero media cannot show a bright edge", () => {
  const script = read("scripts/build-hero-media.mjs");

  it("fades to black strictly inside the frame, by construction", () => {
    // END at 1.0 is what makes the guarantee total rather than approximate:
    // radius is normalised so an edge midpoint is exactly 1 and a corner is
    // 1.41, so every pixel on the perimeter is at or past the end of the ramp.
    expect(script).toMatch(/^const END = 1(\.0)?;$/m);
    const start = /^const START = ([0-9.]+);$/m.exec(script);
    expect(start, "the ramp must declare where it begins").not.toBeNull();
    expect(Number(start![1])).toBeGreaterThan(0);
    expect(Number(start![1])).toBeLessThan(1);
  });

  it("derives both files from the untouched master, so it cannot double-apply", () => {
    // Re-running must be a no-op, not a second vignette. Reading the shipped
    // poster to make the next poster is how that happens; both outputs come
    // from the master clip instead.
    expect(script).toMatch(/-i", MASTER_VIDEO,[\s\S]*?-i", MASTER_VIDEO,/);
    expect(script).not.toMatch(/"-i", OUT_POSTER/);
    expect(script).not.toMatch(/"-i", OUT_VIDEO/);
  });

  // The bytes themselves. ffmpeg is the only way to decode them here and it is
  // not a dependency of this project, so this measures when it is available and
  // says so when it is not, rather than silently passing.
  const ffmpeg = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  /** Brightest channel found anywhere on the one-pixel border of a frame. */
  const brightestBorder = (file: string, extraFilters: string) => {
    const size = 160;
    const raw = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", file, "-vf", `${extraFilters}scale=${size}:${size}`,
       "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { maxBuffer: 1 << 26 },
    );
    let worst = 0;
    const at = (x: number, y: number) => {
      const i = (y * size + x) * 3;
      worst = Math.max(worst, raw[i], raw[i + 1], raw[i + 2]);
    };
    for (let i = 0; i < size; i++) {
      at(i, 0);
      at(i, size - 1);
      at(0, i);
      at(size - 1, i);
    }
    return worst;
  };

  // 16/255 is the hero's own darkest gradient stop (#0b0b0b is 11). Anything
  // at or below this is indistinguishable from the page it sits on; the file
  // this replaces measured 172-200 in the same places.
  const INDISTINGUISHABLE_FROM_THE_PAGE = 16;

  it.skipIf(!ffmpeg)("the poster's border is black", () => {
    expect(brightestBorder("public/images/hero-vial-poster.jpg", ""))
      .toBeLessThanOrEqual(INDISTINGUISHABLE_FROM_THE_PAGE);
  });

  it.skipIf(!ffmpeg)("every sampled frame of the clip has a black border", () => {
    // Across the whole ten seconds, not just the opening shot: the vial
    // descends into water part-way through and the backdrop changes with it.
    for (const frame of [0, 40, 80, 120, 160, 200, 240]) {
      expect(
        brightestBorder("public/videos/vanta-labs-hero-opt.mp4", `select='eq(n\\,${frame})',`),
        `frame ${frame} of the hero clip has a bright border`,
      ).toBeLessThanOrEqual(INDISTINGUISHABLE_FROM_THE_PAGE);
    }
  });

  it.skipIf(!ffmpeg)("the still and the clip are the same picture", () => {
    // They are painted into the same canvas one after the other, so a mismatch
    // shows up as a jump the moment playback starts.
    const poster = "public/images/hero-vial-poster.jpg";
    const clip = "public/videos/vanta-labs-hero-opt.mp4";
    const grab = (file: string, filters: string) =>
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-vf", `${filters}scale=64:64`, "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { maxBuffer: 1 << 24 },
      );
    const a = grab(poster, "");
    const b = grab(clip, "select='eq(n\\,29)',");
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff / a.length, "the poster is not the clip's frame 29").toBeLessThan(6);
  });
});

// ---------------------------------------------------------------------------
// The falloff that replaced the mask has to be bounded, or it is the same bug
// in a different language: a gradient that wants to finish outside the canvas
// is clipped by the canvas, and a clipped ellipse is a rectangle.
// ---------------------------------------------------------------------------
describe("the canvas falloff is bounded by the element it paints", () => {
  const source = read("src/components/hero-video.tsx");

  it("ends the gradient at the box's own inscribed radius", () => {
    // min(cx, cy) is the distance to the NEAREST edge midpoint, so the ramp is
    // complete before any border pixel on any axis. The corners, further out
    // still, are transparent by definition.
    expect(source).toContain("const outer = Math.min(cx, cy);");
    expect(source).toContain("createRadialGradient(cx, cy, outer * FADE_START, cx, cy, outer)");
    const start = /^const FADE_START = ([0-9.]+);$/m.exec(source);
    expect(start).not.toBeNull();
    expect(Number(start![1])).toBeGreaterThan(0);
    expect(Number(start![1])).toBeLessThan(1);
  });

  it("applies it as alpha on the canvas, not as a CSS mask", () => {
    expect(source).toContain('context.globalCompositeOperation = "destination-in"');
    // An opaque canvas cannot fade into anything, so the VISIBLE canvas must
    // not ask for one. The offscreen buffer is a different matter — it is
    // opaque on purpose, and it is never on screen.
    expect(source).toContain('const context = canvas.getContext("2d");');
    expect(source).not.toMatch(/canvas\.getContext\("2d",\s*\{\s*alpha:\s*false/);
    expect(read("src/app/globals.css")).not.toMatch(/\.vl2-hero-video[\s\S]{0,400}?mask-image:/);
  });
});
