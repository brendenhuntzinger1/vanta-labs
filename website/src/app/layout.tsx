import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, Geist, Geist_Mono, Manrope } from "next/font/google";
import { Suspense } from "react";
import { AgeGate } from "@/components/age-gate";
import { CartDrawer } from "@/components/cart-drawer";
import { BacWaterAddedPopup } from "@/components/bac-water-upsell";
import { CartProvider } from "@/components/cart-context";
import { SiteAnalyticsTracker } from "@/components/site-analytics-tracker";
import { SiteFooter } from "@/components/site-footer";
import { CookieConsent } from "@/components/cookie-consent";
import { EntryDiagnostics } from "@/components/entry-diagnostics";
import { WelcomeOffer } from "@/components/welcome-offer";
import { ConsentedAnalytics } from "@/components/consented-analytics";
import { TikTokPixel } from "@/components/tiktok-pixel";
import { SnapPixel } from "@/components/snap-pixel";
import { RedditPixel } from "@/components/reddit-pixel";
import { TikTokCommerceEvents } from "@/components/tiktok-commerce-events";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-cormorant-display",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

// Falls back to the production domain (never localhost) so link-preview crawlers
// always resolve absolute Open Graph image URLs even if the env var is unset.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "https://vantalabsresearch.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Vanta Labs | Premium Research Peptides",
    template: "%s | Vanta Labs",
  },
  description: "Premium laboratory-grade research materials with verified quality standards and third-party COAs.",
  applicationName: "Vanta Labs",
  // Ads append their own tracking parameters to the landing URL. Without a
  // canonical, each variant is a separate page competing with the real one.
  alternates: { canonical: "/" },
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
    siteName: "Vanta Labs",
    title: "Vanta Labs | Premium Research Peptides",
    description: "Premium laboratory-grade research materials with verified quality standards and third-party COAs.",
    url: siteUrl,
    images: [{ url: "/images/og-vanta-labs.png", width: 1200, height: 630, alt: "Vanta Labs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vanta Labs | Premium Research Peptides",
    description: "Premium laboratory-grade research materials with verified quality standards and third-party COAs.",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${manrope.variable} h-full antialiased`}
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
      // The age-gate component flips this to "true" once, in memory, after all
      // four attestations are confirmed. Nothing persists it.
      data-age-verified="false"
      // The attribute above is updated client-side on confirmation, so the DOM
      // legitimately diverges from the server's output here.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Site-wide Organization + WebSite structured data for brand/knowledge
            panel eligibility. Rendered server-side so crawlers always see it. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "Vanta Labs",
                url: siteUrl,
                logo: `${siteUrl}/images/vanta-logo.png`,
                description: "Premium research peptides — third-party tested, made in the USA.",
              },
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                name: "Vanta Labs",
                url: siteUrl,
              },
            ]),
          }}
        />
        <CartProvider>
          <Suspense fallback={null}>
            <SiteAnalyticsTracker />
          </Suspense>
          <AgeGate>
            <WelcomeOffer />
            {children}
            <SiteFooter />
            {/* vl-bottom-bar lifts this out of the consent banner's way while
                the banner is on screen. Being fixed, the link cannot be
                scrolled clear, so without it the admin entry point is
                untappable on a phone until cookies are answered. */}
            <Link
              href="/vault"
              aria-label="Secure access"
              /* inline-flex + min-h-6 gives the box a 24px tap height while the
                 10px label and its faint colour are untouched — the link looks
                 exactly as before, it is simply reachable. */
              className="vl-bottom-bar fixed bottom-2 right-2 z-40 inline-flex min-h-6 items-center text-[10px] uppercase tracking-[0.2em] text-white/15 transition hover:text-white/45"
            >
              vault
            </Link>
            <CartDrawer />
            <BacWaterAddedPopup />
            <CookieConsent />
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
