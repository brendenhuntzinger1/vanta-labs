"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { META_PIXEL_ID } from "@/lib/ads/meta-pixel-id";
import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

/**
 * Meta (Facebook) Pixel — installed globally, behind the same consent gate as
 * TikTok, Snap and Reddit.
 *
 * Mounted once in the root layout so it is present on every page, and injected
 * with next/script at `afterInteractive`, which is the correct placement in the
 * App Router: Next puts it in the document rather than the React tree, so it
 * survives client navigation without re-executing the loader.
 *
 * It is NOT hard-coded into <head> unconditionally, which is where Meta's
 * install screen asks for it, and that is deliberate. Dropping a third-party
 * advertising script before consent is the single most common finding in a
 * cookie audit, and the banner promises Decline is a real no-track path.
 * Gating it here means the SDK is never fetched for someone who declined — no
 * request to connect.facebook.net, no `_fbp` cookie, nothing to revoke.
 *
 * The loader below is Meta's own base code, unmodified, down to its
 * whitespace — so it can be diffed against whatever Events Manager currently
 * generates without having to read past reformatting.
 *
 * ON THE <noscript> IMAGE. Meta's base code ships with a 1x1 image fallback
 * for browsers without JavaScript. It is deliberately not rendered here: this
 * component only exists after consent, and consent itself is answered by
 * JavaScript, so a no-script visitor has never accepted. A no-script fallback
 * in the served HTML would send Meta a page view before any choice was made,
 * which is exactly what the gate exists to prevent. The image's only job was
 * a page view, and the same page view is sent by `fbq('track', 'PageView')`
 * the moment the consenting visitor's script runs.
 *
 * ON ADVANCED MATCHING. `fbq('init')` accepts a second argument of match keys
 * (em, ph, ...) and Meta's docs show a PLAINTEXT address there, hashed by its
 * SDK in the browser. This does not do that: init runs in the root layout,
 * which does not know who the visitor is, and this store's rule is that a
 * customer's identity reaches an ad platform only as a server-side SHA-256
 * digest on a paid order. Attaching that to Meta belongs to a Conversions API
 * leg, not to this loader; the `eventID` every event already carries is what
 * lets that leg be added later without double-counting anything.
 */

// Single source of truth, shared with any server-side Conversions API leg.
export { META_PIXEL_ID } from "@/lib/ads/meta-pixel-id";

declare global {
  interface Window {
    /**
     * The fourth argument carries `eventID`, which is how Meta collapses a
     * browser event and a Conversions API event describing the same action.
     */
    fbq?: (command: string, ...args: unknown[]) => void;
  }
}

export function MetaPixel() {
  const [accepted, setAccepted] = useState(false);
  /**
   * K-16. Consent is necessary and NOT sufficient: a preview deployment, a local
   * run, a CI job or a Playwright script must never reach the live ad account,
   * because the pixel ids fall back to production values. See
   * src/lib/ads/ads-environment.ts.
   *
   * Resolved in an effect rather than during render, and starting FALSE, for the
   * same reason `accepted` is: two of its inputs (location.hostname,
   * navigator.webdriver) exist only in the browser, so deciding during render
   * would make the server and the client disagree and React would hydrate onto
   * different markup. Starting closed also means the safe answer is the one that
   * survives a hydration failure.
   */
  const [adsAllowed, setAdsAllowed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAdsAllowed(browserAdsReportingAllowed().allowed);
  }, []);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The inline snippet fires PageView once on load. Skipping that first
  // route-change effect avoids double-counting the landing page.
  const initialPageSent = useRef(false);

  useEffect(() => {
    const sync = () => setAccepted(hasAcceptedConsent());
    sync();
    return subscribeToConsent(sync);
  }, []);

  // A single-page app: after the first load, navigation never reloads the
  // document, so without this every visit would report exactly one page view
  // however much of the site someone read.
  useEffect(() => {
    if (!adsAllowed || !accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.fbq?.("track", "PageView");
  }, [adsAllowed, accepted, pathname, searchParams]);

  if (!adsAllowed) return null;
  if (!accepted) return null;

  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {`
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');
      `}
    </Script>
  );
}
