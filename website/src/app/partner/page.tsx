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
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
        <div className="vl-panel mx-auto max-w-5xl rounded-2xl p-6 sm:p-8">
          <p className="text-xs uppercase tracking-[0.3em] text-rose-300">Partner Program Error</p>
          <h1 className="mt-3 text-2xl font-semibold text-white sm:text-3xl">Supabase Query Failed</h1>
          <p className="mt-3 text-sm text-zinc-300">The full error is shown below so it can be fixed directly.</p>
          <pre className="mt-5 overflow-x-auto whitespace-pre-wrap rounded-xl border border-rose-500/30 bg-zinc-950 p-4 text-xs text-rose-200 sm:text-sm">
            {errorMessage ?? "Partner stats payload was empty."}
          </pre>
        </div>
      </div>
    );
  }

  return <PartnerProgramLanding initialStats={stats} />;
}
