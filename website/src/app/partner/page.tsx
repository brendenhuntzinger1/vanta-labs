import { Suspense } from "react";
import { PartnerProgramLanding } from "@/components/partner-program-landing";
import { getPartnerProgramStats } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

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
          <p className="text-xs uppercase tracking-[0.3em] text-rose-300">Partner Program Error</p>
          <h1 className="mt-3 text-2xl text-white sm:text-3xl">Supabase Query Failed</h1>
          <p className="mt-3 text-sm text-white/60">The full error is shown below so it can be fixed directly.</p>
          <pre className="mt-5 overflow-x-auto whitespace-pre-wrap border border-rose-500/30 bg-black p-4 text-xs text-rose-200 sm:text-sm">
            {errorMessage ?? "Partner stats payload was empty."}
          </pre>
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
