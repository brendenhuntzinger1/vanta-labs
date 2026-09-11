import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { maskPhone } from "@/lib/sms/phone";
import type { SmsChannel } from "@/lib/sms/settings";

// ---------------------------------------------------------------------------
// Suppression. The layer that actually holds.
//
// MODELLED ON `isMarketingSuppressed` / `sendMarketingEmail`, which already
// solved this for email and solved it the right way: the check happens
// immediately before dispatch, and A READ THAT ERRORS REFUSES THE SEND. The
// email version says it plainly — "Suppression list unavailable; consent could
// not be verified" — and that is the posture, not an aspiration.
//
// WHY FAIL CLOSED IS NOT OPTIONAL HERE. A suppression read that throws and is
// caught as "not suppressed" turns a database hiccup into messages sent to
// people who said STOP. For email that is a complaint; for SMS it is TCPA
// statutory damages at $500-$1,500 per message, and the person most likely to
// be affected is the one who most recently opted out — the newest row is the
// one a partial outage is most likely to miss.
//
// THE CHECK IS SEPARATE FROM `canSendMarketing` ON PURPOSE. That predicate is
// pure and cannot fail closed on a read it does not perform; a predicate that
// looked complete would invite callers to skip this.
// ---------------------------------------------------------------------------

export type SuppressionVerdict =
  /** Cleared to send. */
  | { suppressed: false }
  /** A suppression row covers this number for this channel. */
  | { suppressed: true; reason: string; scope: "marketing" | "all" }
  /** The list could not be read. TREAT AS SUPPRESSED. */
  | { suppressed: true; reason: string; scope: "unknown" };

/**
 * Is this number suppressed for this channel?
 *
 * Scope semantics, and the asymmetry is the point:
 *   'marketing' blocks marketing, allows transactional.
 *   'all'       blocks both.
 *
 * So a STOP to the marketing number does not cost someone their shipping
 * notifications, which is why the programme runs two numbers at all.
 */
export async function isSmsSuppressed(
  phoneE164: string,
  channel: SmsChannel,
): Promise<SuppressionVerdict> {
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_suppressions")
      .select("scope, reason")
      .eq("phone_e164", phoneE164)
      .maybeSingle();

    if (error) throw error;
    if (!data) return { suppressed: false };

    const scope = data.scope === "all" ? "all" : "marketing";
    if (channel === "transactional" && scope === "marketing") {
      // Suppressed for solicitation only. Order notifications continue.
      return { suppressed: false };
    }
    return {
      suppressed: true,
      scope,
      reason: String(data.reason ?? "suppressed"),
    };
  } catch {
    // FAIL CLOSED. Deliberately no detail from the error: the caller logs a
    // masked number and this reason, and nothing about the failure is worth
    // leaking into a message the customer might see.
    return {
      suppressed: true,
      scope: "unknown",
      reason: "Suppression list unavailable; consent could not be verified.",
    };
  }
}

/**
 * Add a suppression. Idempotent.
 *
 * `phoneRaw` carries a number that could NOT be normalised to E.164, so it is
 * suppressed under its digits instead. A number we cannot parse is a number we
 * cannot prove we suppressed, and dropping it would be the one silent failure
 * this table exists to prevent.
 */
export async function suppressSms(input: {
  phoneE164: string;
  scope?: "marketing" | "all";
  reason: string;
  phoneRaw?: string | null;
  needsReview?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabaseAdmin
      .from("sms_suppressions")
      .upsert(
        {
          phone_e164: input.phoneE164,
          scope: input.scope ?? "marketing",
          reason: input.reason,
          phone_raw: input.phoneRaw ?? null,
          needs_review: input.needsReview ?? false,
        },
        { onConflict: "phone_e164", ignoreDuplicates: false },
      );
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Could not suppress ${maskPhone(input.phoneE164)}: ${
        error instanceof Error ? error.message.slice(0, 200) : "unknown"
      }`,
    };
  }
}

/**
 * Remove a suppression.
 *
 * DELIBERATELY NARROW AND DELIBERATELY NOT EXPOSED TO THE ADMIN UI. A number
 * leaves suppression by completing verification AND an explicit marketing
 * grant, which is a flow, not a button. A bulk "unsuppress" control is exactly
 * how the ~33 numbers already in this database would end up on the marketing
 * list one busy afternoon, so the capability does not exist.
 *
 * The one legitimate caller is the resubscribe path, which has already checked
 * the cooldown and recorded a fresh consent event.
 */
export async function liftSuppressionForResubscribe(input: {
  phoneE164: string;
  /** The consent event id that authorises this. Recorded, not optional. */
  consentEventId: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.consentEventId) {
    return { ok: false, error: "A consent event is required to lift a suppression." };
  }
  try {
    const { error } = await supabaseAdmin
      .from("sms_suppressions")
      .delete()
      .eq("phone_e164", input.phoneE164);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }
}
