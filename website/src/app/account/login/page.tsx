import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { AccountAuthForm } from "@/components/account-auth-form";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

// Only allow internal, single-slash paths as a post-login destination — never
// an absolute URL — to prevent open-redirect abuse.
function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }
  return "/account";
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
      <SiteHeaderV2 />

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
        <section className="flex items-center justify-center px-4 pb-[calc(15rem+env(safe-area-inset-bottom))] pt-10 sm:px-6 sm:pt-14 lg:px-12 lg:pb-[calc(4rem+env(safe-area-inset-bottom))]">
          <div className="w-full max-w-[26rem]">
            <Suspense fallback={null}>
              <AccountAuthForm />
            </Suspense>

            {/* Mobile-only trust line. The desktop panel already says this. */}
            <p className="mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-white/25 lg:hidden">
              For laboratory research use only
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
