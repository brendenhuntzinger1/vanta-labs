import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getControlSnapshot, upsertControlValue } from "@/lib/admin-control";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const url = new URL(request.url);
    const section = url.searchParams.get("section") ?? undefined;
    const snapshot = await getControlSnapshot(section);
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

  try {
    const body = await request.json() as {
      updates?: Array<{ section: string; key: string; value: unknown }>;
    };

    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) {
      return NextResponse.json({ success: false, error: "No updates provided" }, { status: 400 });
    }

    for (const update of updates) {
      await upsertControlValue({
        section: String(update.section ?? ""),
        key: String(update.key ?? ""),
        value: update.value,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save control settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}