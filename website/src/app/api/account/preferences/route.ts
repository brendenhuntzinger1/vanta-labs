import { NextResponse } from "next/server";
import { after } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { supabaseAdmin } from "@/lib/supabase-server";
import { customerSafeMessage } from "@/lib/safe-error";
import { CUSTOMER_CHOSEN_SUPPRESSION_REASONS } from "@/lib/email/suppression-reasons";
import { onPreferencesChanged } from "@/lib/marketing/omnisend/hooks";
import { recordSmsOptOut } from "@/lib/sms-consent";
import { grantWelcomeOfferForConsent } from "@/lib/offers/welcome-offer";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json() as { orderUpdateEmails?: boolean; marketingEmails?: boolean; smsMarketing?: boolean };
    const now = new Date().toISOString();

    const { error } = await supabaseAdmin.from("customer_preferences").upsert({
      user_id: user.id,
      order_update_emails: body.orderUpdateEmails ?? true,
      marketing_emails: body.marketingEmails ?? false,
      updated_at: now,
    }, { onConflict: "user_id" });

    if (error) {
      throw error;
    }

    // SMS consent (TCPA / A2P 10DLC). Written separately and best-effort so a
    // database that has not yet run customer-sms-consent.sql still saves the
    // email preferences above. The checkbox is never pre-ticked; the timestamp
    // of the tick (or untick) is the consent record Twilio and carriers expect.
    if (typeof body.smsMarketing === "boolean") {
      try {
        const { data: current } = await supabaseAdmin
          .from("customer_preferences")
          .select("sms_marketing")
          .eq("user_id", user.id)
          .maybeSingle();
        const was = Boolean(current?.sms_marketing);
        // A STOP IS UNCONDITIONAL. This used to fire only on a CHANGE, read
        // from customer_preferences — so if that row was missing or its column
        // unreadable, `was` came back false, "false !== false" was false, and
        // unticking the box recorded nothing in the consent ledger at all.
        // The ledger is the table a carrier would ask to see, and it is the
        // one that decides whether a text may be sent, so an untick now always
        // reaches it. recordSmsOptOut is idempotent and answers "nothing" when
        // there was nothing to stop.
        if (!body.smsMarketing) {
          const stopAddress = user.email?.trim().toLowerCase();
          if (stopAddress) await recordSmsOptOut(stopAddress, now);
        }
        if (was !== body.smsMarketing) {
          await supabaseAdmin
            .from("customer_preferences")
            .update({
              sms_marketing: body.smsMarketing,
              ...(body.smsMarketing ? { sms_consent_at: now } : { sms_opted_out_at: now }),
              updated_at: now,
            })
            .eq("user_id", user.id);
          // THE ADDRESS'S OWN CONSENT ROW SAYS THE SAME (sms-subscribers.sql):
          // a stop here must stop the row a guest checkout may have written
          // for this address, or the sync would read the older consent.
          const address = user.email?.trim().toLowerCase();
          // SUBSCRIBING HERE EARNS THE SAME WELCOME CODE the sign-up page and
          // the storefront offer hand out: one offer, one code per address,
          // whichever screen the box was ticked on. Silent and best-effort —
          // a preferences save never fails over a discount.
          if (address && body.smsMarketing) await grantWelcomeOfferForConsent(address);
        }
      } catch {
        // Non-fatal; see note above.
      }
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

      // OMNISEND SEES THE PREFERENCE EXACTLY AS STORED. The hook re-reads
      // marketing_emails, sms_marketing, sms_consent_at, sms_opted_out_at and
      // the phone from the rows written above (contacts.ts) and pushes the
      // contact — after the response, never on its path, and never widening
      // consent: a number typed without the SMS box ticked is not SMS consent.
      after(() => onPreferencesChanged(email));
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = customerSafeMessage(error, "Unable to save preferences");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
