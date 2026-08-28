import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getBucketCounts } from "@/lib/fulfillment-queues";
import { getOpenCriticalAlertCount } from "@/lib/monitoring";
import { EMPTY_WORK_QUEUE, summarizeWorkQueue } from "@/lib/admin-work-queue";
import { AdminTabs } from "@/components/admin-tabs";
import { settleRead } from "@/lib/admin-read";

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
  // Both reads still fail soft: this runs on every admin page, and a badge is
  // never worth taking the console down for. What changed is that a failed read
  // no longer LOOKS like an empty queue. AdminTabs draws no badge at zero, so a
  // read that did not answer used to render as a nav bar with nothing on it —
  // the same nav bar as a store with no work outstanding. It says so now.
  const [bucketsRead, criticalsRead] = await Promise.all([
    settleRead("Fulfillment queue counts", getBucketCounts),
    settleRead("Critical alerts", getOpenCriticalAlertCount),
  ]);
  const countsKnown = bucketsRead.ok && criticalsRead.ok;
  const work = countsKnown
    ? summarizeWorkQueue(bucketsRead.value.counts, criticalsRead.value)
    : EMPTY_WORK_QUEUE;
  const countsPartial = bucketsRead.ok && bucketsRead.value.truncated;

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="px-4 pt-6 sm:px-6 lg:px-8">
        {!countsKnown ? (
          <p
            role="alert"
            className="mx-auto mb-3 max-w-7xl rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100"
          >
            The work counts on these tabs could not be loaded. <strong>No badge does not mean no work</strong> —
            open Fulfillment to see the queues directly.
          </p>
        ) : countsPartial ? (
          <p
            role="alert"
            className="mx-auto mb-3 max-w-7xl rounded-xl border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-xs text-amber-100"
          >
            The store holds more orders than one scan reads, so the counts on these tabs are a floor, not a total.
          </p>
        ) : null}
        <AdminTabs work={work} />
      </div>
      {children}
    </div>
  );
}
