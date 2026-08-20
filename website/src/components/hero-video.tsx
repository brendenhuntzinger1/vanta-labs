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
  const hostRef = useRef<HTMLDivElement | null>(null);

  // THE ELEMENT IS BUILT BY HAND, AND THE ORDER IS THE WHOLE POINT.
  //
  // Written as JSX, React applied the props in the order they appeared, and the
  // browser received:
  //
  //   <video class src="…mp4" autoplay loop playsinline … muted>
  //
  // src SECOND. Assigning src is the moment iOS decides whether a video may
  // play inline, and at that instant this one was neither muted nor marked
  // playsinline — so iOS classified it as a video wanting a player, and when
  // autoplay started it took the screen. On a real iPhone that is the vial
  // alone on white, which is exactly what was reported; every desktop engine
  // ignores the ordering entirely and looks perfect.
  //
  // Building the element here makes the order explicit and guaranteed: muted
  // and playsinline first, while the element is still detached and inert, and
  // the source LAST, once it is already eligible to play inline.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const video = document.createElement("video");

    // 1. INLINE ELIGIBILITY, before anything can trigger loading.
    //    Both the property and the attribute: iOS consults the property for the
    //    autoplay decision, and the attribute is what survives in the markup.
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    // Older WebKit, and the WebView builds some apps ship, only honour the
    // prefixed spellings.
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("x5-playsinline", "true");

    // 2. Everything else about how it behaves.
    video.loop = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute("disableremoteplayback", "");
    video.tabIndex = -1;
    video.setAttribute("aria-hidden", "true");
    // The hero file is ~6.2 MB. "auto" buffers aggressively from first paint,
    // competing with the CSS, fonts and hero copy; "metadata" fetches the
    // headers and lets autoplay stream the rest progressively.
    video.preload = "metadata";
    if (className) video.className = className;

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

    // 3. THE SOURCE, LAST. By the time loading can begin the element is muted
    //    and inline-eligible, so iOS never classifies it as media the visitor
    //    asked to watch. autoplay is set here too, immediately before src, so
    //    nothing can start before the flags above are in place.
    video.autoplay = true;
    video.setAttribute("autoplay", "");
    video.src = src;
    host.appendChild(video);

    return () => {
      video.removeEventListener("webkitbeginfullscreen", refuseFullscreen);
      document.removeEventListener("visibilitychange", onVisibility);
      // Stop the download and tear the element down; leaving a detached video
      // loading is a real cost on a phone.
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    };
  }, [src, className]);

  // The element is created above and appended here. This wrapper carries no
  // styling of its own -- the class goes on the video, exactly as before.
  return <div ref={hostRef} />;
}
