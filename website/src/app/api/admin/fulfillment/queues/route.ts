import { NextResponse } from "next/server";

import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getBucketCounts, getBucketOrders, getCancelledWithLabel } from "@/lib/fulfillment-queues";
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
      const [counts, cancelledWithLabel] = await Promise.all([
        getBucketCounts(),
        getCancelledWithLabel({ limit: 25 }),
      ]);
      return NextResponse.json({ success: true, counts, cancelledWithLabel });
    }

    if (!BUCKETS.some((b) => b.id === bucket)) {
      return NextResponse.json({ success: false, error: "Unknown queue." }, { status: 400 });
    }

    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const orders = await getBucketOrders(bucket as BucketId, { limit });
    return NextResponse.json({ success: true, bucket, orders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the fulfillment queues.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
