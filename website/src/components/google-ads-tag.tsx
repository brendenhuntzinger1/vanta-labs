import { adsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_ADS_TAG_ID } from "@/lib/ads/google-ads-tag-id";
import { GoogleAdsConsent } from "@/components/google-ads-consent";

/**
 * The Google tag (gtag.js) for Google Ads — SERVER-RENDERED, in the document,
 * the way Google's install screen describes.
 *
 * WHY THIS IS NOT A CLIENT COMPONENT, WHICH IS THE WHOLE POINT.
 *
 * It was one, and the tag was therefore absent from the served HTML entirely:
 * it only appeared after React hydrated and an effect ran. Measured on the
 * production build, `curl` of a page returned zero occurrences of
 * googletagmanager.com. Google's installation check reported "Your Google tag
 * wasn't detected", and any checker that does not execute JavaScript, or gives
 * up before hydration finishes, would say the same about a tag that is in fact
 * installed correctly. A tag that cannot be verified is a tag nobody can trust
 * is working.
 *
 * Rendering on the server also means it is not gated on
 * NEXT_PUBLIC_VERCEL_ENV, which Vercel only exposes to the browser when a
 * project has "Automatically expose System Environment Variables" switched on.
 * The server always has VERCEL_ENV. See the note on the environment gate below.
 *
 * WHY IT LOADS FOR EVERYONE, UNLIKE THE OTHER THREE PIXELS. TikTok, Snap and
 * Reddit are not fetched at all until a visitor clicks Accept. This tag is
 * present on every page, and Consent Mode v2 does the privacy work instead:
 * every storage signal starts DENIED, so before a visitor accepts
 *
 *   - no advertising cookie is written and no identifier is stored;
 *   - no ad_user_data or ad_personalization signal is sent;
 *   - Google receives only a cookieless ping — that a page was viewed, with
 *     nothing tying it to a person or to any other visit.
 *
 * Measured, not assumed: with nothing accepted the only hit is one POST to
 * pagead2.googlesyndication.com carrying gcs=G100, npa=1 and no auid, with the
 * remarketing and audience endpoints silent and document.cookie empty. On
 * Accept, GoogleAdsConsent grants the signals and _gcl_au appears.
 *
 * THIS IS A REAL TRADE-OFF, MADE DELIBERATELY. A declining visitor does load
 * gtag.js and does cause one cookieless ping, which is more contact than the
 * other three allow. The Cookie and Privacy policies describe this tag
 * SEPARATELY from the three pixels for exactly that reason, and must not be
 * collapsed back into one "nothing loads if you decline" sentence — which is
 * true of those three and false of this one. google-ads-tag-source.test.ts
 * fails if they ever are.
 *
 * The snippet below is Google's own, from the Google Ads install screen, with
 * two changes: the id comes from the shared constant, and the `consent default`
 * block is prepended. That block MUST come before `config` — a default set
 * afterwards is applied too late and the first hit goes out granted, with
 * nothing in the ad account showing that it did.
 *
 * ON IDENTITY: nothing about the visitor is passed, at any consent state.
 * Google's console offers Enhanced Conversions, which asks for `user_data`
 * carrying a raw email address or phone number in the browser tag. This does
 * not do that. Identity is attached on the server, only on a confirmed paid
 * order, and only ever as a SHA-256 digest.
 *
 * NO CONVERSION ACTION IS WIRED YET. `config` records the page view and the
 * remarketing hit, which is the whole of the "install the Google tag" step.
 * Reporting a purchase additionally needs a conversion action created in the
 * Google Ads console, which issues a send_to label of the form
 * `<tag id>/<conversion label>`; there is no way to invent that value here.
 * The id itself is deliberately not written out in this comment — see the same
 * note in ads-environment.ts.
 *
 * THERE IS DELIBERATELY NO ROUTE-CHANGE PAGE VIEW. gtag.js watches the History
 * API itself, unlike the other three SDKs. Adding one made every client-side
 * navigation report twice: ours carrying `ep.page_path` and gtag's own carrying
 * `ae=a`, to google.com/ccm/collect for the same URL. Suppressing only ours
 * left exactly one hit still arriving, which is what proves the second is
 * gtag's and not a retry.
 */

/**
 * K-16, resolved on the server, with two documented departures from
 * serverAdsReportingAllowed().
 *
 * Kept in full: a deployment must present VERCEL_ENV=production and a
 * production build. That is what stops a preview deployment or a local run
 * reporting into the live ad account, which matters because the tag id falls
 * back to the production account.
 *
 * NOT APPLIED — `ci`. serverAdsReportingAllowed() refuses when CI is set,
 * which is right for a test runner but wrong for markup: Vercel sets CI=1 for
 * every build, so any page prerendered at build time would be served without
 * the tag while request-rendered pages carried it. Production-ness is already
 * established by the two checks above; CI adds nothing here and silently
 * removes the tag from part of the site.
 *
 * NOT APPLIED — `hostname` and `webdriver`. Neither exists on a server leg, so
 * adsReportingAllowed skips both by design. Their absence is also what lets
 * Google's own installation check see the tag: that check drives an automated
 * browser, and navigator.webdriver would otherwise refuse the very request that
 * is trying to confirm the install. What such a browser can contribute is
 * bounded by Consent Mode to one cookieless ping; no conversion is wired at
 * all.
 *
 * This is a code-level, per-integration decision, not an env var. Nothing a
 * mistyped Vercel variable could flip reaches it.
 */
function tagIsPermittedHere(): boolean {
  return adsReportingAllowed({
    vercelEnv: process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
  }).allowed;
}

/**
 * The id is interpolated into an inline <script>, so it is checked rather than
 * trusted. It comes from NEXT_PUBLIC_GOOGLE_ADS_ID, which an operator sets, and
 * an unchecked value there would be an injection point into every page. A
 * Google Ads tag id is always "AW-" and digits; anything else is refused and
 * the tag simply does not render.
 */
const TAG_ID_SHAPE = /^AW-\d+$/;

export function GoogleAdsTag() {
  if (!tagIsPermittedHere()) return null;
  if (!TAG_ID_SHAPE.test(GOOGLE_ADS_TAG_ID)) return null;

  return (
    <>
      {/* Google tag (gtag.js) */}
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_TAG_ID}`} />
      <script
        dangerouslySetInnerHTML={{
          __html: `
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
`,
        }}
      />
      <GoogleAdsConsent />
    </>
  );
}
