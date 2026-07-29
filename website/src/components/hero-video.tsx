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
 * Note: iOS Low Power Mode blocks video autoplay at the OS level and no web
 * code can override it; in that one case Safari still shows its own play
 * glyph until the user taps. Everywhere else this keeps the vial spinning.
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
    const attempt = () => {
      if (cancelled) return;
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };

    attempt();

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

    video.addEventListener("loadedmetadata", attempt);
    video.addEventListener("canplay", attempt);
    document.addEventListener("visibilitychange", onVisibility);
    for (const ev of gestureEvents) {
      document.addEventListener(ev, onGesture, { passive: true });
    }

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", attempt);
      video.removeEventListener("canplay", attempt);
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
      preload="auto"
      controls={false}
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
