import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json() as { orderUpdateEmails?: boolean; marketingEmails?: boolean };

    const { error } = await supabaseAdmin.from("customer_preferences").upsert({
      user_id: user.id,
      order_update_emails: body.orderUpdateEmails ?? true,
      marketing_emails: body.marketingEmails ?? false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save preferences";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
