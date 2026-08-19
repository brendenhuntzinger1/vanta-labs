"use client";

import { useEffect, useRef, useState } from "react";
import { useAccessGranted } from "@/components/age-gate";

/**
 * The homepage hero vial: a decorative, muted, looping background animation.
 *
 * WHY THIS IS STRUCTURED THE WAY IT IS
 *
 * On an iPhone — specifically inside the TikTok and Instagram in-app browsers —
 * completing the age gate kept handing the visitor Apple's NATIVE FULLSCREEN
 * VIDEO PLAYER: the vial alone on white chrome. Nothing ever navigated to the
 * .mp4; the file is referenced once, as this component's src. iOS was simply
 * deciding that the visitor had asked to watch a video.
 *
 * It kept deciding that because the entry tap and this element were connected.
 * Earlier attempts fought that connection with timing — defer play() a frame,
 * check for a layout box, watch an attribute and start playback when it flips.
 * Each passed in Chromium and failed on the device, because each still ended
 * with "a tap happened, then this video started".
 *
 * So the connection is gone rather than managed:
 *
 *   * while the gate is up THERE IS NO VIDEO ELEMENT. Not hidden, not
 *     display:none, not opacity zero — absent. There is nothing for a tap to
 *     activate, nothing to promote to a compositing layer, and nothing for iOS
 *     to hand a player for;
 *   * the element mounts only after access is granted AND in a later task, so
 *     its creation is not part of the entry gesture's work;
 *   * nothing here calls play() in response to any user input. There are no
 *     gesture listeners and no MutationObserver. Playback comes from the
 *     `autoplay` attribute on a muted inline video, which browsers start on
 *     their own and which iOS treats as decorative rather than requested.
 *
 * The gate is not aware this component exists. It publishes one boolean and
 * this subscribes to it.
 */
export function HeroVideo({ className, src }: { className?: string; src: string }) {
  const granted = useAccessGranted();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!granted) return;
    // A LATER TASK, deliberately. setTimeout schedules past the current task,
    // so the element is created after the entry interaction has fully finished
    // and the homepage has rendered — never as part of the tap that let the
    // visitor in. This is sequencing, not a race: `granted` cannot go true
    // before the visitor has actually entered.
    const t = setTimeout(() => setSettled(true), 0);
    return () => {
      clearTimeout(t);
      setSettled(false);
    };
  }, [granted]);

  // Both conditions, so losing access unmounts the element on the same render
  // rather than waiting for an effect to catch up.
  if (!granted || !settled) return null;
  return <HeroVideoElement className={className} src={src} />;
}

function HeroVideoElement({ className, src }: { className?: string; src: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // iOS honours the muted *property*, not only the attribute, when deciding
    // whether autoplay is allowed without a gesture.
    video.muted = true;
    video.defaultMuted = true;

    // FAILSAFE, NOT THE FIX. A decorative background has no state in which a
    // fullscreen player is correct, so if iOS ever begins presenting one, leave
    // it immediately and carry on inline. The architecture above is what stops
    // it being asked for in the first place.
    const refuseFullscreen = () => {
      const el = video as HTMLVideoElement & { webkitExitFullscreen?: () => void };
      try {
        el.webkitExitFullscreen?.();
      } catch {
        /* not presenting, or the call is unavailable */
      }
    };
    video.addEventListener("webkitbeginfullscreen", refuseFullscreen);

    // The ONLY recovery, and it is not a user gesture: a tab returning to the
    // foreground. Browsers pause background media, and without this the vial
    // would stay frozen after the visitor switches away and back. Playback
    // started this way is programmatic, which is exactly what iOS keeps inline.
    //
    // There are deliberately NO pointerdown/touchstart/click listeners. Those
    // are what made a tap look like a request to watch the video.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      video.removeEventListener("webkitbeginfullscreen", refuseFullscreen);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <video
      ref={ref}
      className={className}
      src={src}
      // autoplay + muted + playsinline is the combination browsers start on
      // their own, with no script and no gesture involved.
      autoPlay
      muted
      loop
      playsInline
      /* React writes `playsinline` from playsInline. Older WebKit — including
         the WebView builds some apps still ship — only honours the prefixed
         form, and without it hands playback to the native player. Both are
         given so whichever the browser understands keeps the vial in the hero. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ "webkit-playsinline": "true", "x5-playsinline": "true" } as any)}
      /* METADATA, NOT AUTO.
         The hero file is ~6.2 MB. preload="auto" told the browser to buffer it
         aggressively from first paint, competing with the CSS, fonts and hero
         copy for bandwidth -- on a phone that is roughly ten seconds of black
         hero on a normal 4G connection. "metadata" fetches only the headers;
         autoplay still starts and the file streams progressively, so the
         animation is unchanged while the critical render path is not starved. */
      preload="metadata"
      controls={false}
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
