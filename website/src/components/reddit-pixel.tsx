"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Reddit Pixel — installed globally, behind the same consent gate as TikTok and
 * Snap.
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
 * declined — no request to redditstatic.com, no cookie, nothing to revoke.
 *
 * The loader below is Reddit's own snippet, unmodified, so it can be diffed
 * against whatever the Reddit Ads console currently generates without having to
 * read past reformatting. Reddit's snippet ships with the comment "DO NOT
 * MODIFY UNLESS TO REPLACE A USER IDENTIFIER"; the only substitution made is
 * the pixel id, and it is the same id the snippet arrived with.
 *
 * ON IDENTITY: Reddit's `rdt('init', ...)` accepts an optional second argument
 * carrying an email or an external id. It is deliberately absent. The root
 * layout does not know who the visitor is, and sending an address to a third
 * party on every page load is exactly what the TikTok and Snap integrations go
 * out of their way not to do — identity there is attached at one point only, a
 * confirmed paid order, and only ever as a SHA-256 digest produced on the
 * server. Nothing here should be the exception.
 */

export const REDDIT_PIXEL_ID = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID ?? "a2_jipuxv3ugrju";
const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

declare global {
  interface Window {
    rdt?: (command: string, ...args: unknown[]) => void;
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

export function RedditPixel() {
  const [accepted, setAccepted] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The inline snippet fires PageVisit once on load. Skipping that first
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
    if (!accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.rdt?.("track", "PageVisit");
  }, [accepted, pathname, searchParams]);

  if (!accepted) return null;

  return (
    <Script id="reddit-pixel" strategy="afterInteractive">
      {`
!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js?pixel_id=${REDDIT_PIXEL_ID}",t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);rdt('init','${REDDIT_PIXEL_ID}');rdt('track', 'PageVisit');
      `}
    </Script>
  );
}
