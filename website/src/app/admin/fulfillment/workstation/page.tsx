import Link from "next/link";
import { redirect } from "next/navigation";

import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import {
  BUCKETS,
  CARRIER_ACCEPTANCE_STALE_HOURS,
  EXCEPTION_REASONS,
  TRANSIT_STALE_DAYS,
} from "@/lib/fulfillment-buckets";
import {
  getBucketCounts,
  getBucketOrders,
  getCancelledWithLabel,
  getExceptionOrders,
} from "@/lib/fulfillment-queues";
import { listBatches } from "@/lib/fulfillment-batches";
import { FulfillmentWorkstation } from "@/components/fulfillment-workstation";
import { FulfillmentOwnerGuide } from "@/components/fulfillment-owner-guide";

// ---------------------------------------------------------------------------
// THE FULFILLMENT WORKSTATION.
//
// One screen that answers the morning's question — what needs to ship, what
// needs attention — and then runs the day: batch, pick, pack.
//
// Everything on it is DERIVED. There is no fulfillment state stored for the UI
// to read back; the buckets are computed from `orders` by fulfillment-buckets.ts
// on every load. The board can never disagree with the orders, because it is
// the orders.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function FulfillmentWorkstationPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) redirect("/vault");

  // Exceptions are loaded FIRST in the sense that matters: they are rendered
  // above the queues, because an operator who picks before reading them has
  // already wasted the trip for any order that turns out to be held.
  const [board, exceptionQueue, ready, inProgress, awaitingCarrier, cancelledWithLabel, batches] =
    await Promise.all([
      getBucketCounts(),
      getExceptionOrders({ limit: 50 }),
      getBucketOrders("ready", { limit: 200 }),
      getBucketOrders("in_progress", { limit: 100 }),
      getBucketOrders("awaiting_carrier", { limit: 100 }),
      getCancelledWithLabel({ limit: 25 }),
      listBatches({ status: "open", limit: 10 }),
    ]);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="vl2-eyebrow">Fulfillment</p>
          <h1 className="vl2-serif mt-1 text-2xl text-white sm:text-3xl">Workstation</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">
            Every paid order has exactly one home below. Work the exceptions first, then batch
            the rest and pick once per product instead of once per order.
          </p>
        </div>
        {/*
          The escape hatch to the other half of fulfillment. This board is
          organised by what needs DOING; when a customer emails about one
          specific order, the question is "where is order 1043" and the answer
          lives in search. Linking both ways means neither page is a dead end.
        */}
        <Link
          href="/admin/fulfillment"
          className="vl-btn-secondary inline-flex shrink-0 px-4 py-2 text-xs"
        >
          Find one order →
        </Link>
      </header>

      {/*
        The guide is fed the SAME definitions this page renders the board from,
        rather than importing them itself — fulfillment-buckets.ts is
        server-only because it reaches the database. Passing them down keeps one
        set of definitions instead of a second copy that drifts.

        Closed by default and visually quiet: it must never compete with the
        actual work below it.
      */}
      <FulfillmentOwnerGuide
        buckets={BUCKETS.map((b) => ({ id: b.id, label: b.label, description: b.description }))}
        exceptions={EXCEPTION_REASONS.map((e) => ({ reason: e.reason, label: e.label, action: e.action }))}
        carrierStaleHours={CARRIER_ACCEPTANCE_STALE_HOURS}
        transitStaleDays={TRANSIT_STALE_DAYS}
      />

      {board.truncated || exceptionQueue.truncated ? (
        <p className="mb-6 rounded-xl border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          <strong>This board is incomplete.</strong>{" "}
          {exceptionQueue.truncated ? (
            <>
              {exceptionQueue.totalMatched} order{exceptionQueue.totalMatched === 1 ? "" : "s"} need attention and the
              list below shows the {exceptionQueue.orders.length} that have been waiting longest. Work these, then
              reload — the rest are not on this screen.{" "}
            </>
          ) : null}
          {board.truncated
            ? "The store also holds more orders than one scan reads, so the counts are a floor, not a total."
            : ""}
        </p>
      ) : null}

      <FulfillmentWorkstation
        counts={board.counts}
        exceptions={exceptionQueue.orders}
        exceptionReasons={[...EXCEPTION_REASONS]}
        ready={ready}
        inProgress={inProgress}
        awaitingCarrier={awaitingCarrier}
        cancelledWithLabel={cancelledWithLabel}
        openBatches={batches}
      />
    </main>
  );
}
