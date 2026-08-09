import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import { deleteAdminCoaRecord, updateAdminCoaRecord } from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { normalizeCoaStatus } from "@/lib/coa-format";

export const dynamic = "force-dynamic";

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
    await deleteAdminCoaRecord(coaId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return coaErrorResponse(error, "Unable to delete this COA.");
  }
}
