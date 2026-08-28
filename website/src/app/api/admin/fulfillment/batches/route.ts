import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  closeBatch,
  createBatch,
  deleteBatch,
  getNextToPack,
  getPickList,
  listBatches,
  removeFromBatch,
} from "@/lib/fulfillment-batches";

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  const view = url.searchParams.get("view");

  try {
    if (batchId && view === "picklist") {
      const list = await getPickList(batchId);
      if (!list) return NextResponse.json({ success: false, error: "Batch not found." }, { status: 404 });
      return NextResponse.json({ success: true, pickList: list });
    }
    if (batchId && view === "next") {
      const next = await getNextToPack(batchId);
      return NextResponse.json({ success: true, next });
    }
    const batches = await listBatches({ status: url.searchParams.get("status") ?? undefined });
    return NextResponse.json({ success: true, batches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load batches.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  try {
    const body = await request.json() as { orderIds?: string[]; label?: string };
    const orderIds = Array.isArray(body.orderIds)
      ? body.orderIds.filter((id) => typeof id === "string" && id.length > 0)
      : [];
    if (orderIds.length === 0) {
      return NextResponse.json({ success: false, error: "Select at least one order." }, { status: 400 });
    }

    const result = await createBatch({ orderIds, label: body.label, createdBy: session.username });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "fulfillment_batch_create",
      target_table: "fulfillment_batches",
      target_id: result.batch?.id ?? null,
      metadata: {
        requested: orderIds.length,
        added: result.added.length,
        // Rejections are recorded, not just returned: "why is this order not in
        // the batch" is a question asked hours later, when the response is gone.
        rejected: result.rejected,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({
      success: true,
      batch: result.batch,
      requested: orderIds.length,
      added: result.added.length,
      rejected: result.rejected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create the batch.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  try {
    const body = await request.json() as { batchId?: string; action?: string; orderId?: string };
    if (!body.batchId) {
      return NextResponse.json({ success: false, error: "batchId is required." }, { status: 400 });
    }

    if (body.action === "close") {
      await closeBatch(body.batchId);
      return NextResponse.json({ success: true });
    }
    if (body.action === "remove_order" && body.orderId) {
      await removeFromBatch(body.batchId, body.orderId);
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update the batch.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

/**
 * Discard a batch.
 *
 * SPENDS NOTHING AND CHANGES NO ORDER. A batch is an operational grouping only
 * (see the header of fulfillment-batches.ts), so this removes the grouping and
 * releases its orders back to Ready to Fulfill. Postage already bought in
 * Shippo is untouched — deleting a batch is not a void, and nothing here calls
 * a carrier.
 */
export async function DELETE(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();

  const url = new URL(request.url);
  let batchId = url.searchParams.get("batchId") ?? "";
  if (!batchId) {
    // Accept a body too, so the client can use the same JSON shape as PATCH.
    try {
      const body = await request.json() as { batchId?: string };
      batchId = typeof body.batchId === "string" ? body.batchId : "";
    } catch { /* no body — the query string was the only source. */ }
  }
  if (!batchId) {
    return NextResponse.json({ success: false, error: "batchId is required." }, { status: 400 });
  }

  try {
    const result = await deleteBatch(batchId);
    if (!result.deleted) {
      return NextResponse.json({ success: false, error: "Batch not found." }, { status: 404 });
    }

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "fulfillment_batch_delete",
      target_table: "fulfillment_batches",
      target_id: batchId,
      metadata: {
        label: result.label,
        // The membership is gone with the batch. This is the only surviving
        // record of which orders were in it.
        orderIds: result.orderIds,
        orderCount: result.orderIds.length,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({
      success: true,
      label: result.label,
      released: result.orderIds.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete the batch.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
