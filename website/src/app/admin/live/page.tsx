import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getLiveVisitors } from "@/lib/admin-live-visitors";
import { settleRead } from "@/lib/admin-read";
import { AdminLiveVisitorsClient } from "@/components/admin-live-visitors-client";

export const dynamic = "force-dynamic";

export default async function AdminLivePage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  // A first paint from the server (so the page isn't blank while the first
  // client poll is in flight); the client component takes it from here every
  // 5s. A failed read renders as "unknown", not as "nobody's here" — same
  // convention as every other admin figure (admin-read.ts).
  const read = await settleRead("Live visitors", getLiveVisitors);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-white">Live Visitors</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Who&apos;s on the site right now — named when they&apos;re signed in, anonymous otherwise. Your own
          admin session is never counted.
        </p>

        <AdminLiveVisitorsClient initial={read.ok ? read.value : []} initialUnavailable={!read.ok} />
      </div>
    </div>
  );
}
