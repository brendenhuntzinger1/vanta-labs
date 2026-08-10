"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
 * ON THE EMAIL PLACEHOLDER: the snippet Snapchat generates contains
 * `'user_email': '__INSERT_USER_EMAIL__'`. That literal must never ship — it
 * would send the placeholder string to Snap on every page load. Init carries no
 * email at all here. The root layout does not know who the visitor is, and
 * handing a third party a raw address on every page view to find out is a much
 * larger step than this site takes anywhere else.
 */

const SNAP_PIXEL_ID = process.env.NEXT_PUBLIC_SNAP_PIXEL_ID ?? "b6e3f2b8-0d0a-4d4e-b547-24b5a20d2a6e";
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
    if (!accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.snaptr?.("track", "PAGE_VIEW");
  }, [accepted, pathname, searchParams]);

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
snaptr('init', '${SNAP_PIXEL_ID}');
snaptr('track', 'PAGE_VIEW');
      `}
    </Script>
  );
}
