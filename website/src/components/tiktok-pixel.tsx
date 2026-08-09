"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * TikTok Pixel.
 *
 * Loaded only after the visitor accepts cookies — the same gate the first-party
 * tracker and Vercel Analytics use. That is stronger than TikTok's own
 * `holdConsent`: the SDK is never fetched at all for someone who declined, so
 * there is no third-party request, no cookie, and nothing to revoke. The cookie
 * banner promises Decline is a real no-track path, and an advertising pixel is
 * the last place to make that promise conditional.
 *
 * The pixel id is not a secret. It ships to every browser by design and
 * identifies the ad account, not the advertiser's credentials. It is
 * overridable by env so a staging account can be pointed elsewhere without a
 * code change.
 */

const PIXEL_ID = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID ?? "D9SAES3C77U40SOI9D70";
const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

declare global {
  interface Window {
    ttq?: {
      page: () => void;
      /** Advanced Matching. Values must already be SHA-256 digests. */
      identify: (payload: { email?: string; phone_number?: string; external_id?: string }) => void;
      /**
       * The third argument carries `event_id`, which is how TikTok collapses a
       * browser event and a server-side Events API event describing the same
       * conversion. Without it a purchase reported by both would count twice.
       */
      track: (event: string, params?: Record<string, unknown>, options?: { event_id: string }) => void;
    };
  }
}

function hasAccepted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "accepted";
  } catch {
    // Storage blocked (private mode, some in-app browsers). Absence of a
    // recorded "yes" is a no.
    return false;
  }
}

export function TikTokPixel() {
  const [accepted, setAccepted] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The vendor snippet fires page() once on load. Skipping that first
  // route-change effect avoids double-counting the landing page view.
  const initialPageSent = useRef(false);

  useEffect(() => {
    const sync = () => setAccepted(hasAccepted());
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // This is a single-page app: after the first load, navigation never reloads
  // the document, so without this every visit would report exactly one page
  // view no matter how much of the site someone read.
  useEffect(() => {
    if (!accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.ttq?.page();
  }, [accepted, pathname, searchParams]);

  if (!accepted) return null;

  return (
    <Script id="tiktok-pixel" strategy="afterInteractive">
      {`
!function (w, d, t) {
  w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(
var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script")
;n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};

  ttq.load('${PIXEL_ID}');
  ttq.page();
}(window, document, 'ttq');
      `}
    </Script>
  );
}
