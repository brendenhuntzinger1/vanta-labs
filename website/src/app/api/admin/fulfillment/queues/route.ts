import { NextResponse } from "next/server";

import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getBucketCounts, getBucketOrders, getCancelledWithLabel, getExceptionOrders } from "@/lib/fulfillment-queues";
import { BUCKETS, type BucketId } from "@/lib/fulfillment-buckets";

// Read-only view over the operational buckets. Admin-only, server-authorised —
// a customer must never be able to enumerate other people's orders.
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");

  try {
    if (!bucket) {
      const [board, cancelledWithLabel] = await Promise.all([
        getBucketCounts(),
        getCancelledWithLabel({ limit: 25 }),
      ]);
      // `countsTruncated` travels with the counts. A consumer that renders the
      // board must be able to tell a quiet store from a short read.
      return NextResponse.json({
        success: true,
        counts: board.counts,
        countsTruncated: board.truncated,
        cancelledWithLabel,
      });
    }

    if (!BUCKETS.some((b) => b.id === bucket)) {
      return NextResponse.json({ success: false, error: "Unknown queue." }, { status: 400 });
    }

    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    // The exception queue is the one bucket whose list can be cut two ways — by
    // the scan ceiling and by the display limit — so it answers with the same
    // truncation signal the counts do. Reading it through getExceptionOrders
    // rather than getBucketOrders is what makes that flag reachable at all:
    // getBucketOrders returns a bare array and has nowhere to put it.
    if (bucket === "exceptions") {
      const queue = await getExceptionOrders({ limit });
      return NextResponse.json({
        success: true,
        bucket,
        orders: queue.orders,
        truncated: queue.truncated,
        totalMatched: queue.totalMatched,
      });
    }
    const orders = await getBucketOrders(bucket as BucketId, { limit });
    return NextResponse.json({ success: true, bucket, orders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the fulfillment queues.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
