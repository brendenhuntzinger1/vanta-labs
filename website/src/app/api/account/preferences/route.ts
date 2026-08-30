import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { supabaseAdmin } from "@/lib/supabase-server";
import { customerSafeMessage } from "@/lib/safe-error";
import { CUSTOMER_CHOSEN_SUPPRESSION_REASONS } from "@/lib/email/suppression-reasons";

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

    // Mirror the marketing toggle into email_suppressions, which is the
    // authoritative gate every marketing send checks (coupon broadcasts,
    // cart-recovery, win-back, etc.). Without this, unchecking "promotions"
    // in the account changed the preference row but marketing emails still
    // went out. Best-effort — the preference above already saved.
    const email = user.email?.trim().toLowerCase();
    if (email) {
      try {
        if (body.marketingEmails === false) {
          await supabaseAdmin
            .from("email_suppressions")
            .upsert({ email, reason: "account_preference", created_at: new Date().toISOString() }, { onConflict: "email" });
        } else if (body.marketingEmails === true) {
          // ONLY LIFT WHAT THE CUSTOMER THEMSELVES PUT THERE.
          //
          // This used to be an unconditional delete on the address, which also
          // removed the `complained` and `bounced` rows the delivery webhook
          // writes — so ticking this box put a customer who had pressed "report
          // spam", or an address that hard-bounced, back on every marketing
          // list. Worse, a provider suppression did not mirror into
          // customer_preferences, so the box rendered ALREADY TICKED for those
          // people and any save of the panel resurrected them without the
          // customer changing a thing.
          //
          // Mailing complainers is the fastest way to wreck a sending domain's
          // reputation, and that domain also carries every receipt, password
          // reset and confirmation. See lib/email/suppression-reasons.ts.
          await supabaseAdmin
            .from("email_suppressions")
            .delete()
            .eq("email", email)
            .in("reason", [...CUSTOMER_CHOSEN_SUPPRESSION_REASONS]);
        }
      } catch {
        // Non-fatal; the preference row is saved regardless.
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = customerSafeMessage(error, "Unable to save preferences");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
