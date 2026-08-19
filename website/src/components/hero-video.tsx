"use client";

import { useEffect, useRef } from "react";

/**
 * Background hero video that tries as hard as the browser will allow to stay
 * live and looping, and never exposes a play/pause affordance.
 *
 * The <video> is muted + inline + autoplay + loop, which is the combination
 * browsers require for gesture-free autoplay. On top of that we re-issue
 * play() on mount, once the media is ready, when the tab becomes visible
 * again, and on the first user interaction — so a blocked autoplay recovers
 * the moment it's allowed instead of parking behind a tap-to-play button.
 *
 * THE VIAL IS ALWAYS VISIBLE. This element used to keep itself transparent
 * until the "playing" event fired, to avoid a paused first frame with iOS's
 * play glyph stamped on it. That cure was worse than the disease: in an in-app
 * browser, on a weak signal, or any time the first frame had not decoded yet,
 * the hero was simply BLACK — no vial at all. The vial is the hero; an empty
 * black panel is not an acceptable fallback for it.
 *
 * So the video paints whatever it has: a live loop when playback is allowed, a
 * still first frame when it is not. Either way a visitor sees the product. The
 * retry-on-gesture path below still runs, so a deferred autoplay starts moving
 * the moment the browser relents — which on iOS is the visitor's first tap or
 * scroll.
 */
export function HeroVideo({ className, src }: { className?: string; src: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // iOS honors the muted *property* (not just the attribute) for autoplay.
    video.muted = true;
    video.defaultMuted = true;

    let cancelled = false;

    // NOTHING PLAYS WHILE THE AGE GATE IS UP.
    //
    // This is not a nicety, it is the fix for a real bug. The listeners below
    // are bound to `document`, so the FIRST TAP ANYWHERE counts as the gesture
    // that unblocks autoplay — including a tap on an age-gate checkbox, which
    // is the first thing anyone touches. Playback would start behind the gate.
    //
    // Behind the gate the storefront is `visibility: hidden`, which is enough
    // in Chromium. It is NOT enough in WebKit: a PLAYING video is promoted to
    // its own compositing layer, and on iOS that layer paints through an
    // ancestor's visibility. So ticking a box made the vial appear over the
    // gate — on an iPhone in an in-app browser, and nowhere else.
    //
    // Playback is therefore gated on the same attribute the CSS uses, and the
    // observer below starts it the moment access is actually granted.
    const gateIsUp = () =>
      document.documentElement.getAttribute("data-age-verified") !== "true";

    // PLAYBACK MUST NEVER START INSIDE THE ENTRY TAP, AND NEVER WITHOUT A BOX.
    //
    // Two iOS rules meet here, and getting either wrong opens the native
    // fullscreen player — a standalone video on white chrome, which is what
    // "it took me into the vial video" was:
    //
    //   1. play() called as the direct result of a user gesture reads as "the
    //      user asked to watch this video", which iPhone answers with its own
    //      player unless the element can play inline;
    //   2. an element with no layout box CANNOT play inline. Behind the gate
    //      this video is display:none, so at the instant the gate opens it has
    //      no box yet.
    //
    // The entry tap satisfied both at once: tap -> state -> effect ->
    // setAttribute -> observer -> play(), all in one gesture, on an element
    // that was display:none a moment earlier. Hence fullscreen.
    //
    // So: wait for a real layout box, and let the gesture finish first. The
    // video is muted, and muted autoplay needs no gesture at all — deferring
    // costs nothing and is what keeps playback inline.
    const startWhenReady = () => {
      if (cancelled || gateIsUp()) return;
      const box = video.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) {
        // Not laid out yet. Try again next frame rather than playing blind.
        requestAnimationFrame(startWhenReady);
        return;
      }
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };

    // Two frames out: past the current gesture, and past the style/layout pass
    // that gives the element its box.
    const attempt = () => {
      if (cancelled || gateIsUp()) return;
      requestAnimationFrame(() => requestAnimationFrame(startWhenReady));
    };

    attempt();

    // Entry is what starts the vial, not a stray tap on a checkbox.
    const gateWatcher = new MutationObserver(() => {
      if (gateIsUp()) {
        video.pause();
      } else {
        attempt();
      }
    });
    gateWatcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-age-verified"],
    });

    const onVisibility = () => {
      if (document.visibilityState === "visible") attempt();
    };

    // First user gesture unblocks autoplay everywhere it was deferred.
    const onGesture = () => {
      attempt();
      removeGestureListeners();
    };
    const gestureEvents: (keyof DocumentEventMap)[] = [
      "pointerdown",
      "touchstart",
      "click",
      "keydown",
      "scroll",
    ];
    const removeGestureListeners = () => {
      for (const ev of gestureEvents) {
        document.removeEventListener(ev, onGesture);
      }
    };

    // A pause that nobody asked for means the browser deferred playback, so
    // ask again. Nothing here controls visibility any more — the element is
    // always on screen.
    // BACKSTOP, not the fix. This hero is decorative and there is no state in
    // which a fullscreen player is correct, so if iOS ever begins presenting
    // one anyway, back out immediately. The real repair is above — never start
    // playback inside a gesture, never start it without a layout box.
    const refuseFullscreen = () => {
      const el = video as HTMLVideoElement & { webkitExitFullscreen?: () => void };
      try {
        el.webkitExitFullscreen?.();
      } catch {
        /* not presenting, or the browser does not offer the call */
      }
    };
    video.addEventListener("webkitbeginfullscreen", refuseFullscreen);

    video.addEventListener("loadedmetadata", attempt);
    video.addEventListener("canplay", attempt);
    video.addEventListener("pause", attempt);
    document.addEventListener("visibilitychange", onVisibility);
    for (const ev of gestureEvents) {
      document.addEventListener(ev, onGesture, { passive: true });
    }

    return () => {
      cancelled = true;
      gateWatcher.disconnect();
      video.removeEventListener("webkitbeginfullscreen", refuseFullscreen);
      video.removeEventListener("loadedmetadata", attempt);
      video.removeEventListener("canplay", attempt);
      video.removeEventListener("pause", attempt);
      document.removeEventListener("visibilitychange", onVisibility);
      removeGestureListeners();
    };
  }, []);

  return (
    <video
      ref={ref}
      className={className}
      src={src}
      autoPlay
      muted
      loop
      playsInline
      /* The modern attribute is `playsinline`, which React writes from
         playsInline above. Older WebKit — and the WebView builds some apps
         still ship — only recognise the webkit-prefixed one, and without it
         they hand playback to the native fullscreen player. Both are given, so
         whichever the browser understands keeps the vial inside the hero. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ "webkit-playsinline": "true", "x5-playsinline": "true" } as any)}
      /* METADATA, NOT AUTO.
         The hero file is ~6.2 MB. preload="auto" told the browser to buffer it
         aggressively from first paint, competing with the CSS, fonts and hero
         copy for bandwidth -- on a phone that is roughly ten seconds of black
         hero on a normal 4G connection. "metadata" fetches only the headers;
         autoplay still starts and the file streams progressively, so the
         animation is unchanged while the critical render path is not starved.

         Worth adding a poster frame too (a single still from the video):
         without one there is nothing to paint until the first frame decodes.
         That needs ffmpeg, which is not available in this environment. */
      preload="metadata"
      controls={false}
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
