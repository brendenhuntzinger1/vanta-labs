import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest, validateAdminCredentials, getRequestIpAddress, getRequestUserAgent } from "@/lib/admin-auth";
import { setAdminPassword, setAdminPasscode, renameAdminAccount } from "@/lib/admin-team";
import { supabaseAdmin } from "@/lib/supabase-server";

// Self-service admin account management: any signed-in admin can change their
// OWN password or username after re-entering their current password. No role
// gate — you can always manage your own credentials.
export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as {
      action?: string;
      currentPassword?: string;
      newPassword?: string;
      newUsername?: string;
      newPasscode?: string;
    };

    // Re-authenticate with the current password before any change.
    const valid = await validateAdminCredentials(session.username, String(body.currentPassword ?? ""));
    if (!valid) {
      return NextResponse.json({ success: false, error: "Current password is incorrect." }, { status: 403 });
    }

    const now = new Date().toISOString();
    const audit = async (action: string, metadata: Record<string, unknown>) => {
      await supabaseAdmin.from("admin_audit_logs").insert({
        action,
        target_table: "admin_credentials",
        target_id: session.username,
        metadata: { ...metadata, performedAt: now, ipAddress: getRequestIpAddress(request), userAgent: getRequestUserAgent(request) },
      });
    };

    if (body.action === "change_password") {
      const newPassword = String(body.newPassword ?? "");
      if (newPassword.length < 12) {
        return NextResponse.json({ success: false, error: "New password must be at least 12 characters." }, { status: 400 });
      }
      await setAdminPassword(session.username, newPassword);
      await audit("admin_password_changed", {});
      return NextResponse.json({ success: true });
    }

    if (body.action === "change_passcode") {
      const newPasscode = String(body.newPasscode ?? "").replace(/\D/g, "");
      if (newPasscode.length !== 6) {
        return NextResponse.json({ success: false, error: "Your login code must be exactly 6 digits." }, { status: 400 });
      }
      await setAdminPasscode(session.username, newPasscode);
      await audit("admin_passcode_set", {});
      return NextResponse.json({ success: true });
    }

    if (body.action === "change_username") {
      const newUsername = String(body.newUsername ?? "");
      await renameAdminAccount(session.username, newUsername);
      await audit("admin_username_changed", { to: newUsername.trim().toLowerCase() });
      return NextResponse.json({ success: true, newUsername: newUsername.trim().toLowerCase() });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update account";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
