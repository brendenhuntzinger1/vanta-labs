import type { ReactNode } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";

// Shared shell for the static legal pages. Content is a launch-ready TEMPLATE —
// the store owner should review and replace it with counsel-approved copy.
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-3xl px-6 pb-24 pt-32 lg:px-12">
        <p className="vl2-eyebrow">Legal</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">{title}</h1>
        <p className="mt-2 text-xs text-white/40">Last updated: {updated}</p>

        <div className="mt-5 rounded-lg border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-xs leading-5 text-amber-200/90">
          Template notice: review this policy with legal counsel and replace it with your finalized text before launch.
        </div>

        <div className="mt-8 space-y-6 text-sm leading-7 text-white/70 [&_h2]:vl2-serif [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:text-white [&_a]:text-white [&_a]:underline-offset-4 hover:[&_a]:underline">
          {children}
        </div>
      </main>
    </div>
  );
}
