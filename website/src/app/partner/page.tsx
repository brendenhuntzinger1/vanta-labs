import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PartnerProgramLanding } from "@/components/partner-program-landing";
import { getPartnerProgramStats } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Partner Program",
  description: "Partner with Vanta Labs. Earn competitive commissions referring researchers to premium, third-party verified research compounds.",
};

async function getPartnerPageData() {
  try {
    const stats = await getPartnerProgramStats();
    return { stats, errorMessage: null as string | null };
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    console.error("Partner page failed:", message);
    return { stats: null, errorMessage: message };
  }
}

export default async function PartnerProgramPage() {
  const { stats, errorMessage } = await getPartnerPageData();

  if (errorMessage || !stats) {
    return (
      <div className="min-h-screen bg-[#0b0b0b] px-4 py-12 text-white sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl border border-white/10 p-6 sm:p-8">
          <p className="text-xs uppercase tracking-[0.3em] text-rose-300">Partner Program</p>
          <h1 className="mt-3 text-2xl text-white sm:text-3xl">This page is temporarily unavailable</h1>
          <p className="mt-3 text-sm text-white/60">
            We couldn&apos;t load the partner program right now. Please try again shortly or{" "}
            <Link href="/contact" className="text-white underline-offset-4 hover:underline">contact us</Link> if it persists.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <PartnerProgramLanding initialStats={stats} />
    </Suspense>
  );
}
