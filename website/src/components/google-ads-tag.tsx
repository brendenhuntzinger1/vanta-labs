"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_ADS_TAG_ID } from "@/lib/ads/google-ads-tag-id";
import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

/**
 * The Google tag (gtag.js) for Google Ads — installed globally, behind the same
 * consent gate as TikTok, Snap and Reddit.
 *
 * Mounted once in the root layout so it is present on every page, and injected
 * with next/script at `afterInteractive`, which is the correct placement in the
 * App Router: Next puts it in the document rather than the React tree, so it
 * survives client navigation without re-executing the loader.
 *
 * GOOGLE'S INSTALL PAGE SAYS "immediately after the <head> element", AND THIS
 * DELIBERATELY DOES NOT DO THAT. Hard-coding an advertising tag into <head>
 * runs it for everyone, including the visitor who just chose Decline on a
 * banner promising that our advertising pixels load only if they accept.
 * Gating it here means gtag.js is never fetched for someone who declined — no
 * request to googletagmanager.com, no cookie, nothing to revoke. Placement in
 * the document is what Google is actually asking for, and afterInteractive
 * satisfies that; unconditional execution is not part of the requirement.
 *
 * ON CONSENT MODE (the "if you have end users in the EEA" notice on that same
 * install page): not implemented, on purpose. Consent Mode's default-denied
 * state does not stop the tag running — it loads gtag.js anyway and sends
 * COOKIELESS PINGS so Google can model the conversions it was not allowed to
 * observe. That is more contact with Google for a declining visitor, not less,
 * and it would directly falsify the sentence in our Cookie Policy that says no
 * request reaches the platform if you decline. Not loading at all is strictly
 * stronger than `denied`, and it is the promise the banner already makes. If
 * Consent Mode is ever wanted for EEA measurement, the policy has to change
 * first, in the same edit.
 *
 * The snippet below is Google's own, from the Google Ads install screen,
 * unmodified apart from the id being interpolated from the shared constant —
 * so it can be diffed against whatever the console currently generates without
 * having to read past reformatting.
 *
 * ON IDENTITY: nothing about the visitor is passed. Google's console will
 * offer Enhanced Conversions, which asks for `user_data` carrying a raw email
 * address or phone number in the browser tag. This does not do that, and
 * google-ads-tag-source.test.ts holds the line. The same rule the other three
 * integrations follow applies here: identity is attached on the server, only
 * on a confirmed paid order, and only ever as a SHA-256 digest.
 *
 * NO CONVERSION ACTION IS WIRED YET. `config` records the page view and the
 * remarketing hit, which is the whole of the "install the Google tag" step.
 * Reporting a purchase additionally needs a conversion action created in the
 * Google Ads console, which issues a send_to label of the form
 * `<tag id>/<conversion label>`; there is no way to invent that value here.
 * When it exists it belongs beside the other purchase legs, not in this
 * component. The id itself is deliberately not written out in this comment —
 * see the same note in ads-environment.ts: a second copy anywhere, prose
 * included, is precisely the drift google-ads-tag-source.test.ts exists to
 * catch.
 */

// Single source of truth, shared with any future server-side leg.
export { GOOGLE_ADS_TAG_ID } from "@/lib/ads/google-ads-tag-id";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function GoogleAdsTag() {
  const [accepted, setAccepted] = useState(false);
  /**
   * K-16. Consent is necessary and NOT sufficient: a preview deployment, a local
   * run, a CI job or a Playwright script must never reach the live ad account,
   * because the tag id falls back to a production value. See
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
    return subscribeToConsent(sync);
  }, []);

  // THERE IS DELIBERATELY NO ROUTE-CHANGE PAGE VIEW HERE, AND THIS IS THE ONE
  // PLACE THIS COMPONENT MUST NOT COPY THE OTHER THREE PIXELS.
  //
  // TikTok, Snap and Reddit each need a manual event on navigation: their SDKs
  // do not watch the History API, so in a single-page app every visit would
  // otherwise report exactly one page view however much of the site someone
  // read. All three components do that, correctly.
  //
  // gtag.js does watch it. Modelling this component on the other three added
  // `gtag('event','page_view')` on every route change, and it DOUBLE-COUNTED:
  // measured against the live tag, one client-side navigation produced two
  // hits to google.com/ccm/collect for the same URL — ours carrying
  // `ep.page_path`, and gtag's own carrying `ae=a`. Suppressing only ours left
  // exactly one hit still arriving, which is what proves the second is gtag's
  // and not a retry.
  //
  // So the whole of the SPA story is handled by the `config` call below.
  // Re-adding a manual page_view here inflates page views and remarketing-list
  // membership for the account; google-ads-tag-source.test.ts guards it.

  if (!adsAllowed) return null;
  if (!accepted) return null;

  return (
    <>
      <Script
        id="google-ads-tag-loader"
        src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_TAG_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-ads-tag" strategy="afterInteractive">
        {`
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', '${GOOGLE_ADS_TAG_ID}');
        `}
      </Script>
    </>
  );
}
