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
 * AND IT FAILS TO A STILL VIAL, NEVER TO NOTHING. A 33 KB poster frame is
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
 * NO VIDEO AT ALL INSIDE AN APP'S BROWSER.
 *
 * This is the owner's call, made after five rounds of trying to keep a clip
 * playing inline in the TikTok WebView: defer playback out of the entry
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
 * A still product shot instead of a spinning one is a downgrade nobody will
 * notice. A fullscreen player instead of a storefront has cost this store
 * days.
 */
function HeroVial({ className, src, poster }: { className?: string; src: string; poster: string }) {
  // Read once, on the client. Server-rendered markup is identical either way
  // because this component only ever mounts after entry.
  const [inApp] = useState(detectInAppBrowser);

  if (inApp) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={className}
        src={poster}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  return <HeroVialCanvas className={className} src={src} poster={poster} />;
}

function HeroVialCanvas({
  className,
  src,
  poster,
}: {
  className?: string;
  src: string;
  poster: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

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

    let raf = 0;
    let stopped = false;

    // Match the canvas's backing store to the box it actually occupies, so the
    // vial is sharp on a 3x phone screen without painting more pixels than the
    // display can show.
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    // object-fit: cover, by hand — the canvas is the hero's full area and the
    // source must fill it without distorting.
    const cover = (source: CanvasImageSource, sw: number, sh: number) => {
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / sw, ch / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      context.drawImage(source, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    };

    // THE FALLBACK, PAINTED FIRST.
    //
    // A still frame goes up as soon as it loads — a 33 KB JPEG against a 520 KB
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

    const paint = () => {
      if (stopped) return;
      raf = requestAnimationFrame(paint);
      // Nothing decoded yet: leave the still frame on screen rather than
      // clearing to an empty rectangle.
      if (video.readyState < 2 || !video.videoWidth) return;
      resize();
      cover(video, video.videoWidth, video.videoHeight);
    };

    // A resize would otherwise leave the canvas blank until the next decoded
    // frame, so repaint the still frame too.
    const onResize = () => {
      resize();
      if (stillReady && video.readyState < 2) {
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
