"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vl_cookie_consent";

// Analytics remains disabled until the visitor explicitly accepts. Essential
// store/session cookies continue to work regardless of this preference.
export function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setVisible(true);
      }
    } catch {
      // If storage is unavailable, don't nag.
    }
  }, []);

  /**
   * PUBLISH THE BANNER'S HEIGHT so the page can get out from under it.
   *
   * This is a `fixed` element pinned to the bottom of the viewport, and on a
   * phone it is tall — two lines of policy text plus a row of buttons. The
   * homepage hero is a near-full-height section whose CTA cluster is anchored
   * to its BOTTOM, so the two occupied the same pixels: a visitor arriving
   * from a bio link tapped "Shop the catalog" and hit the consent banner
   * instead. Nothing happened, and they were left looking at the hero.
   *
   * Height is measured rather than assumed because the copy wraps to a
   * different number of lines on every viewport width. Mirrors what
   * welcome-offer.tsx does for the top banner.
   */
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty("--cookie-banner-height");
      document.body.removeAttribute("data-cookie-banner");
    };

    if (!visible) {
      clear();
      return clear;
    }

    const measure = () => {
      const height = bannerRef.current?.offsetHeight ?? 0;
      if (!height) return;
      root.style.setProperty("--cookie-banner-height", `${height}px`);
      document.body.setAttribute("data-cookie-banner", "true");
    };

    measure();
    // The banner reflows when the viewport changes (rotation, in-app browser
    // chrome collapsing on scroll), and its height with it.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer && bannerRef.current) observer.observe(bannerRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      clear();
    };
  }, [visible]);

  const dismiss = (choice: "accepted" | "declined") => {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* no-op */
    }
    window.dispatchEvent(new Event("vanta:cookie-consent"));
    setVisible(false);
  };

  if (!visible) return null;

  // Sits at the very bottom. It used to be lifted 6rem on mobile to clear the
  // sticky Add-to-Cart bar and account bottom-nav, which pushed it up over the
  // homepage hero's CTAs and swallowed the first tap a visitor ever makes.
  // Those bars now move for it instead (see .vl-bottom-bar in globals.css),
  // and the z-index clears them so a consent notice is never painted over.
  return (
    <div
      ref={bannerRef}
      className="fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-2xl rounded-2xl border border-white/15 bg-[#111]/95 p-4 text-sm text-white/80 shadow-2xl backdrop-blur sm:flex sm:items-center sm:gap-4"
    >
      <p className="flex-1 leading-6">
        We use essential cookies to run the store, plus analytics and our advertising pixels (TikTok, Snapchat and Reddit) if you accept. Decline and none of those load. See our{" "}
        <Link href="/legal/cookies" className="text-white underline underline-offset-4">Cookie Policy</Link>.
      </p>
      <div className="mt-3 flex gap-2 sm:mt-0">
        <button type="button" onClick={() => dismiss("declined")} className="vl2-btn-secondary vl-focus-ring flex-1 px-4 py-2.5 text-xs sm:flex-none">Decline</button>
        <button type="button" onClick={() => dismiss("accepted")} className="vl2-btn-primary vl-focus-ring flex-1 px-5 py-2.5 text-xs sm:flex-none">Accept</button>
      </div>
    </div>
  );
}
