import "server-only";

import { deferOmnisend } from "@/lib/marketing/omnisend/defer";
import { SMS_CONSENT_TEXT, acceptableSmsPhone } from "@/lib/sms-consent-text";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * SMS MARKETING CONSENT, RECORDED WHERE EVERY SENDER LOOKS.
 *
 * Three places collect it — the sign-up page, the checkout and the account
 * settings page — and two stores carry it: sms_subscribers (one row per
 * address, everyone: sms-subscribers.sql) and customer_preferences (the
 * account holder's own toggle, customer-sms-consent.sql). This module writes
 * both so the account page shows what the checkout collected and the
 * Omnisend sync (marketing/omnisend/contacts.ts) reads one answer whichever
 * row it finds first.
 *
 * NEVER WIDENED. A number typed for delivery is not consent; only a ticked,
 * never pre-ticked box is, and the caller passes the box's state, not the
 * number's presence. The sentence the person ticked is stored with the row
 * (TCPA evidence), so a later edit to the site's wording cannot rewrite what
 * they agreed to.
 *
 * OMNISEND HEARS OF IT AFTER THE RESPONSE, never on the caller's path, through
 * the same deferral every consent hook uses. The hook re-reads both rows, so
 * it pushes what was actually stored.
 *
 * Never throws. A refused write is logged and answered false; no sign-up,
 * checkout or preference save may fail over a marketing record.
 */

const LOG = "[sms-consent]";

// Where the box was ticked. Stored on the consent row, so the TCPA record
// says which screen collected it. "storefront" is the welcome-offer control
// on the catalogue, a product page and the cart.
export type SmsConsentSource = "signup" | "checkout" | "account-settings" | "storefront" | "omnisend-form";

function normalizeEmail(email: string): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

function pushToOmnisend(email: string): void {
  deferOmnisend("sms-consent", () => import("@/lib/marketing/omnisend/hooks").then((hooks) => hooks.onPreferencesChanged(email)));
}

/**
 * Record a ticked box. False when the number is not one a person could be
 * texted at (the caller has already validated; this is the last check) or
 * the consent row was refused. The account mirror is best-effort on top.
 */
export async function recordSmsConsent(input: { email: string; phone: string; source: SmsConsentSource; userId?: string | null }): Promise<boolean> {
  const email = normalizeEmail(input.email);
  const phone = acceptableSmsPhone(input.phone);
  if (!email || !phone) return false;
  const now = new Date().toISOString();
  try {
    const { error } = await supabaseAdmin
      .from("sms_subscribers")
      .upsert({ email, phone, source: input.source, consented_at: now, opted_out_at: null, consent_text: SMS_CONSENT_TEXT, updated_at: now }, { onConflict: "email" });
    if (error) {
      console.error(LOG, "consent row refused", { source: input.source, message: error.message });
      return false;
    }
    if (input.userId) {
      const { error: mirrorError } = await supabaseAdmin
        .from("customer_preferences")
        .upsert({ user_id: input.userId, phone, sms_marketing: true, sms_consent_at: now, sms_opted_out_at: null, updated_at: now }, { onConflict: "user_id" });
      if (mirrorError) console.error(LOG, "account mirror refused", { source: input.source, message: mirrorError.message });
    }
    pushToOmnisend(email);
    return true;
  } catch (error) {
    console.error(LOG, "consent could not be recorded", { source: input.source, error });
    return false;
  }
}

/**
 * Record a stop: the account box unticked, or Omnisend reporting STOP
 * (reconcile.ts). Stamps opted_out_at on the address's row when there is
 * one and it is not already stamped; the stamp is when the person said stop
 * (`at`), not when the store found out. Answers "applied", "nothing" (no row,
 * or already stopped) or "failed", the reconcile's own vocabulary.
 */
export async function recordSmsOptOut(email: string, at: string): Promise<"applied" | "nothing" | "failed"> {
  const address = normalizeEmail(email);
  if (!address) return "nothing";
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("opted_out_at")
      .eq("email", address)
      .maybeSingle();
    if (error) {
      console.error(LOG, "opt-out read refused", error.message);
      return "failed";
    }
    if (!data) return "nothing";
    if ((data as { opted_out_at?: string | null }).opted_out_at) return "nothing";
    const { error: writeError } = await supabaseAdmin
      .from("sms_subscribers")
      .update({ opted_out_at: at, updated_at: new Date().toISOString() })
      .eq("email", address);
    if (writeError) {
      console.error(LOG, "opt-out write refused", writeError.message);
      return "failed";
    }
    return "applied";
  } catch (error) {
    console.error(LOG, "opt-out could not be recorded", error);
    return "failed";
  }
}

/**
 * A CONSENT OMNISEND TOOK AND THE STORE HAS NEVER SEEN.
 *
 * The sign-up pop-up collects the number and the tick on Omnisend's side, so
 * the store learns of it on the next write-back (reconcile.ts). This mirrors
 * it into sms_subscribers ONCE, and never again: recordSmsConsent would
 * re-stamp consented_at on every half-hourly tick and quietly rewrite the
 * date the person actually agreed, which is the one field a carrier dispute
 * turns on. So an address that already has a row — consented or stopped — is
 * left exactly as it is, and "nothing" is the honest answer for it.
 *
 * `at` is when Omnisend recorded the consent, not when this run found it.
 */
export async function mirrorSmsConsent(input: { email: string; phone: string; source: SmsConsentSource; at: string }): Promise<"applied" | "nothing" | "failed"> {
  const email = normalizeEmail(input.email);
  const phone = acceptableSmsPhone(input.phone);
  if (!email || !phone) return "nothing";
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("email")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      console.error(LOG, "mirror read refused", error.message);
      return "failed";
    }
    if (data) return "nothing";
    const now = new Date().toISOString();
    const { error: writeError } = await supabaseAdmin
      .from("sms_subscribers")
      .insert({ email, phone, source: input.source, consented_at: input.at, opted_out_at: null, consent_text: SMS_CONSENT_TEXT, updated_at: now });
    if (writeError) {
      console.error(LOG, "mirror write refused", writeError.message);
      return "failed";
    }
    return "applied";
  } catch (error) {
    console.error(LOG, "mirror could not be written", error);
    return "failed";
  }
}
