"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_ADS_TAG_ID } from "@/lib/ads/google-ads-tag-id";
import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

/**
 * The Google tag (gtag.js) for Google Ads — installed the way Google's install
 * screen describes, with Consent Mode v2 doing the privacy work.
 *
 * WHY THIS DIFFERS FROM THE OTHER THREE PIXELS. TikTok, Snap and Reddit are not
 * loaded at all until a visitor clicks Accept: their components return null, so
 * no SDK is ever fetched for someone who declined. This tag is deliberately NOT
 * built that way. Google's install page says to place the snippet on every page
 * of the site, and Google's own "Test installation" check loads the page without
 * touching the cookie banner — so a tag that only appears after Accept can never
 * be verified, and reports as not installed forever.
 *
 * Consent Mode is the mechanism Google's install screen itself points at (the
 * "if you have end users in the EEA" notice beside the snippet). The tag loads
 * on every page, but every storage signal starts DENIED, so before a visitor
 * accepts:
 *
 *   - no advertising cookie is written and no identifier is stored;
 *   - no ad_user_data or ad_personalization signal is sent;
 *   - Google receives only a cookieless ping — that a page was viewed, with no
 *     identifier tying it to a person or to any other visit.
 *
 * On Accept the tag sends `consent update` with the same signals granted, and
 * ordinary measurement begins. On Decline — or a withdrawal made later, in this
 * tab or another — it sends the update with everything denied and stays there.
 *
 * THIS IS A REAL TRADE-OFF AND IT WAS MADE DELIBERATELY. A declining visitor
 * does load gtag.js and does cause one cookieless ping to Google, which is more
 * contact than the other three allow. The Cookie and Privacy policies describe
 * this tag separately from the three pixels for exactly that reason; they must
 * not be collapsed back into one "nothing loads if you decline" sentence, which
 * would be false for this tag. If the stricter behaviour is ever wanted, the
 * component goes back to returning null before consent AND the policy changes
 * in the same edit AND Google's install check stops passing.
 *
 * The snippet below is Google's own, from the Google Ads install screen, with
 * two changes: the id comes from the shared constant, and the `consent default`
 * block is prepended. That block MUST come before `config` — a default set
 * afterwards is applied too late and the first hit goes out granted.
 *
 * ON IDENTITY: nothing about the visitor is passed, at any consent state.
 * Google's console offers Enhanced Conversions, which asks for `user_data`
 * carrying a raw email address or phone number in the browser tag. This does
 * not do that, and google-ads-tag-source.test.ts holds the line. Identity is
 * attached on the server, only on a confirmed paid order, and only ever as a
 * SHA-256 digest.
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
 *
 * THERE IS DELIBERATELY NO ROUTE-CHANGE PAGE VIEW, which is the one place this
 * must not copy the other three. Their SDKs do not watch the History API, so
 * each fires a manual event on navigation. gtag.js does watch it. Modelled on
 * the other three, this component double-counted: one client-side navigation
 * produced two hits to google.com/ccm/collect for the same URL — ours carrying
 * `ep.page_path`, and gtag's own carrying `ae=a`. Suppressing only ours left
 * exactly one hit still arriving, which is what proves the second is gtag's and
 * not a retry. The `config` call handles the whole SPA story.
 */

// Single source of truth, shared with any future server-side leg.
export { GOOGLE_ADS_TAG_ID } from "@/lib/ads/google-ads-tag-id";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Consent Mode v2 signals, in both states.
 *
 * All four are named explicitly in both objects rather than spreading a base:
 * an unnamed signal keeps whatever it had, so a partial update is how a granted
 * signal survives a withdrawal. Being exhaustive is what makes Decline mean
 * Decline.
 */
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

export function GoogleAdsTag() {
  // undefined = storage not read yet. Distinguished from `false` so the consent
  // update is not sent before the answer is known: a visitor who accepted on a
  // previous page would otherwise get a denied update on every load, racing the
  // granted one a tick later.
  const [accepted, setAccepted] = useState<boolean | undefined>(undefined);

  /**
   * K-16, with ONE documented exception.
   *
   * The environment gate exists so a preview deployment, a local run or a CI job
   * never reports into the live ad account — the tag id falls back to the
   * production account, so absence of a check means junk data trains the real
   * bid optimiser. Those refusals are kept in full.
   *
   * The exception is `automated_browser`. That rule refuses any browser setting
   * navigator.webdriver, which is what Google's own installation check drives —
   * so honouring it here would mean the tag can never be verified as installed,
   * on a correctly installed tag, forever. It is tolerated ONLY when it is the
   * sole reason: a preview deployment driven by Playwright is still refused,
   * because `not_production_environment` is reported first (see the ordering
   * note in ads-environment.ts, which is why reading one reason is safe).
   *
   * What an automated browser can contribute is bounded by Consent Mode: it does
   * not click Accept, so it stays denied and produces a cookieless ping with no
   * identifier. No conversion is wired at all.
   *
   * This is a code-level, per-integration distinction, not an env var. The "no
   * override" rule in ads-environment.ts is about a switch a mistyped Vercel
   * variable could flip; nothing in a deployment's configuration reaches this.
   *
   * Resolved in an effect rather than during render, and starting FALSE, because
   * two of its inputs (location.hostname, navigator.webdriver) exist only in the
   * browser: deciding during render would make the server and client disagree
   * and React would hydrate onto different markup. Starting closed also means
   * the safe answer survives a hydration failure.
   */
  const [envAllowed, setEnvAllowed] = useState(false);

  useEffect(() => {
    const verdict = browserAdsReportingAllowed();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnvAllowed(verdict.allowed || verdict.reason === "automated_browser");
  }, []);

  useEffect(() => {
    const sync = () => setAccepted(hasAcceptedConsent());
    sync();
    return subscribeToConsent(sync);
  }, []);

  // Mirror the visitor's choice into the tag, now and on every later change.
  //
  // Runs on withdrawal as well as on grant: someone who accepts and later
  // declines — here or in another tab, which subscribeToConsent also covers —
  // must go back to denied rather than keep the grant for the rest of the
  // session.
  useEffect(() => {
    if (!envAllowed || accepted === undefined) return;
    window.gtag?.("consent", "update", accepted ? CONSENT_GRANTED : CONSENT_DENIED);
  }, [envAllowed, accepted]);

  if (!envAllowed) return null;

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

  gtag('consent', 'default', {
    'ad_storage': 'denied',
    'ad_user_data': 'denied',
    'ad_personalization': 'denied',
    'analytics_storage': 'denied',
    'wait_for_update': 500
  });

  gtag('js', new Date());

  gtag('config', '${GOOGLE_ADS_TAG_ID}');
        `}
      </Script>
    </>
  );
}
