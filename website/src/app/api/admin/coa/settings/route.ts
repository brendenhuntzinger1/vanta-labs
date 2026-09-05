import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoa } from "@/lib/admin-roles";
import { setCoaHiddenProductSlugs, setCoaShowPendingProducts } from "@/lib/admin-coa";
import { coaErrorResponse, coaForbiddenResponse, coaUnauthorizedResponse } from "@/lib/admin-coa-http";
import { getCoaLibrarySettings } from "@/lib/coa";
import { normalizeCoaHiddenProductSlugs } from "@/lib/coa-hidden";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return coaUnauthorizedResponse();
  }

  const settings = await getCoaLibrarySettings();
  return NextResponse.json({ success: true, settings });
}

type CoaSettingsBody = {
  showPendingProducts?: unknown;
  hiddenProductSlugs?: unknown;
};

/**
 * Two switches for the public library, saved from two different panels:
 *
 * - `showPendingProducts` — whether products with no published COA still
 *   appear marked "Documentation Pending", or are hidden until their first
 *   document lands. Both states are designed to look finished.
 * - `hiddenProductSlugs` — products kept out of the library altogether,
 *   pending or not, because the store never sent them for testing.
 *
 * A PATCH in all but name: only the fields present in the body are written.
 * Each panel sends its own field alone and knows nothing of the other's
 * current value, so reading an absent field as a default would flip the other
 * switch on every save.
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
    const body = (await request.json()) as CoaSettingsBody;

    if (body.showPendingProducts !== undefined) {
      await setCoaShowPendingProducts({
        showPendingProducts: body.showPendingProducts !== false,
        actorUsername: session.username,
      });
    }

    if (body.hiddenProductSlugs !== undefined) {
      const hiddenProductSlugs = normalizeCoaHiddenProductSlugs(body.hiddenProductSlugs);
      if (!hiddenProductSlugs) {
        return NextResponse.json(
          { success: false, error: "Send the hidden products as a list of product slugs." },
          { status: 400 },
        );
      }
      await setCoaHiddenProductSlugs({
        hiddenProductSlugs,
        actorUsername: session.username,
      });
    }

    const settings = await getCoaLibrarySettings();
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    return coaErrorResponse(error, "Unable to save the COA library setting.");
  }
}
