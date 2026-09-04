"use client";

import { useEffect, useRef, useState } from "react";
import { useAccessGranted } from "@/components/age-gate";
import { detectInAppBrowser } from "@/lib/in-app-browser";

/**
 * The homepage hero vial: a decorative, muted, looping background animation.
 *
 * THERE IS NO <video> ELEMENT ON THIS PAGE. The vial is painted into a
 * <canvas>, frame by frame, from a video that is never attached to the
 * document.
 *
 * WHY IT HAD TO GO THIS FAR
 *
 * On an iPhone, inside the TikTok and Instagram in-app browsers, entering the
 * site kept handing the visitor Apple's own fullscreen player: the vial alone
 * on white. Nothing navigated to the file — it is referenced once, here, as a
 * source. iOS was deciding the visitor had asked to watch a video, and taking
 * the screen.
 *
 * Four rounds of fixes each removed one way it could reach that decision:
 * playback deferred out of the entry gesture, the element unmounted while the
 * gate is up, muted and playsinline set before the source rather than after.
 * Every one passed on desktop and failed on the phone, because on iOS a
 * <video> is not really a page element — it is a request for the system player
 * that the browser may honour whenever it likes.
 *
 * A <canvas> is not. It has no player, no fullscreen affordance, no native UI
 * and no privileged behaviour: it is a rectangle of pixels. Painting the frames
 * ourselves removes the entire class of failure rather than another instance of
 * it. The decoder still does the work; iOS simply has nothing to take over.
 *
 * The video is created detached, muted and inline, played programmatically, and
 * never appended anywhere.
 *
 * AND IT FAILS TO A STILL VIAL, NEVER TO NOTHING. A 36 KB poster frame is
 * painted first, so the hero shows the product immediately and keeps showing it
 * if the clip never decodes at all — Low Power Mode, a refused autoplay, a
 * stalled connection. The animation draws over it if and when playback starts.
 * A still vial is a product shot; the two failure modes this replaces were an
 * empty black hero and a fullscreen player, and both are now impossible.
 *
 * The gate knows nothing about any of this. It publishes one boolean; this
 * subscribes to it, and mounts only after entry.
 */
export function HeroVideo({
  className,
  src,
  poster = "/images/hero-vial-poster.jpg",
}: {
  className?: string;
  src: string;
  poster?: string;
}) {
  const granted = useAccessGranted();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!granted) return;
    // A LATER TASK, deliberately: past the entry interaction, so nothing here
    // is part of the tap that let the visitor in.
    const t = setTimeout(() => setSettled(true), 0);
    return () => {
      clearTimeout(t);
      setSettled(false);
    };
  }, [granted]);

  if (!granted || !settled) return null;
  return <HeroVial className={className} src={src} poster={poster} />;
}

/**
 * NO VIDEO AT ALL INSIDE AN APP'S BROWSER — AND NONE FOR ANYONE WHO HAS ASKED
 * FOR LESS MOTION.
 *
 * The first half is the owner's call, made after five rounds of trying to keep
 * a clip playing inline in the TikTok WebView: defer playback out of the entry
 * gesture, unmount the element behind the gate, order the attributes so muted
 * and playsinline precede the source, paint into a canvas so no video element
 * exists on the page. Each was correct, each passed in every engine available
 * here, and each still ended with an iPhone showing the vial alone on white.
 *
 * So in those browsers there is nothing to decode: a still frame, and that is
 * the whole hero. It cannot be taken over, cannot go fullscreen, cannot be
 * mistaken for media the visitor asked to watch. Everywhere else — Safari,
 * Chrome, desktop — the animation runs exactly as designed.
 *
 * The second half is `prefers-reduced-motion`. A ten-second looping clip is
 * exactly the kind of continuous background motion that setting exists to stop,
 * and the honest way to honour it is not to fetch or decode the clip at all —
 * which also spares those devices 540 KB and a per-frame paint.
 *
 * Both land in the same place: the still poster, painted once, with the same
 * falloff as the animated hero. The two heroes differ only in whether the
 * picture moves.
 */
function HeroVial({ className, src, poster }: { className?: string; src: string; poster: string }) {
  // Read once, on the client. Server-rendered markup is identical either way
  // because this component only ever mounts after entry.
  const [still] = useState(
    () =>
      detectInAppBrowser() ||
      (typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  );

  return <HeroVialCanvas className={className} src={still ? null : src} poster={poster} />;
}

/**
 * WHERE THE SHOT STOPS AND THE PAGE BEGINS.
 *
 * The falloff that blends the vial into the hero is applied HERE, as real alpha
 * on the canvas, and no longer as a CSS `mask-image`. Two reasons, and the
 * first one is a bug that shipped.
 *
 * A radial-gradient mask is sized against the element box, so a gradient whose
 * transparent stop lands outside that box is CLIPPED BY IT — and a clipped
 * ellipse is a rectangle with rounded corners. The mask this replaces reached
 * `transparent` at 0.82 x 0.76 = 62% of the box width, measured from a centre
 * at 50%, so it wanted to fade out at -12% and 112% of the width: past both
 * edges. What a visitor saw was the vial in a hard-edged panel — straight sides,
 * a straight bottom cutting through the label — which is exactly the "black box
 * round the vial" this is fixing. The geometry made that inevitable, not the
 * chosen numbers.
 *
 * Second: `mask-image` is a compositing feature, and the browsers that matter
 * most here are in-app WebViews, where compositing is where this hero has been
 * bitten before. If a mask silently does not apply, what is left on screen is
 * the raw asset — a vial on a white studio background — which is the white-box
 * report itself. `destination-in` is plain 2D canvas compositing, supported
 * everywhere a canvas is, and it cannot half-apply: either the canvas paints or
 * it does not, and if it does not the hero is its own dark gradient.
 *
 * FADE_START is where the picture begins to give way, measured in a space where
 * the element's own edge midpoints are at 1.0 on BOTH axes — an ellipse
 * inscribed in the box, not a circle. Everything reaches fully transparent at
 * 1.0, so the element disappears completely inside itself on all four sides:
 * there is no point on any border where a pixel is opaque, and therefore no
 * edge to see, whatever shape the box is.
 *
 * THE ELLIPSE IS LOAD-BEARING, AND A CIRCLE WAS WRONG. A circle of radius
 * min(halfWidth, halfHeight) fades out correctly on the short axis and leaves
 * the long axis's ends fully transparent — fine for a square box, useless for
 * a full-bleed one, where it would show the shot only through a circle in the
 * middle of the section.
 *
 * SCREEN SPACE, NOT FRAME SPACE, and this is what makes the full-bleed hero
 * safe. `cover` on a portrait phone scales the square source to 726x726 in a
 * 390-wide box and throws away 46% of its WIDTH — which is precisely where the
 * vignette burnt into the file lives. Rely on the asset alone and a phone gets
 * the bright middle of the frame running edge to edge: the "vial on a white
 * background" report from Snapchat, exactly. Applied here, the falloff is
 * computed on the element as it is actually laid out, so it cannot be cropped
 * away by any viewport shape. The burnt-in vignette goes back to being what it
 * was always meant to be — a guard for the raw file, not the composition.
 *
 * 0.72 keeps the middle of the section at full strength and spends the outer
 * 28% dissolving into the page.
 *
 * IT WAS 0.55, AND THAT SPENT NEARLY HALF THE PICTURE. The guarantee this
 * number carries is about the EDGES: reach fully transparent by 1.0 on both
 * axes so no viewport shape can leave a bright band on screen. Where the ramp
 * BEGINS is a separate question, and 0.55 answered it far more conservatively
 * than the guarantee needs — the shot was already dissolving from just past
 * the centre, so the vial's shoulder and most of its lit halo were painted at
 * partial alpha over the hero's own near-black gradient. Together with a flat
 * 0.9 opacity and a scrim that started four rem above the copy, that is what
 * made the owner report the hero as black.
 *
 * 0.72 keeps the falloff — every edge still reaches zero at 1.0, so the white
 * studio backdrop still cannot appear at any viewport shape — and gives the
 * middle of the frame, which is the vial, back its brightness.
 */
const FADE_START = 0.72;

/**
 * Where the shot sits along the hero when there is room to choose, as a
 * fraction of the spare width: 0.5 is centred, 1 is hard right.
 *
 * Only a landscape hero has spare width (see the fit rule in cover()), and on a
 * wide screen the copy is a column down the left. Centred, the vial's own label
 * prints behind the headline at reading size — a defect this hero has shipped
 * twice. Pushed right it sits where the desktop scrim has always assumed it
 * was: copy left, product right.
 *
 * A phone has no spare width at all, so this has no effect there, which is
 * correct — the shot is meant to fill a phone screen.
 */
const LANDSCAPE_BIAS = 0.76;

/**
 * HOW FAR THE FALLOFF REACHES DOWN THE VERTICAL AXIS, and why it is not 1.
 *
 * The falloff exists for ONE measured reason: this asset is a vial lit on a
 * white studio backdrop, and a portrait crop of a square frame cuts straight
 * through that backdrop. Drawn at framing 1 into a 390x726 phone hero with no
 * falloff at all, the left and right edges measure 241/255 down the middle of
 * the screen — near-white bands running the height of the page. That is the
 * "vial on a white background" report, and it is real.
 *
 * THE TOP AND BOTTOM ARE NOT THAT, AND THE ELLIPSE TREATED THEM AS IF THEY
 * WERE. Measured on the same crop: top edge 0, bottom edge 0. The vignette
 * burnt into the file already finishes those two, so fading them costs picture
 * and buys nothing — and it is what put a black band across the top and bottom
 * of the phone hero on top of the scrim's own. The owner's report was that the
 * hero was "black all around"; two of those four sides were being blacked out
 * for a problem they do not have.
 *
 * So the falloff keeps its horizontal half and gives up most of its vertical
 * one. Pushing the vertical axis out to a multiple of the half-height leaves a
 * gradient that is essentially horizontal across the middle of the screen and
 * still rounds the corners off — which matches how the asset's own vignette
 * falls, rather than fighting it.
 *
 * THE GUARANTEE IS UNCHANGED WHERE IT IS LOAD-BEARING. Left and right still
 * reach fully transparent inside the box, so no viewport shape can put a white
 * band on screen. Top and bottom now cut where the picture is already black,
 * against a hero background that is also black: a hard edge nobody can see.
 *
 * Published from CSS beside the framing, for the same reason: a laptop's crop
 * has black on all four edges (measured: 0 on every side) and needs none of
 * this, so the value belongs at the breakpoint, not in the script.
 */
const FADE_REACH_PROPERTY = "--hero-fade-reach";

function HeroVialCanvas({
  className,
  src,
  poster,
}: {
  className?: string;
  /** null means "still only": no video is created, nothing is fetched. */
  src: string | null;
  poster: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // ALPHA, deliberately. `{ alpha: false }` makes the canvas an opaque black
    // rectangle, which over the hero's own gradient is a second visible panel —
    // and it makes the falloff below impossible, because a canvas that cannot
    // be transparent cannot fade into anything.
    const context = canvas.getContext("2d");
    if (!context) return;

    let raf = 0;
    let stopped = false;
    let fade: CanvasGradient | null = null;
    /**
     * How much of the frame's height this screen shows — see
     * PORTRAIT_FRAMING_PROPERTY. Re-read on every resize, so rotating a phone
     * or crossing the breakpoint picks up the other value without a reload.
     *
     * Clamped, and defaulting to 1: a stylesheet that has not arrived, a value
     * that does not parse, or a browser that ignores custom properties all end
     * at "show the whole frame", which is the composition every screen had
     * before this existed. It cannot fail into a magnified crop.
     */
    /**
     * How far the falloff's VERTICAL axis reaches, as a multiple of the box's
     * half-height. 1 is an ellipse inscribed in the box — the shape this
     * started as. Larger pushes the vertical fade outside the box, leaving a
     * falloff that is horizontal across the middle and only rounds the corners.
     *
     * See FADE_REACH_PROPERTY. Defaults to 1, so a stylesheet that never
     * arrives lands on the inscribed ellipse rather than on no falloff at all.
     */
    let fadeReach = 1;

    // Match the canvas's backing store to the box it actually occupies, so the
    // vial is sharp on a 3x phone screen without painting more pixels than the
    // display can show.
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const reachDeclared = Number.parseFloat(
        getComputedStyle(canvas).getPropertyValue(FADE_REACH_PROPERTY),
      );
      const nextReach = Number.isFinite(reachDeclared)
        ? Math.min(6, Math.max(1, reachDeclared))
        : 1;
      if (nextReach !== fadeReach) {
        fadeReach = nextReach;
        fade = null;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        // Resizing a canvas clears it, so the buffer's contents go with it and
        // nothing may be presented until something is drawn again.
        picture.width = w;
        picture.height = h;
        hasPicture = false;
        fade = null;
      }
      if (!fade) {
        // Built in UNIT space — centre 0, edge 1 — and stretched to the box
        // when it is filled, which is what makes it an ellipse matching the
        // element rather than a circle inside it. Resolution-independent, so
        // it survives a device-pixel-ratio change untouched.
        fade = context.createRadialGradient(0, 0, FADE_START, 0, 0, 1);
        // Sampled smootherstep. A two-stop gradient leaves a visible ring where
        // the falloff starts; the extra stops are the same 6t^5-15t^4+10t^3
        // curve the burnt-in vignette uses, so the two compose smoothly.
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const eased = t * t * t * (t * (t * 6 - 15) + 10);
          fade.addColorStop(t, `rgba(0,0,0,${(1 - eased).toFixed(4)})`);
        }
      }
    };

    // THE PICTURE BUFFER, AND WHY THE HERO IS NOT PAINTED STRAIGHT ONTO THE
    // VISIBLE CANVAS.
    //
    // The visible canvas has to be CLEARED before each frame, because it
    // carries alpha: without a clear, the previous frame shows through the new
    // one's faded edges and the falloff erodes a little further every frame.
    // But "clear, then draw the video" is only safe if the draw actually
    // produces pixels — and `drawImage(video)` producing nothing while the
    // element still reports `readyState: 4` and a real videoWidth is a state
    // browsers genuinely reach. Measured here in WebKit: readyState 4,
    // videoWidth 720, paused false, currentTime frozen at 0, every drawImage a
    // no-op. Clear-then-draw in that state is an EMPTY hero, and the previous
    // build survived it only by accident — it never cleared, so a no-op draw
    // left the poster where it was.
    //
    // So frames are composed in an opaque offscreen buffer that is never
    // cleared. A draw that yields nothing leaves the last good picture in it —
    // the poster, at worst — and the visible canvas is repainted from the
    // buffer. The empty hero is not handled here; it is unreachable.
    const picture = document.createElement("canvas");
    const pictureContext = picture.getContext("2d", { alpha: false });
    let hasPicture = false;

    /** Blit the buffer onto the visible canvas and apply the falloff. */
    const present = () => {
      if (!hasPicture) return;
      const cw = canvas.width;
      const ch = canvas.height;
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, cw, ch);
      context.drawImage(picture, 0, 0, cw, ch);
      // Keep only what the falloff keeps. The alpha channel now carries the
      // vignette, so the element blends into the hero with no edge of any kind.
      context.globalCompositeOperation = "destination-in";
      if (fade) {
        // Stretch the unit-space gradient over the box: an ellipse whose axes
        // are the element's own half-width and half-height.
        context.save();
        context.translate(cw / 2, ch / 2);
        context.scale(cw / 2, (ch / 2) * fadeReach);
        context.fillStyle = fade;
        context.fillRect(-1, -1, 2, 2);
        context.restore();
      }
      context.globalCompositeOperation = "source-over";
    };

    /**
     * Fill the hero without distorting, by hand.
     *
     * THE FIT RULE DEPENDS ON THE SHAPE OF THE HERO, and getting it wrong once
     * is what put a 2x-magnified label behind the headline. The source is
     * SQUARE, so:
     *
     *   * A PORTRAIT hero (a phone) is narrower than it is tall, so filling it
     *     means matching its HEIGHT and letting the sides crop. The vial fills
     *     the screen, which is the point.
     *
     *   * A LANDSCAPE hero (a laptop) is wider than it is tall. Filling it the
     *     same way — matching the WIDTH — scales a 720px frame to 1440 and
     *     throws away 37% of its height: the vial printed at twice life size
     *     with its label across the copy. So a wide hero matches its height
     *     too, which fills the section top to bottom and leaves spare width for
     *     the copy to live in.
     *
     * Both cases are the same sentence — match the height — so there is no
     * branch here, and there should not be one: a fit rule that reads
     * differently for phones and laptops is how the two got different bugs.
     *
     * A PHONE-ONLY CROP WAS TRIED HERE AND TAKEN BACK OUT. Showing the top 0.7
     * of the frame did move the vial's printed label clear of the headline,
     * which is what it was for. It also magnified the frame by 43%, cropped the
     * vial down to its cap and shoulder, and put the frame's own black vignette
     * band across the top of the screen. The owner's words were "huge", "so
     * zoomed in" and "black all around", and the measurements agreed: the
     * section's mean luminance fell from 34/255 to 25. The label is a real
     * problem and this was not the way to solve it — see the note in
     * globals.css for what is left of it.
     */
    const cover = (source: CanvasImageSource, sw: number, sh: number) => {
      if (!pictureContext) return;
      const cw = picture.width;
      const ch = picture.height;
      const scale = ch / sh;
      const dw = sw * scale;
      const dh = sh * scale;
      // Zero on a phone, where the frame overflows the box, so the bias is
      // inert there and the crop stays centred.
      const spare = Math.max(0, cw - dw);
      const x = (cw - dw) / 2 + spare * (LANDSCAPE_BIAS - 0.5);
      pictureContext.drawImage(source, x, (ch - dh) / 2, dw, dh);
      hasPicture = true;
      present();
    };

    // THE FALLBACK, PAINTED FIRST.
    //
    // A still frame goes up as soon as it loads — a 36 KB JPEG against a 540 KB
    // clip — so the hero shows the vial immediately and keeps showing it if the
    // video never decodes at all: Low Power Mode, a refused autoplay, a stalled
    // connection, a codec the browser will not touch. The animation draws over
    // it when and if it starts.
    //
    // This is the rule the owner set, and it is the right one: a still vial is
    // a product shot. There is no failure mode left where the hero is empty,
    // and none where it is a fullscreen player.
    const stillFrame = new Image();
    stillFrame.decoding = "async";
    let stillReady = false;
    stillFrame.onload = () => {
      stillReady = true;
      if (stopped) return;
      resize();
      cover(stillFrame, stillFrame.naturalWidth, stillFrame.naturalHeight);
    };
    stillFrame.src = poster;

    // STILL ONLY — an in-app browser, or a visitor who asked for reduced
    // motion. Nothing below this line runs, so no clip is fetched and no
    // decoder is started.
    if (src === null) {
      const onResizeStill = () => {
        resize();
        if (stillReady) cover(stillFrame, stillFrame.naturalWidth, stillFrame.naturalHeight);
      };
      resize();
      window.addEventListener("resize", onResizeStill);
      return () => {
        stopped = true;
        window.removeEventListener("resize", onResizeStill);
        stillFrame.onload = null;
      };
    }

    // DETACHED. This element is never appended to the document, so it has no
    // layout, no hit-testing, no compositing layer of its own and nothing for
    // the browser to present a player for.
    const video = document.createElement("video");

    // Inline eligibility first, source last — the order still matters for
    // whether iOS will decode without demanding its own UI.
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("x5-playsinline", "true");
    video.loop = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";

    const paint = () => {
      if (stopped) return;
      raf = requestAnimationFrame(paint);
      // Nothing decoded yet: leave the still frame on screen rather than
      // drawing an empty frame over it. The buffer would survive that anyway;
      // this just avoids the work.
      if (video.readyState < 2 || !video.videoWidth) return;
      resize();
      cover(video, video.videoWidth, video.videoHeight);
    };

    // A resize clears both canvases, so whatever is showing has to be redrawn.
    // The video does that on its next frame if it has one; the still is what
    // covers the case where it does not.
    const onResize = () => {
      resize();
      if (!hasPicture && stillReady) {
        cover(stillFrame, stillFrame.naturalWidth, stillFrame.naturalHeight);
      }
    };

    const start = () => {
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };

    video.addEventListener("loadeddata", start);
    video.addEventListener("canplay", start);
    // A pause nobody asked for means the browser deferred playback; ask again.
    video.addEventListener("pause", start);

    // Returning to the foreground, which is not a user gesture. Browsers pause
    // background media, and without this the vial would stay frozen.
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // AND IF THE CLIP NEVER ACTUALLY RUNS, STOP ASKING.
    //
    // A decoder that reports itself ready and then delivers nothing — the
    // WebKit state above, a refused autoplay that keeps refusing, Low Power
    // Mode — would otherwise leave a requestAnimationFrame loop repainting the
    // same still picture at 60 Hz for as long as the page is open. That is the
    // battery cost of an animation without the animation.
    //
    // `currentTime` is the honest signal: it advances if and only if frames are
    // being presented. Checking it is free and, unlike sampling the canvas,
    // cannot be refused by a tainted-origin rule. Two consecutive checks with
    // no movement while the data is there and the element is not paused means
    // the clip is not going to play, so the hero settles for the still it is
    // already showing.
    let lastTime = -1;
    let stalls = 0;
    const standDownIfDead = () => {
      if (stopped) return;
      if (video.readyState < 2) return; // still loading; nothing to conclude
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        stalls = 0;
        return;
      }
      if (++stalls < 2) return;
      window.clearInterval(liveness);
      cancelAnimationFrame(raf);
      raf = 0;
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (stillReady) cover(stillFrame, stillFrame.naturalWidth, stillFrame.naturalHeight);
    };
    const liveness = window.setInterval(standDownIfDead, 2500);

    video.src = src;
    start();
    // Size the backing store immediately rather than waiting for the first
    // decoded frame, so the very first painted frame is already sharp and the
    // canvas never briefly holds the 300x150 default.
    resize();
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(paint);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearInterval(liveness);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      video.removeEventListener("loadeddata", start);
      video.removeEventListener("canplay", start);
      video.removeEventListener("pause", start);
      // Stop the download; a detached element still streaming is a real cost
      // on a phone.
      video.pause();
      video.removeAttribute("src");
      video.load();
      stillFrame.onload = null;
    };
  }, [src, poster]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      // Decorative: never focusable, never tappable. The CSS already sets
      // pointer-events: none; this is the same statement in the markup.
      tabIndex={-1}
    />
  );
}
