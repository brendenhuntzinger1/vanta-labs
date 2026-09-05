import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import { deleteAdminCoaRecord, updateAdminCoaRecord } from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { normalizeCoaStatus } from "@/lib/coa-format";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * ADM-11: every COA write leaves an admin_audit_logs row, the way product,
 * coupon and partner writes do. A Certificate of Analysis is the document a
 * customer trusts the product on; deleting or unpublishing one with no record
 * of who did it was the one admin action that could not be reconstructed.
 * Best effort — the write already happened, so a failed audit insert is logged
 * rather than turned into a failed request.
 */
async function writeCoaAudit(
  request: Request,
  session: { username: string },
  input: { action: string; coaId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
      action: input.action,
      target_table: "coa_records",
      target_id: input.coaId,
      metadata: {
        ...(input.metadata ?? {}),
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });
    if (error) console.error("COA audit row not written", input.action, input.coaId, error);
  } catch (error) {
    console.error("COA audit row not written", input.action, input.coaId, error);
  }
}

type CoaPatchBody = {
  productId?: string;
  productDoseId?: string | null;
  strength?: string | null;
  batchNumber?: string;
  lotNumber?: string | null;
  labName?: string | null;
  testDate?: string | null;
  purity?: string | null;
  identityResult?: string | null;
  externalUrl?: string | null;
  status?: string;
};

export async function PATCH(request: Request, context: { params: Promise<{ coaId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }
  if (!canManageCoa(session.role)) {
    return coaForbiddenResponse();
  }

  try {
    const { coaId } = await context.params;
    const body = (await request.json()) as CoaPatchBody;

    // Only fields actually present in the body are touched — the publish
    // toggle sends `{ status }` alone and must not blank out the lab name.
    const record = await updateAdminCoaRecord(coaId, {
      ...body,
      status: body.status === undefined ? undefined : normalizeCoaStatus(body.status),
    });

    // A publish/unpublish toggle sends `{ status }` alone; name it as the status
    // change it is, so the audit log reads "who unpublished this COA" directly.
    const changedKeys = Object.keys(body);
    const statusOnly = changedKeys.length === 1 && changedKeys[0] === "status";
    await writeCoaAudit(request, session, {
      action: statusOnly ? "coa_status_update" : "coa_update",
      coaId,
      metadata: {
        changes: body,
        productId: record.productId,
        batchNumber: record.batchNumber,
        status: record.status,
      },
    });

    return NextResponse.json({ success: true, record });
  } catch (error) {
    return coaErrorResponse(error, "Unable to update this COA.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ coaId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }
  if (!canManageCoa(session.role)) {
    return coaForbiddenResponse();
  }

  try {
    const { coaId } = await context.params;
    const deleted = await deleteAdminCoaRecord(coaId);
    if (deleted) {
      // The row and its storage object are gone; this is the only record left
      // of what they were and who removed them.
      await writeCoaAudit(request, session, {
        action: "coa_delete",
        coaId,
        metadata: {
          productId: deleted.productId,
          batchNumber: deleted.batchNumber,
          status: deleted.status,
          filePath: deleted.filePath,
        },
      });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return coaErrorResponse(error, "Unable to delete this COA.");
  }
}
