import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, Geist, Geist_Mono, Manrope } from "next/font/google";
import { Suspense } from "react";
import { AgeGate } from "@/components/age-gate";
import { CartDrawer } from "@/components/cart-drawer";
import { CartProvider } from "@/components/cart-context";
import { SiteAnalyticsTracker } from "@/components/site-analytics-tracker";
import { SiteFooter } from "@/components/site-footer";
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

export const metadata: Metadata = {
  title: "Vanta Labs | Premium Research Peptides",
  description: "Premium laboratory-grade products and verified quality standards.",
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
    >
      <body className="min-h-full flex flex-col">
        <CartProvider>
          <Suspense fallback={null}>
            <SiteAnalyticsTracker />
          </Suspense>
          <AgeGate>
            {children}
            <SiteFooter />
            <Link
              href="/vault"
              aria-label="Secure access"
              className="fixed bottom-2 right-2 z-40 text-[10px] uppercase tracking-[0.2em] text-white/15 transition hover:text-white/45"
            >
              vault
            </Link>
            <CartDrawer />
          </AgeGate>
        </CartProvider>
      </body>
    </html>
  );
}
