import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import { replaceAdminCoaFile } from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { resolveCoaFileUrl } from "@/lib/coa";

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

    return NextResponse.json({ success: true, record });
  } catch (error) {
    return coaErrorResponse(error, "Unable to replace this COA file.");
  }
}
