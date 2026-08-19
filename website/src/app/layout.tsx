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
      // The inline script below writes data-age-verified onto this element
      // before React hydrates, so the DOM legitimately differs from the
      // server's output here.
      suppressHydrationWarning
    >
      <head>
        {/*
          RESOLVE THE AGE GATE BEFORE THE FIRST PAINT.

          Whether someone already confirmed their age lives in localStorage and
          a cookie mirror — neither of which exists during server rendering. So
          the server sends the gate to EVERYONE, and the gate's own effect
          removed it after hydration. That is a `useEffect`, which runs after
          paint: returning visitors watched the "Restricted Access · 21+" panel
          flash for ~270ms on every single page load.

          This script runs synchronously while the browser parses the HTML —
          before anything is painted — and records the answer as an attribute
          that CSS reacts to (see globals.css). It reads exactly the same two
          sources, in the same order, as getAgeVerifiedSnapshot() in
          components/age-gate.tsx, so the script and React can never disagree.

          Fails CLOSED: any error, or JavaScript disabled entirely, leaves the
          attribute unset or "false" and the gate is shown. This never lets
          anyone past the gate who has not confirmed — it only stops the panel
          being shown to someone who already did.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){var v="false";try{if(localStorage.getItem("vanta-labs-age-verified")==="true"||document.cookie.split("; ").indexOf("vl_age_verified=true")>-1){v="true"}}catch(e){}document.documentElement.setAttribute("data-age-verified",v)})()',
          }}
        />
      </head>
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
              className="vl-bottom-bar fixed bottom-2 right-2 z-40 text-[10px] uppercase tracking-[0.2em] text-white/15 transition hover:text-white/45"
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
      </body>
    </html>
  );
}
