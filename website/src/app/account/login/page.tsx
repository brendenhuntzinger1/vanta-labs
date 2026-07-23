import { Suspense } from "react";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
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
    <div className="min-h-screen bg-[#08090c] text-white">
      <SiteHeader />
      <div className="mx-auto grid min-h-[calc(100vh-72px)] w-full max-w-6xl grid-cols-1 items-stretch gap-0 lg:grid-cols-2">
        {/* Brand / story panel — gives the page depth and context. */}
        <div className="relative hidden overflow-hidden border-r border-white/5 lg:flex lg:flex-col lg:justify-between lg:p-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_600px_at_15%_0%,rgba(16,185,129,0.16),transparent_60%),radial-gradient(700px_500px_at_100%_100%,rgba(56,189,248,0.10),transparent_55%)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:44px_44px]"
          />
          <div className="relative">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-white">Vanta Labs</p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.28em] text-emerald-300/80">Research Peptides</p>
          </div>
          <div className="relative max-w-md">
            <h2 className="vl2-serif text-4xl leading-[1.1] text-white">Research-grade purity, verified in every batch.</h2>
            <p className="mt-4 text-sm leading-7 text-white/60">
              Sign in to track orders, save addresses, and check out faster — with a Certificate of Analysis behind every vial.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                "Third-party tested — COA on every batch",
                "≥99% purity by HPLC",
                "Discreet, tracked U.S. shipping",
              ].map((point) => (
                <li key={point} className="flex items-center gap-3 text-sm text-white/75">
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="m5 12 4 4 10-10" /></svg>
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-[11px] uppercase tracking-[0.18em] text-white/30">For laboratory research use only</p>
        </div>

        {/* Form panel */}
        <div className="flex items-center justify-center px-4 py-14 sm:px-6 lg:px-10">
          <Suspense fallback={null}>
            <AccountAuthForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
