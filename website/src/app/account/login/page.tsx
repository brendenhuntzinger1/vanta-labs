import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AccountAuthForm } from "@/components/account-auth-form";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { safeInternalPath } from "@/lib/internal-path";

export const dynamic = "force-dynamic";

// Only allow internal, single-slash paths as a post-login destination — never
// an absolute URL — to prevent open-redirect abuse.
function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  return safeInternalPath(value, "/account");
}

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to your Vanta Labs account to track orders, rewards, and store credit.",
  // Transactional/auth surface: robots.ts already disallows these paths, and
  // this is the per-page half of the same statement, exactly as /cart does it.
  robots: { index: false, follow: false },
};

export default async function AccountLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const destination = safeNext(next);
  const user = await getAuthenticatedUser();

  if (user && detectRoleFromUser(user) === "customer") {
    redirect(destination);
  }

  return (
    <div className="vl-auth-shell relative min-h-screen overflow-hidden text-white">
      {/* NO SITE HEADER HERE, DELIBERATELY.
          This page is the front door now — with the catalog behind an account,
          it is the first screen of almost every visit. The full header put a
          cart icon, an account icon and a nav menu above the one decision the
          screen exists to ask for, and every one of those leads somewhere the
          visitor cannot go yet: the cart is empty and gated, the account is the
          page they are already on, and the menu links into the wall. The card
          carries the brand and the footer carries the public links. */}

      <main className="relative mx-auto grid w-full max-w-6xl grid-cols-1 items-stretch lg:grid-cols-[1.05fr_1fr]">
        {/* Brand panel — desktop only. Gives the page somewhere to breathe so
            the card is a considered composition rather than a stretched form. */}
        <section className="relative hidden overflow-hidden border-r border-white/[0.05] lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:52px_52px]"
          />
          <div className="relative">
            <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.34em] text-white">Vanta Labs</p>
            <p className="mt-1.5 text-[10px] uppercase tracking-[0.3em] text-[color:var(--accent-gold)]/75">Research Peptides</p>
          </div>

          <div className="relative max-w-md">
            <h2 className="vl2-serif text-[2.75rem] leading-[1.08] tracking-[-0.015em] text-white">
              Research-grade purity, verified in every batch.
            </h2>
            <p className="mt-5 text-[0.9375rem] leading-7 text-white/50">
              Sign in to track orders, save addresses, and check out faster — with a Certificate of Analysis behind every vial.
            </p>
            <ul className="mt-9 space-y-3.5">
              {[
                "Third-party tested — COA on every batch",
                "≥99% purity, verified by HPLC",
                "Discreet, tracked U.S. shipping",
                "Damaged or incorrect orders made right",
              ].map((point) => (
                <li key={point} className="flex items-center gap-3 text-[0.875rem] text-white/65">
                  <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[color:var(--accent-gold)]/25 bg-[var(--accent-gold-soft)] text-[color:var(--accent-gold)]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m5 12 4 4 10-10" /></svg>
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <p className="relative text-[10px] uppercase tracking-[0.2em] text-white/35">For laboratory research use only</p>
        </section>

        {/* Form panel. px-4 keeps a 16px gutter on the narrowest phone, and the
            safe-area padding stops the links colliding with the home indicator.
            The generous mobile bottom padding is deliberate: the global cookie
            banner is fixed to the bottom of the viewport and, on a 375px
            screen, sits directly over the Sign In button. Without room to
            scroll, the primary action is unreachable until the banner is
            dismissed. This gives the card somewhere to move. */}
        <section className="flex items-center justify-center px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-10 sm:px-6 sm:pt-14 lg:px-12 lg:pb-[calc(4rem+env(safe-area-inset-bottom))]">
          <div className="w-full max-w-[26rem]">
            <Suspense fallback={null}>
              <AccountAuthForm />
            </Suspense>

            {/* THE MOBILE HALF OF THE PITCH, WHICH DID NOT EXIST.

                The brand panel opposite carries the whole value proposition —
                the headline, the four proof points — and it is `hidden lg:flex`,
                so a phone renders none of it. Most of the traffic that reaches
                this page is mobile and arriving cold from an ad, and what it
                got was a form and one line of small caps.

                BELOW THE CARD, DELIBERATELY. The Google button already ends at
                695px on a 390x844 viewport with the consent bar above it, and
                708px is recorded as under the fold on a real handset, so
                anything added above the fold here costs the fast path its
                place on the screen. This is what a hesitating visitor finds
                when they scroll, which is exactly when reassurance is worth
                reading.

                EVERY CLAIM CHECKED AGAINST PRODUCTION, 2026-09-14. 38 COA
                records, all published, and every purity value on them reads
                ">99%". The desktop panel's "COA on every batch" is NOT
                repeated: 27 of 34 published products carry one, so the
                universal claim is not true and is not made here. */}
            <div className="mt-8 lg:hidden">
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[14px] border border-white/[0.07] bg-white/[0.05]">
                {[
                  { k: "Batch", v: "tested" },
                  { k: ">99%", v: "purity" },
                  { k: "Discreet", v: "shipping" },
                ].map((item) => (
                  <div key={item.k} className="bg-[#0d0e11] px-2 py-3.5 text-center">
                    <p className="text-[0.8125rem] font-semibold leading-4 tracking-[-0.01em] text-white/85">{item.k}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-white/40">{item.v}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-center text-[0.8125rem] leading-5 text-white/45">
                Certificates of analysis on file, published per batch.
              </p>
              <p className="mt-5 text-center text-[11px] uppercase tracking-[0.2em] text-white/25">
                For laboratory research use only
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
