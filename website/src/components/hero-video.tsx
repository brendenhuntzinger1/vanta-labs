"use client";

import { useEffect, useRef, useState } from "react";

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
 * WHEN AUTOPLAY IS REFUSED, THE VIDEO HIDES ITSELF. iOS Low Power Mode blocks
 * autoplay at the OS level, and some in-app browsers (the Instagram/TikTok
 * webviews a bio link opens in) do the same. No web code can override that —
 * and a paused <video> is not neutral: Safari paints its OWN play glyph over
 * it, which `controls={false}` does not suppress. A visitor arriving from a
 * bio link therefore met a still vial with a play badge stamped on it, looking
 * like a broken embed rather than a hero.
 *
 * So the element stays transparent until it is genuinely playing. Underneath
 * is the gradient `.vl2-hero` already paints for exactly this case, so a
 * refused autoplay degrades to the designed still hero instead of a play
 * button. The retry-on-gesture path below still runs, so if the browser later
 * relents the video fades in.
 */
export function HeroVideo({ className, src }: { className?: string; src: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

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

    // Only these decide visibility. "playing" fires when frames are actually
    // being presented, which is the one signal that means there is something
    // worth showing — readyState and a resolved play() promise can both be
    // true while the element still renders a paused first frame.
    const onPlaying = () => setIsPlaying(true);
    const onStalled = () => setIsPlaying(false);

    video.addEventListener("loadedmetadata", attempt);
    video.addEventListener("canplay", attempt);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onStalled);
    video.addEventListener("error", onStalled);
    document.addEventListener("visibilitychange", onVisibility);
    for (const ev of gestureEvents) {
      document.addEventListener(ev, onGesture, { passive: true });
    }

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", attempt);
      video.removeEventListener("canplay", attempt);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onStalled);
      video.removeEventListener("error", onStalled);
      document.removeEventListener("visibilitychange", onVisibility);
      removeGestureListeners();
    };
  }, []);

  return (
    <video
      ref={ref}
      className={className}
      // Transparent until frames are actually on screen — see the note above.
      // Transitioned so a slow start fades in rather than snapping.
      style={{ opacity: isPlaying ? undefined : 0 }}
      src={src}
      autoPlay
      muted
      loop
      playsInline
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
