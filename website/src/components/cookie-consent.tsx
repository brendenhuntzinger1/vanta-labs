"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CONSENT_COOKIE_NAME } from "@/lib/cookie-consent-server";

const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Publish the choice where the SERVER can see it.
 *
 * localStorage alone is invisible to route handlers, and `/r/[code]` was
 * recording consent-gated data (utm_*, referrer, user agent, IP) because of it
 * — see src/lib/cookie-consent-server.ts. The cookie holds the same literal
 * "accepted"/"declined" string and no identifier of any kind; storing a
 * visitor's own privacy preference is essential storage under any reading of
 * the policy.
 */
function publishConsentCookie(choice: "accepted" | "declined") {
  try {
    document.cookie =
      `${CONSENT_COOKIE_NAME}=${choice}; path=/; max-age=${CONSENT_COOKIE_MAX_AGE}; samesite=lax`
      + (window.location.protocol === "https:" ? "; secure" : "");
  } catch {
    /* no-op — a browser that refuses the cookie is read as "unset", which is
       treated exactly like a decline. */
  }
}

// Analytics remains disabled until the visitor explicitly accepts. Essential
// store/session cookies continue to work regardless of this preference.
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setVisible(true);
      } else if (stored === "accepted" || stored === "declined") {
        // BACKFILL for anyone who answered before the cookie existed.
        //
        // Without this they keep the old behaviour forever: they have a
        // localStorage answer, so the banner never reappears, so the cookie is
        // never written, so every server route keeps reading "unset". That
        // would leave an accepting visitor under-served and, worse, leave a
        // DECLINING visitor indistinguishable from one who never answered.
        if (!document.cookie.split(";").some((c) => c.trim().startsWith(`${CONSENT_COOKIE_NAME}=`))) {
          publishConsentCookie(stored);
        }
      }
    } catch {
      // If storage is unavailable, don't nag.
    }
  }, []);

  /**
   * The banner used to publish its own height so bottom-anchored bars could
   * shift out from under it. It is no longer at the bottom, so nothing needs
   * to move: --cookie-banner-height goes unset and every consumer falls back
   * to its 0px default. The rules in globals.css that read it are left in
   * place and are simply inert.
   *
   * What DOES need to be published is the fact that the bar is up at all. The
   * site header is `position: fixed` at the top of the viewport, so an in-flow
   * bar above it is covered by it the moment the page scrolls — the consent
   * controls became unreachable, which is worse than the overlap this move
   * fixed. While the bar is pending the header joins normal flow underneath
   * it; the instant a choice is made the header is fixed again. Nothing
   * overlays anything at any point.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (visible) root.setAttribute("data-consent-pending", "true");
    else root.removeAttribute("data-consent-pending");
    return () => root.removeAttribute("data-consent-pending");
  }, [visible]);

  const dismiss = (choice: "accepted" | "declined") => {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* no-op */
    }
    publishConsentCookie(choice);
    window.dispatchEvent(new Event("vanta:cookie-consent"));
    setVisible(false);
  };

  if (!visible) return null;

  // IN THE DOCUMENT, NOT OVER IT.
  //
  // This used to be `fixed ... bottom-3`, and that is the whole problem: a
  // bottom-pinned overlay covers whatever content happens to sit at the bottom
  // of the viewport, and a tap aimed at that content lands on Accept or
  // Decline instead. Measured across 7 widths x 4 heights on three routes, the
  // 142-162px panel was covering 140 interactive controls — search inputs,
  // Filters, sort, COA status filters, wishlist buttons. Shrinking it reduces
  // the count but cannot reach zero, because any bottom overlay covers
  // something.
  //
  // So it no longer overlays. It is a compact bar in normal flow at the very
  // top of the page: it pushes content down by its own height, is never in
  // front of anything, and scrolls away with the page rather than following
  // the viewport. Nothing can be mis-tapped through it.
  //
  // The consent BEHAVIOUR is unchanged: nothing loads before a choice is made,
  // both options carry equal weight, the policy is one tap away, and the
  // decision is stored exactly as before, and the disclosure still NAMES EVERY
  // PIXEL. An earlier pass at this bar shortened the sentence and dropped
  // "TikTok, Snapchat and Reddit" to save two lines; the pixel source tests
  // caught it, correctly. Naming what accepting turns on is the substance of
  // the notice, not decoration, and it is not negotiable against layout.
  return (
    <div className="vl-consent-bar" role="region" aria-label="Cookie consent">
      <div className="vl-consent-inner">
        <p className="vl-consent-copy">
          Essential cookies run the store. Analytics and our advertising pixels (TikTok, Snapchat and Reddit) load only if you accept.{" "}
          {/* py-1.5 -my-1.5 gives the link a comfortably-over-24px tap box
              (WCAG 2.2 AA 2.5.8) without changing the line box it sits in.
              py-1 landed on exactly 24px, which rounds under the threshold. */}
          <Link href="/legal/cookies" className="-my-1.5 inline-block py-1.5 text-white underline underline-offset-4">
            Cookie Policy
          </Link>
        </p>
        <div className="vl-consent-actions">
          <button type="button" onClick={() => dismiss("declined")} className="vl-consent-btn vl-focus-ring">Decline</button>
          <button type="button" onClick={() => dismiss("accepted")} className="vl-consent-btn is-primary vl-focus-ring">Accept</button>
        </div>
      </div>
    </div>
  );
}
