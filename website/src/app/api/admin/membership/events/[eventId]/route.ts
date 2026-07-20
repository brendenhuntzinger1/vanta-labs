import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { setPromotionalEventActive } from "@/lib/admin-membership";

export async function PATCH(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage promotional events." }, { status: 403 });
  }

  const { eventId } = await context.params;

  try {
    const body = await request.json() as { isActive?: boolean };
    await setPromotionalEventActive(eventId, Boolean(body.isActive));
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update event";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
