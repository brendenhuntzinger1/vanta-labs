"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_ADS_ID, isConfiguredGoogleAdsId } from "@/lib/ads/google-conversion-id";
import { countGooglePageView, shouldLoadGoogleTag } from "@/lib/ads/google-health-browser";

/**
 * Google Ads global site tag — installed globally, behind the same consent gate
 * as everything else.
 *
 * Mounted once in the root layout so it is present on every page, and injected
 * with next/script at `afterInteractive`, which is the correct placement in the
 * App Router: Next puts it in the document rather than the React tree, so it
 * survives client navigation without re-executing the loader.
 *
 * It is NOT hard-coded into <head> unconditionally, and that is deliberate.
 * Dropping a third-party advertising script before consent is the single most
 * common finding in a cookie audit, and the banner promises Decline is a real
 * no-track path. Gating it here means the tag is never fetched for someone who
 * declined — no request to googletagmanager.com, no cookie, nothing to revoke.
 *
 * THE THIRD GATE IS THE CONVERSION ID ITSELF. Unlike the other three pixels,
 * this one has no production fallback value, so an unconfigured deployment
 * renders nothing at all. That is what lets this component ship before the
 * Google Ads account exists.
 *
 * ON THE CONFIG OBJECT: Google's own setup guides put an identity object or a
 * contact-address field in this position. Both are omitted deliberately. Left
 * as a placeholder it sends a literal string to Google as the visitor's
 * identity on every page load; filled in, it sends a raw contact detail to a
 * third party on every page view. The root layout does not know who the
 * visitor is in any case.
 * Identity is attached at exactly one point — a confirmed paid order — and only
 * ever as a SHA-256 digest produced on the server. See google-events.ts.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

function hasAccepted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "accepted";
  } catch {
    // Storage blocked (private mode, some in-app browsers). Absence of a
    // recorded "yes" is a no.
    return false;
  }
}

export function GooglePixel() {
  const [accepted, setAccepted] = useState(false);
  /**
   * Consent is necessary and NOT sufficient: a preview deployment, a local run,
   * a CI job or a Playwright script must never reach the live ad account. See
   * src/lib/ads/ads-environment.ts.
   *
   * Resolved in an effect rather than during render, and starting FALSE, because
   * two of its inputs (location.hostname, navigator.webdriver) exist only in the
   * browser, so deciding during render would make the server and the client
   * disagree and React would hydrate onto different markup. Starting closed also
   * means the safe answer is the one that survives a hydration failure.
   */
  const [adsAllowed, setAdsAllowed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAdsAllowed(browserAdsReportingAllowed().allowed);
  }, []);

  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The inline snippet's own config call reports the first page view. Skipping
  // that first route-change effect avoids double-counting the landing page.
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
    if (!shouldLoadGoogleTag({ accepted, adsAllowed, conversionIdConfigured: isConfiguredGoogleAdsId(GOOGLE_ADS_ID) })) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      countGooglePageView();
      return;
    }
    window.gtag?.("event", "page_view");
    countGooglePageView();
  }, [adsAllowed, accepted, pathname, searchParams]);

  if (!shouldLoadGoogleTag({ accepted, adsAllowed, conversionIdConfigured: isConfiguredGoogleAdsId(GOOGLE_ADS_ID) })) {
    return null;
  }

  return (
    <>
      <Script id="google-tag-loader" strategy="afterInteractive" src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`} />
      <Script id="google-tag-config" strategy="afterInteractive">
        {`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GOOGLE_ADS_ID}');
        `}
      </Script>
    </>
  );
}
