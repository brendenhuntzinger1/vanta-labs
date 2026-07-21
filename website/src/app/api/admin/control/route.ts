import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getControlSnapshot, upsertControlValue } from "@/lib/admin-control";

// Sections that hold credentials — these are managed ONLY through
// /api/admin/settings (which masks secrets on read and writes them carefully).
// They must never be written through this generic endpoint, nor returned here.
const SECRET_SECTIONS = new Set(["email", "payment_processor", "fulfillment"]);

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to change store settings." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  // Config editing is a manager+ capability.
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  try {
    const url = new URL(request.url);
    const section = url.searchParams.get("section") ?? undefined;
    const snapshot = await getControlSnapshot(section);
    // Never expose credential sections through this endpoint.
    for (const secret of SECRET_SECTIONS) {
      delete (snapshot as Record<string, unknown>)[secret];
    }
    return NextResponse.json({ success: true, snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load control settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  try {
    const body = await request.json() as {
      updates?: Array<{ section: string; key: string; value: unknown }>;
    };

    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) {
      return NextResponse.json({ success: false, error: "No updates provided" }, { status: 400 });
    }

    // Reject any attempt to write a credential section through this endpoint.
    if (updates.some((update) => SECRET_SECTIONS.has(String(update.section ?? "").trim().toLowerCase()))) {
      return NextResponse.json({ success: false, error: "Use the Settings page to change email, processor, or fulfillment credentials." }, { status: 403 });
    }

    for (const update of updates) {
      await upsertControlValue({
        section: String(update.section ?? ""),
        key: String(update.key ?? ""),
        value: update.value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save control settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
