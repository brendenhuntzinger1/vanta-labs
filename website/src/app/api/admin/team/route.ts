import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageTeam, normalizeAdminRole } from "@/lib/admin-roles";
import { createAdminAccount, listAdminAccounts } from "@/lib/admin-team";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Only super admins can manage the team." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageTeam(session.role)) {
    return forbiddenResponse();
  }

  try {
    const accounts = await listAdminAccounts();
    return NextResponse.json({ success: true, accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load team";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageTeam(session.role)) {
    return forbiddenResponse();
  }

  try {
    const body = await request.json() as { username?: string; password?: string; role?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const role = normalizeAdminRole(body.role);

    if (!username || !password) {
      return NextResponse.json({ success: false, error: "Username and password are required" }, { status: 400 });
    }

    await createAdminAccount({ username, password, role });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "admin_account_create",
      target_table: "admin_credentials",
      target_id: username.toLowerCase(),
      metadata: {
        role,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create account";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
