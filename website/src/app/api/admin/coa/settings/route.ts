import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import { setCoaShowPendingProducts } from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { getCoaLibrarySettings } from "@/lib/coa";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }

  const settings = await getCoaLibrarySettings();
  return NextResponse.json({ success: true, settings });
}

/**
 * Controls whether products with no published COA still appear in the public
 * library marked "Documentation Pending", or are hidden until their first
 * document lands. Both states are designed to look finished — this is the
 * owner's call about which story the page tells while the archive fills up.
 */
export async function PUT(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }
  if (!canManageCoa(session.role)) {
    return coaForbiddenResponse();
  }

  try {
    const body = (await request.json()) as { showPendingProducts?: unknown };
    await setCoaShowPendingProducts({
      showPendingProducts: body.showPendingProducts !== false,
      actorUsername: session.username,
    });

    const settings = await getCoaLibrarySettings();
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    return coaErrorResponse(error, "Unable to save the COA library setting.");
  }
}
