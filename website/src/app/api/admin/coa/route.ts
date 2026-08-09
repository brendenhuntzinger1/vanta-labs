import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import {
  createAdminCoaRecord,
  listAdminCoaRecords,
  listCoaProductOptions,
  type CoaUploadPayload,
} from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { getCoaLibrarySettings } from "@/lib/coa";
import { normalizeCoaStatus } from "@/lib/coa-format";
import type { CoaStatus } from "@/lib/coa-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }

  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? "";
    const productId = url.searchParams.get("productId") ?? "";
    const statusParam = url.searchParams.get("status") ?? "all";
    const status = statusParam === "all" ? "all" : (normalizeCoaStatus(statusParam) as CoaStatus);

    const [records, products, settings] = await Promise.all([
      listAdminCoaRecords({ search, productId: productId || undefined, status }),
      listCoaProductOptions(),
      getCoaLibrarySettings(),
    ]);

    return NextResponse.json({ success: true, records, products, settings });
  } catch (error) {
    return coaErrorResponse(error, "Unable to load the COA library.");
  }
}

/**
 * Create one COA. Always multipart, whether or not a file is attached, so the
 * browser sends the document and its metadata in a single request — there is no
 * staging step, which is what keeps an abandoned form from leaving an orphaned
 * object in the bucket.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }
  if (!canManageCoa(session.role)) {
    return coaForbiddenResponse();
  }

  try {
    const form = await request.formData();
    const file = form.get("file");

    let upload: CoaUploadPayload | null = null;
    if (file instanceof File && file.size > 0) {
      upload = {
        fileName: file.name,
        bytes: await file.arrayBuffer(),
        declaredType: file.type ?? "",
      };
    }

    const text = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };

    const record = await createAdminCoaRecord({
      productId: text("productId"),
      productDoseId: text("productDoseId") || null,
      strength: text("strength"),
      batchNumber: text("batchNumber"),
      lotNumber: text("lotNumber"),
      labName: text("labName"),
      testDate: text("testDate"),
      purity: text("purity"),
      identityResult: text("identityResult"),
      externalUrl: text("externalUrl"),
      status: normalizeCoaStatus(text("status")),
      upload,
    });

    return NextResponse.json({ success: true, record });
  } catch (error) {
    return coaErrorResponse(error, "Unable to save this COA.");
  }
}
