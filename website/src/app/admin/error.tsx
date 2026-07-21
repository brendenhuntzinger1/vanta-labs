"use client";

// Admin section error boundary. If any admin page fails to load (for example a
// database query hits a table or column that hasn't been migrated yet), this
// renders a clean, recoverable panel instead of a raw crash. The admin nav
// (from layout.tsx) stays in place, so the rest of the dashboard is still
// reachable while one section is having trouble.
import { useEffect } from "react";
import Link from "next/link";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in the server/browser logs for debugging without exposing details in the UI.
    console.error("Admin section error:", error);
  }, [error]);

  return (
    <div className="px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl rounded-2xl border border-amber-400/25 bg-amber-400/[0.04] p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">This section couldn&apos;t load</p>
        <h1 className="mt-3 text-xl font-semibold text-zinc-100 sm:text-2xl">Something needs attention here</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          This usually means the database is still missing a table or column this
          page needs. Running the latest schema sync in Supabase normally fixes
          it. The rest of your admin is unaffected — use the tabs above to keep
          working.
        </p>

        {error?.message ? (
          <pre className="mt-4 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-zinc-300">
            {error.message}
          </pre>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="vl-btn-primary px-4 py-2 text-sm">
            Try again
          </button>
          <Link href="/admin" className="vl-btn-secondary inline-flex px-4 py-2 text-sm">
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
