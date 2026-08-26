import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getBucketCounts } from "@/lib/fulfillment-queues";
import { getOpenCriticalAlertCount } from "@/lib/monitoring";
import { EMPTY_WORK_QUEUE, summarizeWorkQueue } from "@/lib/admin-work-queue";
import { AdminTabs } from "@/components/admin-tabs";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  // The work counts that ride on the navigation, taken from the SAME buckets
  // the fulfilment workstation renders — so the badge and the queue can never
  // disagree about how many orders are waiting.
  //
  // Both reads fail soft. This runs on every admin page, and a badge is never
  // worth taking the console down for; a failed read shows no badge rather
  // than an error.
  const [buckets, criticals] = await Promise.all([
    getBucketCounts().catch(() => null),
    getOpenCriticalAlertCount().catch(() => 0),
  ]);
  const work = buckets ? summarizeWorkQueue(buckets, criticals) : EMPTY_WORK_QUEUE;

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="px-4 pt-6 sm:px-6 lg:px-8">
        <AdminTabs work={work} />
      </div>
      {children}
    </div>
  );
}
