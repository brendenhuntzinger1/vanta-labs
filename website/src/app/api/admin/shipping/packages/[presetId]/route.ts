import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  deactivatePackagePreset,
  setDefaultPackagePreset,
  updatePackagePreset,
  type PackagePresetPatch,
} from "@/lib/shippo/packages";

// ---------------------------------------------------------------------------
// PATCH  /api/admin/shipping/packages/<presetId>   edit, or make it the default
// DELETE /api/admin/shipping/packages/<presetId>   retire it
//
// Manager+ only: a box's dimensions and tare weight are inputs to every rate
// request, so editing one changes what the store is charged for postage.
//
// DELETE RETIRES, IT DOES NOT DELETE. Orders point at the preset they were
// rated against (orders.package_preset_id), and that row is the answer to "what
// box did we quote this label from" long after the box itself is out of use.
// The preset module also hands the default on when the retired box held it, so
// parcel math never ends up resolving to nothing.
//
// PATCH accepts a partial patch. Only the fields present are changed, and the
// MERGED row is validated in packages.ts — renaming a box cannot smuggle in
// dimensions that were never valid.
// ---------------------------------------------------------------------------

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json(
    { success: false, error: "Your role does not have permission to manage shipping packages." },
    { status: 403 },
  );
}

interface PackagePatchBody {
  name?: unknown;
  lengthIn?: unknown;
  widthIn?: unknown;
  heightIn?: unknown;
  emptyWeightOz?: unknown;
  isDefault?: unknown;
  isActive?: unknown;
  /** "set_default" promotes without touching any other field. */
  action?: unknown;
}

/**
 * Build the patch from only the keys the caller actually sent.
 *
 * `undefined` has to mean "leave it alone": copying every field through would
 * turn a rename into a full overwrite and silently reset dimensions to whatever
 * the form happened to hold.
 */
function buildPatch(body: PackagePatchBody): PackagePresetPatch {
  const patch: PackagePresetPatch = {};
  if (body.name !== undefined) patch.name = String(body.name ?? "");
  if (body.lengthIn !== undefined) patch.lengthIn = body.lengthIn as number | string;
  if (body.widthIn !== undefined) patch.widthIn = body.widthIn as number | string;
  if (body.heightIn !== undefined) patch.heightIn = body.heightIn as number | string;
  if (body.emptyWeightOz !== undefined) patch.emptyWeightOz = body.emptyWeightOz as number | string;
  if (body.isDefault !== undefined) patch.isDefault = body.isDefault === true;
  if (body.isActive !== undefined) patch.isActive = body.isActive !== false;
  return patch;
}

async function auditPackageChange(input: {
  action: string;
  presetId: string;
  metadata: Record<string, unknown>;
  username: string;
  request: Request;
}) {
  const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
    action: input.action,
    target_table: "shipping_package_presets",
    target_id: input.presetId,
    metadata: {
      ...input.metadata,
      performedAt: new Date().toISOString(),
      performedBy: input.username,
      ipAddress: getRequestIpAddress(input.request),
      userAgent: getRequestUserAgent(input.request),
    },
  });
  if (error) {
    // The change already landed; the audit row is secondary.
    console.error("Unable to audit a shipping package change", input.presetId, error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ presetId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  const { presetId } = await context.params;

  let body: PackagePatchBody;
  try {
    body = (await request.json()) as PackagePatchBody;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  try {
    // Promoting a default is its own operation: it must not require the caller
    // to echo back every dimension just to tick one box.
    const result =
      String(body.action ?? "") === "set_default"
        ? await setDefaultPackagePreset(presetId)
        : await updatePackagePreset(presetId, buildPatch(body));

    if (!result.ok) {
      // packages.ts reports a missing row as a message rather than a code; a
      // 400 with that sentence is more use to the admin than a bare 404.
      return NextResponse.json({ success: false, error: result.message }, { status: 400 });
    }

    await auditPackageChange({
      action: "shipping_package_update",
      presetId,
      metadata: {
        name: result.data.name,
        lengthIn: result.data.lengthIn,
        widthIn: result.data.widthIn,
        heightIn: result.data.heightIn,
        emptyWeightOz: result.data.emptyWeightOz,
        isDefault: result.data.isDefault,
        isActive: result.data.isActive,
      },
      username: session.username,
      request,
    });

    return NextResponse.json({ success: true, package: result.data });
  } catch (error) {
    console.error("Unable to update a shipping package", presetId, error);
    return NextResponse.json({ success: false, error: "Unable to update this package." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ presetId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  const { presetId } = await context.params;

  try {
    const result = await deactivatePackagePreset(presetId);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message }, { status: 400 });
    }

    await auditPackageChange({
      action: "shipping_package_retire",
      presetId,
      metadata: { name: result.data.name, isActive: result.data.isActive, isDefault: result.data.isDefault },
      username: session.username,
      request,
    });

    return NextResponse.json({ success: true, package: result.data });
  } catch (error) {
    console.error("Unable to retire a shipping package", presetId, error);
    return NextResponse.json({ success: false, error: "Unable to retire this package." }, { status: 500 });
  }
}
