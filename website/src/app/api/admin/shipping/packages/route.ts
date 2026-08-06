import { NextResponse } from "next/server";

import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { createPackagePreset, listPackagePresets } from "@/lib/shippo/packages";

// ---------------------------------------------------------------------------
// GET  /api/admin/shipping/packages   list the boxes
// POST /api/admin/shipping/packages   add one
//
// A package preset is not decoration: its dimensions and tare weight go
// straight into every rate request, so changing one changes what the store pays
// for postage on every label bought afterwards. Writes are therefore gated to
// manager+ (canManageSettings — the same bar as the other settings that cost
// money), while reads are open to any admin because the order screen needs the
// list to show which box an order was rated in.
//
// The single-default rule is enforced by a partial unique index in the database
// and by the promote-then-demote ordering inside lib/shippo/packages.ts. This
// route deliberately does none of that itself — two implementations of "there
// is exactly one default" is how a store ends up with none.
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

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    // Retired boxes are included on request so the settings screen can show
    // history; the picker asks for active ones only.
    const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1";
    const packages = await listPackagePresets({ includeInactive });
    return NextResponse.json({ success: true, packages });
  } catch (error) {
    console.error("Unable to list shipping packages", error);
    return NextResponse.json({ success: false, error: "Unable to load shipping packages." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  let body: {
    name?: unknown;
    lengthIn?: unknown;
    widthIn?: unknown;
    heightIn?: unknown;
    emptyWeightOz?: unknown;
    isDefault?: unknown;
    isActive?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
  }

  try {
    // Field-level validation (positive dimensions, non-negative tare) lives in
    // packages.ts so every caller gets the same rules; this only shapes types.
    const result = await createPackagePreset({
      name: String(body.name ?? ""),
      lengthIn: (body.lengthIn ?? "") as number | string,
      widthIn: (body.widthIn ?? "") as number | string,
      heightIn: (body.heightIn ?? "") as number | string,
      emptyWeightOz: (body.emptyWeightOz ?? 0) as number | string,
      isDefault: body.isDefault === true,
      isActive: body.isActive !== false,
    });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message }, { status: 400 });
    }

    const { error: auditError } = await supabaseAdmin.from("admin_audit_logs").insert({
      action: "shipping_package_create",
      target_table: "shipping_package_presets",
      target_id: result.data.id,
      metadata: {
        name: result.data.name,
        lengthIn: result.data.lengthIn,
        widthIn: result.data.widthIn,
        heightIn: result.data.heightIn,
        emptyWeightOz: result.data.emptyWeightOz,
        isDefault: result.data.isDefault,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });
    if (auditError) {
      console.error("Unable to audit shipping package creation", auditError);
    }

    return NextResponse.json({ success: true, package: result.data });
  } catch (error) {
    console.error("Unable to create a shipping package", error);
    return NextResponse.json({ success: false, error: "Unable to save this package." }, { status: 500 });
  }
}
