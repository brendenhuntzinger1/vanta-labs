"use client";

import { useEffect, useState } from "react";

import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

/**
 * The consent half of the Google tag. Renders nothing.
 *
 * The tag itself is emitted by the SERVER (see google-ads-tag.tsx), so it is in
 * the document before any JavaScript runs. This component exists only to mirror
 * the visitor's cookie choice into it: Consent Mode starts denied in the
 * snippet, and this is what grants it on Accept and takes it back on a
 * withdrawal.
 *
 * Split out rather than kept in one component because the two halves have
 * genuinely different requirements. The tag must be server-rendered or Google's
 * installation check cannot see it; the consent mirror must be client-side
 * because localStorage only exists there. Trying to be both made the whole tag
 * client-only, which is what kept it out of the HTML.
 *
 * Every call is optional-chained. If the tag was not emitted — a preview
 * deployment, a local run — `window.gtag` is undefined and each of these is a
 * no-op rather than an error.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const CONSENT_GRANTED = {
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
  analytics_storage: "granted",
} as const;

const CONSENT_DENIED = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
} as const;

export function GoogleAdsConsent() {
  // undefined = storage not read yet. Distinguished from `false` so no denied
  // update is sent before the answer is known: a visitor who accepted on a
  // previous page would otherwise get a denied update on every load, racing the
  // granted one a tick later.
  const [accepted, setAccepted] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const sync = () => setAccepted(hasAcceptedConsent());
    sync();
    return subscribeToConsent(sync);
  }, []);

  // Runs on withdrawal as well as on grant: someone who accepts and later
  // declines — here or in another tab, which subscribeToConsent also covers —
  // must go back to denied rather than keep the grant for the rest of the
  // session.
  useEffect(() => {
    if (accepted === undefined) return;
    window.gtag?.("consent", "update", accepted ? CONSENT_GRANTED : CONSENT_DENIED);
  }, [accepted]);

  return null;
}
