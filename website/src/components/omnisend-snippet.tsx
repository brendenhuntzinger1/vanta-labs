"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

/**
 * Omnisend website script — the store's email and SMS marketing platform,
 * installed site-wide behind the same consent gate as the TikTok, Snap and
 * Reddit pixels.
 *
 * WHAT IT IS. Omnisend's launcher renders the account's sign-up forms, feeds
 * its Live View and browse-abandonment automations with page views, and
 * links a visit to a contact record when someone subscribes through one of
 * its forms or arrives through a link in an Omnisend message. To do that it
 * sets a session identifier (30 minutes of inactivity) and a visitor
 * identifier (a year) in the browser. That is a tracker, and the cookie
 * policy promises that Decline "stops all non-essential storage" — so it is
 * held back until Accept exactly as the three pixels are, and named in the
 * banner and both policies the way they are.
 *
 * GATED BY NOT LOADING, NOT BY OMNISEND'S CONSENT API. Omnisend offers a
 * `consentManager.setConsent()` call for sites that load the launcher first
 * and tell it what it may do. That is weaker than what the banner promises:
 * the launcher would be fetched for someone who declined, and a script that
 * has been asked to behave is not the same as a script that is not there.
 * Here the SDK is never fetched before Accept, so there is no third-party
 * request, no cookie, and nothing to revoke.
 *
 * ENVIRONMENT-GATED TOO (K-16, see lib/ads/ads-environment.ts). The brand id
 * falls back to the live account, so a preview deployment, a local run or a
 * Playwright pass would otherwise register as real visitors in Omnisend —
 * and a browse-abandonment automation could send a real message over a QA
 * session. Same rule as every pixel: consent is necessary, not sufficient.
 *
 * PAGE VIEWS ONLY. The snippet is the one Omnisend's install screen
 * generates, verbatim apart from the brand id, and it reports `$pageViewed`
 * and nothing else. `identifyContact` is deliberately not called anywhere:
 * Omnisend's docs invite it "as soon as the customer logs in", which would
 * hand a raw email address to a third party from client code — something no
 * other integration here does (they send server-side SHA-256 digests, and
 * only where a policy paragraph says so). Omnisend learns an address only
 * when the visitor types it into an Omnisend form. omnisend-source.test.ts
 * fails if either of those changes without the policies changing with it.
 *
 * The brand id is not a secret: it ships to every visitor and names the
 * Omnisend account, not a credential. It is overridable by env so a staging
 * deployment can be pointed at a different account without a code change.
 */

const BRAND_ID = process.env.NEXT_PUBLIC_OMNISEND_BRAND_ID ?? "6aa09072ca3afa5724d4d71a";

/**
 * The id is interpolated into an inline <script>, so it is checked rather
 * than trusted. An Omnisend brand id is 24 hex characters; anything else is
 * refused and the script simply does not render.
 */
const BRAND_ID_SHAPE = /^[0-9a-f]{24}$/;

declare global {
  interface Window {
    /**
     * An array until the launcher loads (the snippet queues commands into it),
     * then the SDK's own object, whose `push` runs them directly. Both accept
     * the same command tuples, which is all this component ever sends.
     */
    omnisend?: { push: (command: unknown[]) => unknown };
  }
}

export function OmnisendSnippet() {
  const [accepted, setAccepted] = useState(false);
  /**
   * K-16. Consent is necessary and NOT sufficient: a preview deployment, a local
   * run, a CI job or a Playwright script must never reach the live account,
   * because the brand id falls back to the production value. See
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
  // The vendor snippet fires $pageViewed once on load. Skipping that first
  // route-change effect avoids double-counting the landing page view.
  const initialPageSent = useRef(false);

  useEffect(() => {
    const sync = () => setAccepted(hasAcceptedConsent());
    sync();
    return subscribeToConsent(sync);
  }, []);

  // This is a single-page app: after the first load, navigation never reloads
  // the document, so without this every visit would report exactly one page
  // view no matter how much of the site someone read. Optional-chained so a
  // blocked or not-yet-loaded SDK is a no-op rather than an error.
  useEffect(() => {
    if (!adsAllowed || !accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.omnisend?.push(["track", "$pageViewed"]);
  }, [adsAllowed, accepted, pathname, searchParams]);

  if (!adsAllowed) return null;
  if (!accepted) return null;
  if (!BRAND_ID_SHAPE.test(BRAND_ID)) return null;

  return (
    <Script id="omnisend-snippet" strategy="afterInteractive">
      {`
window.omnisend = window.omnisend || [];
omnisend.push(["brandID", "${BRAND_ID}"]);
omnisend.push(["track", "$pageViewed"]);
!function(){var e=document.createElement("script");e.type="text/javascript",e.async=!0,e.src="https://omnisnippet1.com/inshop/launcher-v2.js";var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t)}();
      `}
    </Script>
  );
}
