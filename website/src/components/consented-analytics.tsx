"use client";

import { Analytics } from "@vercel/analytics/next";
import { useEffect, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

/**
 * Vercel Analytics, behind the same consent gate as everything else.
 *
 * It used to mount unconditionally at the bottom of the root layout, outside
 * both the age gate and any consent check — so it ran for visitors who had just
 * clicked "Decline" on a banner promising that analytics would not run. The
 * first-party tracker honours that choice strictly; this did not. One of them
 * was lying, and a consent gate that is selectively enforced is not one.
 *
 * Mirrors `site-analytics-tracker.tsx`: same storage key, same `accepted`
 * comparison, same event to re-read after a choice is made.
 *
 * This changes WHEN an existing first-party measurement script loads. It does
 * not add, enable or prepare any advertising tracker.
 */


export function ConsentedAnalytics() {
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

  useEffect(() => {
    const sync = () => setAccepted(hasAcceptedConsent());
    sync();

    // The banner fires this on accept/decline; `storage` covers a choice made
    // in another tab.
    return subscribeToConsent(sync);
  }, []);

  if (!adsAllowed) return null;
  if (!accepted) return null;
  return <Analytics />;
}
