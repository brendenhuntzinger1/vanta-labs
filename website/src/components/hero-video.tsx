"use client";

import { useEffect, useRef, useState } from "react";
import { useAccessGranted } from "@/components/age-gate";

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
 * never appended anywhere. If it cannot decode — Low Power Mode, a refused
 * autoplay, a stalled network — the canvas stays empty and the hero shows the
 * gradient it already paints, which is the same outcome as before and never a
 * broken player.
 *
 * The gate knows nothing about any of this. It publishes one boolean; this
 * subscribes to it, and mounts only after entry.
 */
export function HeroVideo({ className, src }: { className?: string; src: string }) {
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
  return <HeroVialCanvas className={className} src={src} />;
}

function HeroVialCanvas({ className, src }: { className?: string; src: string }) {
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
    // clip must fill it without distorting.
    const paint = () => {
      if (stopped) return;
      raf = requestAnimationFrame(paint);
      if (video.readyState < 2 || !video.videoWidth) return;
      resize();
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      context.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
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
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(paint);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      video.removeEventListener("loadeddata", start);
      video.removeEventListener("canplay", start);
      video.removeEventListener("pause", start);
      // Stop the download; a detached element still streaming is a real cost
      // on a phone.
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

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
