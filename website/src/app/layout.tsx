import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, Geist_Mono, Manrope } from "next/font/google";
import { Suspense } from "react";
import { AgeGate } from "@/components/age-gate";
import { CartDrawer } from "@/components/cart-drawer";
import { BacWaterAddedPopup } from "@/components/bac-water-upsell";
import { CartProvider } from "@/components/cart-context";
import { SiteAnalyticsTracker } from "@/components/site-analytics-tracker";
import { SiteFooter } from "@/components/site-footer";
import { CookieConsent } from "@/components/cookie-consent";
import { CONSENT_COOKIE_NAME } from "@/lib/cookie-consent-server";
import { EntryDiagnostics } from "@/components/entry-diagnostics";
import { RecoveryLinkCatcher } from "@/components/recovery-link-catcher";
import { StorefrontOffersBar } from "@/components/storefront-offers-bar";
import { StorefrontOfferModal } from "@/components/storefront-offer-modal";
import { cookies } from "next/headers";
import {
  OFFERS_DISMISSED_COOKIE,
  getStorefrontOffers,
  offerTag,
  parseDismissed,
  visibleOffers,
} from "@/lib/storefront-offers";
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  BRAND_LEGAL_NAME,
  TITLE_TEMPLATE,
  organizationSchema,
  siteUrl as resolveSiteUrl,
  webSiteSchema,
} from "@/lib/site-identity";
import { ConsentedAnalytics } from "@/components/consented-analytics";
import { TikTokPixel } from "@/components/tiktok-pixel";
import { SnapPixel } from "@/components/snap-pixel";
import { RedditPixel } from "@/components/reddit-pixel";
import { TikTokCommerceEvents } from "@/components/tiktok-commerce-events";
import "./globals.css";

// GEIST SANS IS NOT LOADED, BECAUSE NOTHING CUSTOMER-FACING COULD EVER RENDER IT.
//
// It was requested on every page and preloaded with the rest, but every
// font-family in globals.css listed it AFTER var(--font-manrope) -- so it could
// only ever be reached if Manrope failed, a case the system stack behind it
// already covers. Its one real consumer was Tailwind's `font-sans` token, used
// by two badges on the admin coupons screen; that token now points at Manrope,
// which is the sans this site actually sets.
//
// Geist MONO stays. It is the `font-mono` token and is genuinely rendered on
// customer pages -- batch numbers, peptide sequences and COA references on every
// product page, 65 usages outside /admin.

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// WEIGHTS ARE LOADED ONLY WHERE THEY ARE RENDERED.
//
// Verified by measuring the computed (family, weight, style) of every element
// that renders its own text across twelve routes at 390px — not by reading
// class names, since a weight can also arrive from globals.css or a browser
// default. What actually renders:
//
//   Fraunces  400 x11, 500 x80          Manrope  400 x1716, 500 x314,
//   Geist Mono 400 x8, 700 x2                    600 x1047, 700 x3
//
// Dropped, each confirmed unreachable rather than merely unseen:
//   * Fraunces 600 — requested only by .vl-heading-lg, which together with
//     .vl-heading-xl has zero usages in any .tsx. Both classes are dead CSS
//     and are left in place rather than deleted here.
//   * Manrope 800 — the only font-weight:800 in the repository is inline
//     style on email templates, and email clients never load these files.
//   * Fraunces italic — the sole occurrence of the word "italic" anywhere in
//     src/ was this declaration. No class, no <em>, no <i>, nothing computed.
//
// Kept: Manrope 700 despite only three occurrences. It is rendered.
//
// Note for later, not changed here: .vl-heading-xl asks Fraunces for 700,
// which was never among the loaded weights, so it has always been synthesised.
// The CSS variable was called --font-cormorant-display, left over from when
// this slot held Cormorant. Three offers-bar rules in globals.css
// (.vl-offer-headline, .vl-offer-sheet-title, .vl-offer-list-headline) asked
// for --font-fraunces instead — the name the font actually has — and that
// variable was defined nowhere, so all three had been silently rendering in
// the Georgia fallback. Confirmed in the built CSS, not just the source:
// grepping the shipped chunks for `--font-fraunces:` returned nothing while
// the rule referencing it was present.
//
// Renamed rather than repointed. Patching the three rules at
// --font-cormorant-display would have left a variable named after a font it
// does not hold, which is what caused this in the first place.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Falls back to the production domain (never localhost) so link-preview crawlers
// always resolve absolute Open Graph image URLs even if the env var is unset.
// The fallback is www, because the apex 308-redirects to it — see site-identity.ts.
const siteUrl = resolveSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: HOME_TITLE,
    template: TITLE_TEMPLATE,
  },
  description: HOME_DESCRIPTION,
  applicationName: BRAND_LEGAL_NAME,
  // NO `alternates` here. A canonical set on the ROOT LAYOUT is inherited by
  // every child route that does not set its own, and the relative path is not
  // re-resolved per route — so this one line put a canonical pointing at the
  // HOMEPAGE into the <head> of every research article, every legal policy and
  // /partner. Roughly thirty indexable URLs asked Google to drop them and fold
  // them into "/", while sitemap.xml simultaneously offered them for indexing.
  //
  // The homepage declares its own in page.tsx, which is the reason this line
  // was originally added (ad tracking parameters) and the correct place for it.
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/icon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/icons/icon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icons/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/icons/apple-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: BRAND_LEGAL_NAME,
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    url: siteUrl,
    images: [{ url: "/images/og-vanta-labs.png", width: 1200, height: 630, alt: "Vanta Labs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: ["/images/og-vanta-labs.png"],
  },
  // Only the real production deployment is indexable. Vercel preview/staging
  // deployments (VERCEL_ENV = "preview") and local dev must never be crawled —
  // otherwise a *.vercel.app URL competes with production and leaks pre-release
  // content into search.
  robots: process.env.VERCEL_ENV === "production"
    ? { index: true, follow: true }
    : { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // RESOLVED ENTIRELY ON THE SERVER, DISMISSALS INCLUDED.
  //
  // The bar is at the very top of the document, so anything that decides its
  // existence after first paint shoves the whole page down under the reader.
  // That rules out fetching the offers in the browser, and it equally rules out
  // keeping dismissals in localStorage — a dismissed bar would have to be
  // painted and then removed. A cookie travels with the request, so the server
  // can render the final answer once and the page never moves.
  //
  // Neither call may take the site down over a promotion, so both are guarded.
  const [allOffers, cookieStore] = await Promise.all([
    getStorefrontOffers().catch(() => []),
    cookies(),
  ]);
  const dismissed = new Set(parseDismissed(cookieStore.get(OFFERS_DISMISSED_COOKIE)?.value));
  const offers = visibleOffers(allOffers.filter((offer) => !dismissed.has(offerTag(offer.id))));

  // THE CONSENT BAR IS DECIDED HERE FOR THE SAME REASON THE OFFERS BAR IS.
  //
  // Both sit in normal flow above the page, so both push it down by their own
  // height. Deciding either one in the browser means painting the page and then
  // shoving it under the reader -- which is exactly what the consent bar did:
  // 52px on a desktop, 86px on a phone, about half a second after first paint,
  // and it was the largest single layout shift on every route we measured.
  //
  // The cookie is already written by the banner (see cookie-consent-server.ts,
  // which exists so route handlers can honour a decline). Reading it costs
  // nothing extra here -- `cookies()` is already awaited above for the offers
  // bar -- and it lets the server render the final answer once.
  //
  // An unrecognised value is deliberately NOT treated as an answer, matching
  // readCookieConsent: a corrupted cookie asks again rather than assuming.
  const consentValue = cookieStore.get(CONSENT_COOKIE_NAME)?.value;
  const consentAnswered = consentValue === "accepted" || consentValue === "declined";

  return (
    <html
      lang="en"
      className={`${geistMono.variable} ${fraunces.variable} ${manrope.variable} h-full antialiased`}
      // EVERY DOCUMENT STARTS UNVERIFIED.
      //
      // This was written by an inline script that read localStorage and a
      // cookie before first paint, so a returning visitor's stored attestation
      // could hide the gate. Age verification is no longer remembered at all
      // (see components/age-gate.tsx), so there is nothing to read and the
      // answer is a constant: false, on the server, for every request.
      //
      // Being static rather than script-written means it is also true with
      // JavaScript disabled — globals.css keys the scroll lock off this
      // attribute, so the storefront behind the gate is inert from the very
      // first paint rather than from hydration.
      //
      // The age-gate component flips this to "true" once the four attestations
      // are confirmed, and records that confirmation in sessionStorage so it
      // survives the full-document navigations a checkout makes. The inline
      // script at the top of <body> restores it before paint on later documents
      // in the same visit; a NEW visit has no key and is asked again.
      data-age-verified="false"
      // The attribute above is updated client-side on confirmation, so the DOM
      // legitimately diverges from the server's output here.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Restore this visit's age confirmation BEFORE the first paint.

            The attribute above is server-rendered "false" and the CSS keys the
            overlay off it, so without this the gate would flash on every
            full-document navigation within a visit — which is what pressing
            BACK from the payment page does. React cannot do this job: it only
            learns what is in sessionStorage after hydration, which is already
            too late to avoid the flash.

            Fail-closed by construction. Any throw, any missing key, any browser
            that refuses storage leaves the attribute exactly as the server
            wrote it, and the gate stays up. Nothing here can open the store —
            it can only restore a confirmation this visit already gave. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(sessionStorage.getItem("vl-age-confirmed-session")==="true"){document.documentElement.setAttribute("data-age-verified","true")}}catch(e){}',
          }}
        />
        {/* Site-wide Organization + WebSite structured data for brand/knowledge
            panel eligibility. Rendered server-side so crawlers always see it. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([organizationSchema(), webSiteSchema()]),
          }}
        />
        {/* Mounted OUTSIDE the age gate on purpose: a customer arriving on a
            misdirected password-reset link must be carried to the reset form
            before the gate can hold them on a page that has no such form. */}
        <RecoveryLinkCatcher />
        <CartProvider>
          <Suspense fallback={null}>
            <SiteAnalyticsTracker />
          </Suspense>
          <AgeGate>
            {/* Both in flow, above the header, so they overlay nothing. */}
            <CookieConsent initiallyOpen={!consentAnswered} />
            {/* REPLACES <WelcomeOffer />, RATHER THAN JOINING IT.
                The welcome offer is a promotion, and it is now resolved by
                storefront-offers.ts alongside every other live offer. Rendering
                both would put the same code on the screen twice, one above the
                other, at the top of a phone — the stacked-banner outcome this
                bar exists to avoid. One bar, every live offer, one source of
                truth. welcome-offer.tsx and its endpoint are left untouched and
                simply no longer mounted. */}
            <StorefrontOffersBar offers={offers} />
            {/* THE SAME ARRAY, NOT A SECOND LOOKUP OF THE SAME IDEA.
                The card announces the promotion once, centred, when a shopper
                first reaches the catalogue; the band above carries it from then
                on. Handing both the one resolved list is what makes it
                impossible for them to disagree with each other — or with the
                till, since resolveStorefrontOffers builds this list from the
                promotions checkout prices from.

                Rendered here rather than inside the catalogue page for the same
                reason the bar is: this is where the offers are already
                resolved, on the server, once. The card decides for itself which
                routes it belongs on. */}
            <StorefrontOfferModal offers={offers} />
            {children}
            <SiteFooter />
            {/* vl-bottom-bar lifts this out of the consent banner's way while
                the banner is on screen. Being fixed, the link cannot be
                scrolled clear, so without it the admin entry point is
                untappable on a phone until cookies are answered.

                z-30 keeps it BENEATH the app's full-width fixed bottom bars
                (account nav, product CTA, checkout CTA — all z-40/z-50). It
                used to be z-40 like them and, being rendered last, won the tie
                and painted on top: on a phone its 38x24 box sat over the
                bottom-right of every one of those bars. On /account that is
                exactly the "More" tab, the only route to Sign out and to
                Addresses/Notifications/Settings/Support/Wishlist — all of them
                untappable. On /checkout it sat over the corner of the pay
                button. A discreet staff shortcut must never outrank a
                customer's primary navigation, so it now yields to those bars
                and stays tappable everywhere they are absent. */}
            <Link
              href="/vault"
              aria-label="Secure access"
              /* inline-flex + min-h-6 gives the box a 24px tap height while the
                 10px label and its faint colour are untouched — the link looks
                 exactly as before, it is simply reachable. */
              className="vl-bottom-bar vl-staff-shortcut fixed bottom-2 right-2 z-30 inline-flex min-h-6 items-center text-[10px] uppercase tracking-[0.2em] text-white/15 transition hover:text-white/45"
            >
              vault
            </Link>
            <CartDrawer />
            <BacWaterAddedPopup />
          </AgeGate>
        </CartProvider>
        <ConsentedAnalytics />
        <Suspense fallback={null}>
          <TikTokPixel />
          <SnapPixel />
          <RedditPixel />
        </Suspense>
        <TikTokCommerceEvents />
        {/* Renders only for ?debug_entry=1 — see components/entry-diagnostics.tsx.
            It exists to answer, from inside an app's own browser, which build
            that browser was handed. Delete this line and the file to remove it. */}
        <EntryDiagnostics />
      </body>
    </html>
  );
}
