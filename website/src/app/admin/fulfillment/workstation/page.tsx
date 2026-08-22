import { redirect } from "next/navigation";

import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { EXCEPTION_REASONS } from "@/lib/fulfillment-buckets";
import {
  getBucketCounts,
  getBucketOrders,
  getCancelledWithLabel,
  getExceptionOrders,
} from "@/lib/fulfillment-queues";
import { listBatches } from "@/lib/fulfillment-batches";
import { FulfillmentWorkstation } from "@/components/fulfillment-workstation";

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
  const [counts, exceptions, ready, inProgress, awaitingCarrier, cancelledWithLabel, batches] =
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
      <header className="mb-8">
        <p className="vl2-eyebrow">Fulfillment</p>
        <h1 className="vl2-serif mt-1 text-2xl text-white sm:text-3xl">Workstation</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Every paid order has exactly one home below. Work the exceptions first, then batch
          the rest and pick once per product instead of once per order.
        </p>
      </header>

      <FulfillmentWorkstation
        counts={counts}
        exceptions={exceptions}
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
