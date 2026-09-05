import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import { replaceAdminCoaFile } from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { resolveCoaFileUrl } from "@/lib/coa";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * Admin preview. Unlike the public route this does NOT require the record to be
 * published — checking a draft before publishing it is the entire point — so the
 * session check above is the only thing standing between a draft COA and the
 * internet. It is not optional.
 */
export async function GET(request: Request, context: { params: Promise<{ coaId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }

  const { coaId } = await context.params;
  const download = new URL(request.url).searchParams.get("download") === "1";

  const resolved = await resolveCoaFileUrl({ coaId, requirePublished: false, download });
  if (!resolved) {
    return NextResponse.json({ success: false, error: "No document on this record." }, { status: 404 });
  }

  return NextResponse.redirect(resolved.url, {
    status: 307,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** Replace the document on an existing record, keeping its batch metadata. */
export async function POST(request: Request, context: { params: Promise<{ coaId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }
  if (!canManageCoa(session.role)) {
    return coaForbiddenResponse();
  }

  try {
    const { coaId } = await context.params;
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ success: false, error: "Choose a file to upload." }, { status: 400 });
    }

    const record = await replaceAdminCoaFile(coaId, {
      fileName: file.name,
      bytes: await file.arrayBuffer(),
      declaredType: file.type ?? "",
    });

    // ADM-11: the previous document is gone from storage once this succeeds;
    // this row is what says who swapped it and for what. Best effort, like the
    // sibling route — the write already happened.
    try {
      const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
        action: "coa_file_replace",
        target_table: "coa_records",
        target_id: coaId,
        metadata: {
          productId: record.productId,
          batchNumber: record.batchNumber,
          fileName: record.fileName,
          fileSizeBytes: record.fileSizeBytes,
          performedAt: new Date().toISOString(),
          performedBy: session.username,
          ipAddress: getRequestIpAddress(request),
          userAgent: getRequestUserAgent(request),
        },
      });
      if (error) console.error("COA audit row not written", "coa_file_replace", coaId, error);
    } catch (auditError) {
      console.error("COA audit row not written", "coa_file_replace", coaId, auditError);
    }

    return NextResponse.json({ success: true, record });
  } catch (error) {
    return coaErrorResponse(error, "Unable to replace this COA file.");
  }
}
