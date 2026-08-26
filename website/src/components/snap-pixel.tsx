"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { countSnapPageView } from "@/lib/ads/snap-health-browser";

/**
 * Snap Pixel — installed globally, behind the same consent gate as everything
 * else.
 *
 * Mounted once in the root layout so it is present on every page, and injected
 * with next/script at `afterInteractive`, which is the correct placement in the
 * App Router: Next puts it in the document rather than the React tree, so it
 * survives client navigation without re-executing the loader.
 *
 * It is NOT hard-coded into <head> unconditionally, and that is deliberate.
 * Dropping a third-party advertising script before consent is the single most
 * common finding in a cookie audit, and the banner promises Decline is a real
 * no-track path. Gating it here means the SDK is never fetched for someone who
 * declined — no request to sc-static.net, no cookie, nothing to revoke.
 *
 * The loader below is Snapchat's own snippet, unmodified, down to its
 * whitespace — so it can be diffed against whatever the Snap console currently
 * generates without having to read past reformatting.
 *
 * ON THE EMPTY INIT OPTIONS: Snapchat's console will hand you this same snippet
 * with `{'user_email': '__INSERT_USER_EMAIL__'}` in that position. `{}` is the
 * deliberate choice, not an oversight. Left as the placeholder it sends that
 * literal string to Snap as the visitor's identity on every page load; filled
 * in, it sends a raw address to a third party on every page view. The root
 * layout does not know who the visitor is in any case. Identity is attached at
 * exactly one point — a confirmed paid order — and only ever as a SHA-256
 * digest produced on the server. See snap-events.ts.
 */

export const SNAP_PIXEL_ID = process.env.NEXT_PUBLIC_SNAP_PIXEL_ID ?? "b6e3f2b8-0d0a-4d4e-b547-24b5a20d2a6e";
const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

declare global {
  interface Window {
    snaptr?: (command: string, ...args: unknown[]) => void;
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

export function SnapPixel() {
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
  // The inline snippet fires PAGE_VIEW once on load. Skipping that first
  // route-change effect avoids double-counting the landing page.
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

  // A single-page app: after the first load, navigation never reloads the
  // document, so without this every visit would report exactly one page view
  // however much of the site someone read.
  useEffect(() => {
    if (!adsAllowed || !accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      // The snippet's own PAGE_VIEW, tallied here rather than in the snippet so
      // the loader stays byte-identical to Snapchat's — the admin board has no
      // other way to know a page view happened, since the call goes into the
      // vendor queue and leaves nothing behind to inspect.
      countSnapPageView();
      return;
    }
    window.snaptr?.("track", "PAGE_VIEW");
    countSnapPageView();
  }, [adsAllowed, accepted, pathname, searchParams]);

  if (!adsAllowed) return null;
  if (!accepted) return null;

  return (
    <Script id="snap-pixel" strategy="afterInteractive">
      {`
(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function()
{a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};
a.queue=[];var s='script';r=t.createElement(s);r.async=!0;
r.src=n;var u=t.getElementsByTagName(s)[0];
u.parentNode.insertBefore(r,u);})(window,document,
'https://sc-static.net/scevent.min.js');
snaptr('init', '${SNAP_PIXEL_ID}', {});
snaptr('track', 'PAGE_VIEW');
      `}
    </Script>
  );
}
