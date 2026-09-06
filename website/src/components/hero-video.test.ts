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
// THE HERO VIDEO NEVER STARTS FROM A TAP.
//
// Reported from a phone: ticking a checkbox on the old entry overlay started
// hero playback, and iOS answered by handing the visitor its native fullscreen
// player over the whole site. The overlay that produced that tap is gone —
// there is one access screen now and it is a page, not a layer over the
// storefront — so the specific interaction cannot recur.
//
// What must not come back is the shape of the bug: a video that any gesture
// can wake. The assertions below that had the overlay as their subject are
// removed with it; every one whose subject is the VIDEO is kept, because the
// hazard they describe is a property of the video and outlives the gate.
// ---------------------------------------------------------------------------
describe("the hero video cannot be woken by a gesture", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  // Assertions about what the code does must read the code, not the prose.
  const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");

  const heroCode = codeOnly(read("src/components/hero-video.tsx"));

  // A. The element does not exist until the deferral has settled. Absent, not
  //    hidden — an early return before any JSX.
  it("A — renders no video element until it has settled", () => {
    expect(heroCode).toMatch(/if \(!settled\) return null;/);
  });

  // D. Creating it is a LATER TASK, so it can never be part of whatever
  //    interaction brought the visitor here.
  it("D — mounts in a later task, never inside the current one", () => {
    expect(heroCode).toMatch(/const t = setTimeout\(\(\) => setSettled\(true\), 0\);/);
  });

  // G. No gesture listener, and no attribute-watching wake-up either.
  it("G — playback is never started from a user gesture", () => {
    for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
      expect(heroCode, `a ${ev} listener re-creates the bug`).not.toContain(`"${ev}"`);
    }
    expect(heroCode).not.toContain("MutationObserver");
  });

  // The hero must not reach for the retired gate in any form.
  it("holds no dependency on the removed access overlay", () => {
    for (const gone of ["useAccessGranted", "age-gate", "data-age-verified", "granted"]) {
      expect(heroCode, `hero-video still references ${gone}`).not.toContain(gone);
    }
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

  it("redirects a top-level navigation to a media file back into the store", () => {
    expect(mw).toMatch(/const MEDIA_EXTENSIONS = \/\\\.\(mp4\|webm\|mov/);
    expect(mw).toMatch(/if \(MEDIA_EXTENSIONS\.test\(pathname\) && isTopLevelNavigation\(request\)\)/);
    // The home page, unless the browser asking is one that is not sent the home
    // page at all — this correction was written for TikTok ad links, so it is
    // largely their redirect, and routing them via "/" would spend an extra
    // round trip arriving somewhere they are immediately moved off again. Both
    // destinations are exercised for real in src/lib/in-app-home-skip.test.ts;
    // what matters here is only that neither of them is the media file.
    expect(mw).toMatch(/landing\.pathname = homePageReplacement\(request\) \?\? "\/";/);
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
    // source. `still` must be tested FIRST, ahead of which cut of the film this
    // screen would otherwise get, or a phone in an in-app browser would fetch a
    // clip to decode after all.
    expect(hero).toMatch(/src=\{still \? null : phone \? phoneSrc : src\}/);
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
    expect(hero).toContain("<HeroVialCanvas");
    // And the poster follows the clip, so the still a visitor sees is always
    // the opening frame of the film they would have been played.
    expect(hero).toMatch(/poster=\{phone \? phonePoster : poster\}/);
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
// THE CROP IS BACK, ON PURPOSE, AND THIS BLOCK USED TO FORBID IT.
//
// It was written for the fix to a Snapchat report: clearing the age gate filled
// the entire screen with a magnified vial on a white background. The asset is
// square (720x720) and the hero is portrait, so `object-fit: cover` scaled it to
// 726x726 in a 390-wide box and threw away 46% of its width, leaving the bright
// middle of a white studio frame running edge to edge. The answer at the time
// was to stop cropping: a square media box, sized and positioned, masked at its
// edges.
//
// That answer solved the report and cost the thing the hero was for. In the
// store owner's words the boxed version was "a vial sitting in a random dark
// rectangle", and what they asked for back was "the spinning vial taking up the
// screen — it was very aesthetic". So the composition is full bleed again, and
// these tests now guard the DEFENCE rather than the layout, because the layout
// was never what made it safe.
//
// Three things stand between full bleed and that report, and each is asserted
// below:
//
//   1. The falloff is computed on the ELEMENT, in screen space, by the canvas —
//      so the crop cannot discard it (see the block above). This is the one
//      that actually answers the report.
//   2. The media file's own border is black, so any path that renders it with
//      no page CSS at all — iOS's fullscreen player, the URL opened directly —
//      is on-brand rather than white.
//   3. The scrim holds the copy against the picture it now sits on, which is
//      the OTHER half of the original report: "the headline landing on top of
//      the vial's own label text".
// ---------------------------------------------------------------------------
describe("the hero fills the screen, and cannot show a white one", () => {
  const css = read("src/app/globals.css");
  const source = read("src/components/hero-video.tsx");
  const base = css.slice(css.indexOf(".vl2-hero-video {"), css.indexOf(".vl2-hero-scrim"));
  const code = base.replace(/\/\*[\s\S]*?\*\//g, "");

  it("gives the media the whole hero", () => {
    expect(code).toMatch(/inset:\s*0/);
    expect(code).toMatch(/width:\s*100%/);
    expect(code).toMatch(/height:\s*100%/);
    expect(code).toMatch(/object-fit:\s*cover/);
  });

  it("no longer sizes or positions a box, at either breakpoint", () => {
    // A width on the media is the signature of the boxed layout. Its absence is
    // what makes this full bleed rather than a large rectangle.
    for (const query of ["@media (max-width: 1023px)", "@media (min-width: 1024px)"]) {
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
        if (sel === -1) continue;
        const rule = block.slice(sel, block.indexOf("}", sel)).replace(/\/\*[\s\S]*?\*\//g, "");
        expect(rule, `${query} must not re-introduce a media box`).not.toMatch(/(^|[;{\s])width\s*:/);
        expect(rule, `${query} must not re-introduce a media box`).not.toMatch(/--vial-size/);
        expect(rule, `${query} must not re-introduce a mask`).not.toMatch(/mask-image:/);
      }
    }
  });

  it("keeps the copy readable on the picture it now sits on", () => {
    // Full bleed means the copy is ON the photograph, and the part it lands on
    // is the vial's printed label — black on white, at roughly the size of the
    // headline. Measured with the copy hidden: the brightest pixel behind the
    // headline is 43/255 on a phone, 41 on an SE, 107 on a portrait tablet and
    // 82 at 1440; white type needs 118 or below for 4.5:1. The stops that buy
    // that are these.
    const scrim = css.slice(css.indexOf(".vl2-hero-scrim {"), css.indexOf(".vl2-hero-content {"));
    const phone = scrim.slice(0, scrim.indexOf("@media"));
    const alphas = [...phone.matchAll(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)/g)].map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(3);
    expect(Math.max(...alphas), "the copy end of the phone scrim").toBeGreaterThanOrEqual(0.9);
    // Anchored to the copy, not to a fraction of a hero whose height varies by
    // 150px between an SE and a 14.
    expect(phone).toMatch(/calc\(100% - \d+rem\)/);
    // Every breakpoint has to answer for itself; a tall portrait tablet cannot
    // use the phone's rem stops, and a wide screen lifts from the side instead.
    expect(scrim).toContain("@media (min-width: 641px) and (max-width: 1023px)");
    expect(scrim).toContain("@media (min-width: 1024px)");
  });

  // -------------------------------------------------------------------------
  // AND THE PICTURE ABOVE THE COPY MUST NOT PAY FOR IT.
  //
  // The rule above only says the copy end is dark enough, and on its own that
  // is exactly half a requirement — every stop could be 0.9 and it would still
  // pass. It nearly was: the phone scrim reached 0.68 four rem ABOVE the first
  // line of copy and ran to 0.97, the media carried a flat 0.9 opacity, and the
  // canvas began dissolving the shot at 0.55 of the way out. Three layers, none
  // of them wrong on its own, and together they took the vial's body, shoulder
  // and whole lit halo down with the label.
  //
  // What the owner saw was a black hero, and the numbers agreed: with the copy
  // hidden, the top 55% of the section averaged 23/255 on a phone and 14 on an
  // SE. The store's front page is a lit product shot; that is not one.
  //
  // Measured after, same method, same viewports: 54 and 27, with every headline
  // ground still inside the 118 budget above. The picture roughly doubled and
  // the copy did not move.
  //
  // These pin the three layers so none of them can quietly take it back.
  // -------------------------------------------------------------------------
  it("gives the shot its full strength, at every breakpoint", () => {
    // A flat opacity dims the WHOLE frame, including everything no type will
    // ever sit on, so it can never be the right tool for legibility — that is
    // the scrim's job, and the scrim is anchored to the copy.
    for (const [start, end] of [
      [".vl2-hero-video {", ".vl2-hero-scrim"],
      ["@media (max-width: 1023px)", ".vl2-hero-content"],
      ["@media (min-width: 1024px)", ".vl2-hero-content"],
    ]) {
      const from = css.indexOf(start);
      if (from === -1) continue;
      const block = css.slice(from, css.indexOf(end, from)).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, value] of block.matchAll(/opacity:\s*([0-9.]+)/g)) {
        expect(Number(value), `the hero media is dimmed to ${value} in "${start}"`).toBe(1);
      }
    }
  });

  it("leaves the picture above the copy essentially clear", () => {
    const scrim = css.slice(css.indexOf(".vl2-hero-scrim {"), css.indexOf(".vl2-hero-content {"));
    const phone = scrim.slice(0, scrim.indexOf("@media"));
    // The copy block is ~29rem tall, bottom-anchored, on every phone. Any stop
    // anchored FURTHER from the bottom than that is above the first line of
    // copy, and nothing up there is holding any type legible.
    const aboveCopy = [...phone.matchAll(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)\s+calc\(100% - ([0-9.]+)rem\)/g)]
      .map((m) => ({ alpha: Number(m[1]), rem: Number(m[2]) }))
      .filter((stop) => stop.rem > 30);
    expect(aboveCopy.length, "the phone scrim must stay clear above the copy").toBeGreaterThan(0);
    for (const stop of aboveCopy) {
      expect(stop.alpha, `${stop.rem}rem from the bottom is above the copy`).toBeLessThanOrEqual(0.15);
    }
    // The very top too, which is stated as a percentage rather than in rem.
    const top = [...phone.matchAll(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)\s+([0-9.]+)%/g)]
      .map((m) => ({ alpha: Number(m[1]), at: Number(m[2]) }))
      .filter((stop) => stop.at <= 20);
    for (const stop of top) {
      expect(stop.alpha, `${stop.at}% down is nowhere near the copy`).toBeLessThanOrEqual(0.15);
    }
  });

  // -------------------------------------------------------------------------
  // THE FALLOFF IS NEEDED ON ONE AXIS, AND WAS BEING SPENT ON TWO.
  //
  // It exists for one measured reason: the asset is a vial lit on a WHITE
  // studio backdrop, and a portrait crop of a square frame cuts through that
  // backdrop. Drawn into a 390x726 phone hero with no falloff at all, the left
  // and right edges measure 241/255 down the middle of the screen — white bands
  // running the height of the page. That is the "vial on a white background"
  // report and it is real.
  //
  // The top and bottom are not that, and the inscribed ellipse treated them as
  // if they were. Same crop, same method: top edge 0, bottom edge 0. The
  // vignette burnt into the file already finishes those two, so fading them
  // cost picture and bought nothing — and it is half of why the owner reported
  // the hero as "black all around".
  //
  // Pushing the fade's vertical axis outside the box leaves a falloff that is
  // horizontal across the middle and only rounds the corners. Measured at
  // 390x844 with the copy hidden: mean luminance 34 -> 43, the band above the
  // copy 49 -> 73, and the left and right edges still 10/255.
  //
  // A laptop needs none of it — its crop measures 0 on all four edges — so the
  // value is published per breakpoint from CSS rather than fixed in the script.
  // -------------------------------------------------------------------------
  describe("the falloff spends itself on the axis that needs it", () => {
    it("publishes the reach from CSS, per breakpoint", () => {
      expect(source).toContain('const FADE_REACH_PROPERTY = "--hero-fade-reach";');
      expect(source).toContain("getPropertyValue(FADE_REACH_PROPERTY)");
      expect(source).toContain("context.scale(cw / 2, (ch / 2) * fadeReach);");
    });

    it("reaches past the box on a phone, and leaves a laptop untouched", () => {
      const rule = css.slice(css.indexOf(".vl2-hero-video {"), css.indexOf(".vl2-hero-scrim"));
      const phone = /--hero-fade-reach:\s*([0-9.]+);/.exec(rule);
      expect(phone, "the phone value is the base rule, beside the scrim's").not.toBeNull();
      // At 1 the ellipse is inscribed in the box and the top and bottom of the
      // picture are faded for a problem they do not have. Past 2 the vertical
      // fade lands outside the box entirely.
      expect(Number(phone![1])).toBeGreaterThanOrEqual(2);
      // A laptop keeps the inscribed ellipse it has always had.
      expect(css).toMatch(/@media \(min-width: 641px\) \{\s*\.vl2-hero-video \{[\s\S]{0,600}?--hero-fade-reach: 1;/);
    });

    it("still reaches transparent on the axis that carries the white", () => {
      // Left and right must still fade to nothing inside the box, whatever the
      // vertical reach is: that is the guarantee, and it is horizontal.
      expect(source).toContain("createRadialGradient(0, 0, FADE_START, 0, 0, 1)");
      expect(source).toMatch(/context\.scale\(cw \/ 2, \(ch \/ 2\) \* fadeReach\);[\s\S]{0,160}fillRect\(-1, -1, 2, 2\)/);
    });

    it("cannot fail into no falloff at all", () => {
      // An absent stylesheet or an unparseable value lands on the inscribed
      // ellipse — more fade than needed, never less. The failure mode is a
      // slightly darker hero, never a white band.
      expect(source).toContain("let fadeReach = 1;");
      expect(source).toMatch(/Number\.isFinite\(reachDeclared\)\s*\?\s*Math\.min\(6, Math\.max\(1, reachDeclared\)\)\s*:\s*1/);
    });

    it("keeps the fit rule branchless, the crop having been taken back out", () => {
      // A phone-only crop lived here briefly. It cleared the label off the
      // headline and cost the composition: 43% magnification, the vial reduced
      // to its cap, and the frame's own black vignette across the top. Mean
      // luminance 34 -> 25.
      expect(source).toContain("const scale = ch / sh;");
      expect(source).not.toContain("--hero-framing");
      expect(css).not.toContain("--hero-framing");
    });
  });

  it("keeps the falloff a falloff, not a hole punched in the middle", () => {
    // FADE_START only has to guarantee the EDGES reach zero, so that no
    // viewport shape can leave the white studio backdrop on screen. Where the
    // ramp BEGINS is a separate question, and 0.55 answered it so
    // conservatively that the shot was dissolving from just past the centre —
    // the vial's shoulder painted at partial alpha over a near-black ground.
    const start = /^const FADE_START = ([0-9.]+);$/m.exec(source);
    expect(start).not.toBeNull();
    expect(Number(start![1]), "the vial is the middle of the frame").toBeGreaterThanOrEqual(0.65);
    // Still short of the edge, or there is no falloff left to speak of.
    expect(Number(start![1])).toBeLessThanOrEqual(0.85);
  });

  it("still cannot put a bright edge on screen", () => {
    // The three defences, in one place, so removing any of them fails here.
    expect(source).toContain("createRadialGradient(0, 0, FADE_START, 0, 0, 1)");
    expect(source).toContain('context.globalCompositeOperation = "destination-in"');
    expect(read("scripts/build-hero-media.mjs")).toMatch(/^const END = 1(\.0)?;$/m);
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
    //
    // It is now the clip's OWN FIRST FRAME, which is the strongest form of this
    // and the reason the comparison moved off frame 29. The clip is rotated to
    // start where the vial's label is turned away from camera (see LOOP_START in
    // scripts/build-hero-media.mjs), and the poster is derived from the same
    // frame number, so the two are the same picture by construction.
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
    const b = grab(clip, "select='eq(n\\,0)',");
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff / a.length, "the poster is not the clip's opening frame").toBeLessThan(6);
  });

  // -------------------------------------------------------------------------
  // AND THE OPENING FRAME IS ONE WHERE THE LABEL IS TURNED AWAY.
  //
  // The vial's printed label is black type on white at roughly the size of the
  // headline, and a full-bleed phone hero puts the two in the same place. No
  // scrim fixes that — a wash multiplies the label's white and its black by the
  // same factor, so the ratio the eye reads type by survives any alpha; at an
  // alpha that measured 43/255 behind the headline, well inside the 118 budget,
  // "GHK-Cu" still read straight across it.
  //
  // The film solves it: the vial turns, and for a two-second window the label
  // is edge-on and not legible. The clip is rotated to start there, so the
  // first paint — and the still that reduced-motion visitors keep — has no type
  // in it to compete.
  // -------------------------------------------------------------------------
  it.skipIf(!ffmpeg)("the phone pair is the same picture too", () => {
    const grab = (file: string, filters: string) =>
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-vf", `${filters}scale=64:64`, "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { maxBuffer: 1 << 24 },
      );
    const a = grab("public/images/hero-vial-poster-phone.jpg", "");
    const b = grab("public/videos/vanta-labs-hero-phone.mp4", "select='eq(n\\,0)',");
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff / a.length, "the phone still is not the phone clip's opening frame")
      .toBeLessThan(6);
  });

  it.skipIf(!ffmpeg)("the phone clip has a black border too", () => {
    for (const frame of [0, 40, 80, 120, 160, 200, 240]) {
      expect(
        brightestBorder("public/videos/vanta-labs-hero-phone.mp4", `select='eq(n\\,${frame})',`),
        `frame ${frame} of the phone clip has a bright border`,
      ).toBeLessThanOrEqual(INDISTINGUISHABLE_FROM_THE_PAGE);
    }
    expect(brightestBorder("public/images/hero-vial-poster-phone.jpg", ""))
      .toBeLessThanOrEqual(INDISTINGUISHABLE_FROM_THE_PAGE);
  });

  it.skipIf(!ffmpeg)("opens on a frame with no legible label", () => {
    /** Horizontal edge energy over the label band: printed type, essentially. */
    const typeEnergy = (file: string, filters: string) => {
      const size = 480;
      const raw = execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-vf", `${filters}scale=${size}:${size},format=gray`,
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        { maxBuffer: 1 << 26 },
      );
      const at = (x: number, y: number) => raw[y * size + x];
      const x0 = Math.floor(size * 0.34);
      const x1 = Math.floor(size * 0.66);
      let peak = 0;
      for (let y = Math.floor(size * 0.4); y < size * 0.8; y++) {
        let e = 0;
        for (let x = x0 + 1; x < x1; x++) e += Math.abs(at(x, y) - at(x - 1, y));
        peak = Math.max(peak, e / (x1 - x0));
      }
      return peak;
    };
    // Measured across all 241 frames of the master: 43 with the label facing
    // camera, 3-7 through the turned-away window. 12 sits well clear of both.
    expect(
      typeEnergy("public/videos/vanta-labs-hero-phone.mp4", "select='eq(n\\,0)',"),
      "the phone clip opens with the label facing camera",
    ).toBeLessThan(12);
    expect(
      typeEnergy("public/images/hero-vial-poster-phone.jpg", ""),
      "the phone still has the label facing camera",
    ).toBeLessThan(12);

    // And a wide screen still gets the film as shot. Its copy is a column
    // beside the vial, so there is no collision to trade the studio opening for
    // — the turned-away window is a darker, moodier setup and this is the
    // assertion that stops it being handed to everyone by accident.
    expect(
      typeEnergy("public/videos/vanta-labs-hero-opt.mp4", "select='eq(n\\,0)',"),
      "the desktop clip no longer opens on the film as shot",
    ).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// The falloff that replaced the mask has to be bounded by the element, or it is
// the same bug in a different language: a gradient that wants to finish outside
// the canvas is clipped by the canvas, and a clipped ellipse is a rectangle.
//
// It also has to be computed in SCREEN space rather than from the source frame,
// which is what makes a full-bleed hero survivable — see the block above.
// ---------------------------------------------------------------------------
describe("the canvas falloff is bounded by the element it paints", () => {
  const source = read("src/components/hero-video.tsx");

  // CHANGED FROM A CIRCLE TO AN ELLIPSE, and the circle was a real limitation
  // rather than a stylistic one. A circle of radius min(halfWidth, halfHeight)
  // finishes correctly on the short axis and leaves the long axis's ends fully
  // transparent — invisible on the square box this was written for, and fatal
  // on a full-bleed one, where it would show the picture through a circle in
  // the middle of the section.
  //
  // Building the gradient in unit space and stretching it to the box gives an
  // ellipse matching whatever shape the element is, so the guarantee holds for
  // every box: 1.0 is an edge midpoint, the ramp is complete there, and the
  // corners are further out still.
  //
  // IT USED TO SAY "ON BOTH AXES", AND THAT WAS THE BUG THIS PARAGRAPH IS NOW
  // ABOUT. The guarantee is only load-bearing where the crop cuts through the
  // white studio backdrop, and on a phone that is the LEFT AND RIGHT edges
  // alone — measured on the frame with no falloff, they sit at 241/255 down the
  // middle of the screen while the top and bottom are 0, because the vignette
  // burnt into the file already finishes those. Fading all four spent picture
  // on two edges that had nothing to hide, which is half of why the hero was
  // reported as "black all around".
  //
  // So the vertical axis is scaled out past the box (see fadeReach). The
  // horizontal ramp still completes inside it, which is the half that matters.
  it("fades out at the edges that can carry white, whatever shape the box is", () => {
    expect(source).toContain("createRadialGradient(0, 0, FADE_START, 0, 0, 1)");
    expect(source).toMatch(/context\.scale\(cw \/ 2, \(ch \/ 2\) \* fadeReach\);[\s\S]{0,160}fillRect\(-1, -1, 2, 2\)/);
    expect(source).not.toContain("Math.min(cx, cy)");
    // The horizontal axis is never scaled out — it is the one doing the work.
    expect(source).not.toMatch(/context\.scale\(\(cw \/ 2\) \*/);
    const start = /^const FADE_START = ([0-9.]+);$/m.exec(source);
    expect(start).not.toBeNull();
    expect(Number(start![1])).toBeGreaterThan(0);
    expect(Number(start![1])).toBeLessThan(1);
  });

  // `cover` on a portrait phone scales the square source to 726x726 inside a
  // 390-wide box and throws away 46% of its WIDTH — exactly where the vignette
  // burnt into the file lives. An asset-only defence therefore evaporates on
  // the devices that reported the bug: what reaches the screen is the bright
  // middle of the frame, running edge to edge. That is the Snapchat report.
  it("computes the falloff from the element, not from the source frame", () => {
    const present = source.slice(source.indexOf("const present = () => {"));
    const body = present.slice(0, present.indexOf("\n    };"));
    expect(body).toContain("const cw = canvas.width;");
    expect(body).toContain("const ch = canvas.height;");
    expect(body).not.toMatch(/videoWidth|naturalWidth/);
    // And it is part of drawing the picture, not a separate step that could
    // fail on its own and leave the shot bare.
    expect(source).toMatch(/hasPicture = true;\s*present\(\);/);
  });

  it("applies it as alpha on the canvas, not as a CSS mask", () => {
    expect(source).toContain('context.globalCompositeOperation = "destination-in"');
    // An opaque canvas cannot fade into anything, so the VISIBLE canvas must
    // not ask for one. The offscreen buffer is opaque on purpose and is never
    // on screen.
    expect(source).toContain('const context = canvas.getContext("2d");');
    expect(source).not.toMatch(/canvas\.getContext\("2d",\s*\{\s*alpha:\s*false/);
    expect(read("src/app/globals.css")).not.toMatch(/\.vl2-hero-video[\s\S]{0,400}?mask-image:/);
  });

  // The fit rule, which got this wrong once in a way that shipped a 2x label
  // behind the headline: a square source in a box WIDER than it is tall fills
  // the width unless you say otherwise, magnifying a 720px frame to 1440.
  it("fills the hero by matching its height, on every shape of screen", () => {
    // Still the height, never the width — that is the half of this rule that
    // stopped a square frame being magnified to 2x on a landscape hero and
    // printing the label across the copy. `framing` is only HOW MUCH of the
    // height is asked to do the matching, and it is 1 on every screen above a
    // phone, where the scale is `ch / sh` exactly as it always was. What a
    // phone does with it is pinned in "a phone is framed so the label falls
    // below the headline" above.
    expect(source).toContain("const scale = ch / sh;");
    expect(source, "the fit must never key on the width").not.toContain("const scale = cw /");
    const bias = /^const LANDSCAPE_BIAS = ([0-9.]+);$/m.exec(source);
    expect(bias).not.toBeNull();
    expect(Number(bias![1])).toBeGreaterThan(0.5);
    expect(Number(bias![1])).toBeLessThanOrEqual(1);
    // Inert where there is no spare width, which is every phone.
    expect(source).toContain("const spare = Math.max(0, cw - dw);");
  });
});
