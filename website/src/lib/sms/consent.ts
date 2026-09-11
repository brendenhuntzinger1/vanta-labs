import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { maskPhone, normalisePhone } from "@/lib/sms/phone";
import {
  canSendMarketing,
  newSubscriber,
  transition,
  type SmsEvent,
  type SubscriberState,
} from "@/lib/sms/state";

// ---------------------------------------------------------------------------
// Consent: recording it, granting it, revoking it — and the flow that reuses a
// phone number the store already has without ever treating that number's
// existence as permission.
//
// THE DISTINCTION THIS MODULE IS BUILT AROUND:
//
//     phone on file          = YES   (39 order rows, 21 ambassadors, today)
//     SMS marketing consent  = NO    (there is no column it could live in)
//
// Those two facts are simultaneously true for every number in this database,
// and keeping them apart is the whole job. A customer whose number we already
// hold should not have to retype it — that is pointless friction for a number
// we can read off their last order — but the number being pre-filled must never
// shortcut the disclosure, the grant, or the confirmation.
//
// So `beginConsentForPhoneOnFile` pre-fills and does nothing else: it records
// the disclosure that was shown, and every subsequent step is identical to a
// number typed from scratch.
// ---------------------------------------------------------------------------

/** Where an opt-in happened. Recorded on the subscriber and every event. */
export type ConsentSource =
  | "account_settings"
  | "checkout"
  | "post_purchase"
  | "back_in_stock"
  | "product_page"
  | "exit_intent"
  | "email_campaign"
  | "admin";

export type ConsentEvidence = {
  /** The literal rendered disclosure the customer saw. Not a version pointer. */
  exactCopyShown: string;
  /** Identifier for the disclosure template, for cross-referencing. */
  disclosureVersion: string;
  source: ConsentSource;
  sourceUrl?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Server-established identity. NEVER taken from a request body. */
  userId?: string | null;
};

type Row = {
  phone_e164: string;
  user_id: string | null;
  status: string;
  verified_at: string | null;
  verify_attempts: number | null;
  marketing_consent: boolean | null;
  double_optin_confirmed_at: string | null;
  opted_out_at: string | null;
  resubscribed_at: string | null;
  resubscribe_count: number | null;
};

const COLUMNS =
  "phone_e164, user_id, status, verified_at, verify_attempts, marketing_consent, double_optin_confirmed_at, opted_out_at, resubscribed_at, resubscribe_count";

function toState(row: Row): SubscriberState {
  return {
    status: (row.status as SubscriberState["status"]) ?? "pending",
    marketingConsent: row.marketing_consent === true,
    doubleOptinConfirmedAt: row.double_optin_confirmed_at,
    verifiedAt: row.verified_at,
    optedOutAt: row.opted_out_at,
    resubscribedAt: row.resubscribed_at,
    resubscribeCount: Number(row.resubscribe_count ?? 0),
  };
}

/**
 * Append a consent event.
 *
 * THE LEGAL RECORD, and it is append-only at the database level — a trigger
 * raises on UPDATE and DELETE, because the service-role client bypasses RLS and
 * a convention is a convention until someone writes the UPDATE.
 *
 * Never throws: a failure to record is reported so the caller can refuse the
 * state change, because a consent state with no evidence behind it is worse
 * than no consent state.
 */
export async function recordConsentEvent(input: {
  phoneE164: string;
  event: string;
  evidence?: Partial<ConsentEvidence>;
  twilioMessageSid?: string | null;
  detail?: Record<string, unknown>;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_consent_events")
      .insert({
        phone_e164: input.phoneE164,
        event: input.event,
        disclosure_version: input.evidence?.disclosureVersion ?? null,
        exact_copy_shown: input.evidence?.exactCopyShown ?? null,
        ip: input.evidence?.ip ?? null,
        user_agent: input.evidence?.userAgent ?? null,
        source_url: input.evidence?.sourceUrl ?? null,
        user_id: input.evidence?.userId ?? null,
        twilio_message_sid: input.twilioMessageSid ?? null,
        detail: input.detail ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, id: String(data.id) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }
}

/** Read a subscriber, or null. */
export async function loadSubscriber(
  phoneE164: string,
): Promise<{ ok: true; state: SubscriberState | null; userId: string | null } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select(COLUMNS)
      .eq("phone_e164", phoneE164)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: true, state: null, userId: null };
    const row = data as Row;
    return { ok: true, state: toState(row), userId: row.user_id };
  } catch (error) {
    // FAILS CLOSED AT THE CALL SITE. Callers must treat an unreadable
    // subscriber as "may not be messaged", never as "no record, so new".
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
  }
}

/**
 * BEGIN AN OPT-IN FOR A NUMBER THE STORE ALREADY HAS.
 *
 * The customer sees their number pre-filled, ticks the marketing box, and this
 * records the disclosure. That is ALL it does. In particular it does not:
 *
 *   * set marketing_consent          — that is `grantMarketingConsent`, and it
 *                                      requires the number to be verified
 *   * mark the number verified       — possession still has to be proven, even
 *                                      though the number came off their order
 *   * lift a suppression             — a suppressed number stays suppressed
 *
 * WHY VERIFY A NUMBER WE ALREADY HAVE. Because "we have this number" and "the
 * person at this number agreed" are different claims, and only the second is a
 * defence. The number on an order was typed for a courier; it may be a typo, a
 * work line, a partner's phone, or a number since reassigned. Verification is
 * what makes the consent record evidence rather than an assertion.
 *
 * Returns the subscriber's CURRENT state so the caller can show the right next
 * step rather than assuming this is a fresh signup.
 */
export async function beginConsentForPhoneOnFile(input: {
  /** The number as held on the order or account. Normalised here, once. */
  phoneOnFile: string;
  evidence: ConsentEvidence;
}): Promise<
  | { ok: true; phoneE164: string; state: SubscriberState; nextStep: "verify" | "confirm" | "already_active" }
  | { ok: false; error: string; reason?: string }
> {
  const normalised = normalisePhone(input.phoneOnFile);
  if (!normalised.ok) {
    // A number we cannot parse cannot be pre-filled into a consent flow. The
    // customer types one instead; we do not coerce.
    return {
      ok: false,
      error: "That number could not be read. Please enter it again.",
      reason: normalised.reason,
    };
  }
  const phoneE164 = normalised.e164;

  if (!input.evidence.exactCopyShown?.trim()) {
    // NO EVIDENCE, NO FLOW. Recording a consent step without the copy the
    // customer read would produce exactly the unprovable record this system
    // exists to avoid.
    return { ok: false, error: "The disclosure shown must be recorded." };
  }

  const existing = await loadSubscriber(phoneE164);
  if (!existing.ok) return { ok: false, error: "Could not read the subscriber." };

  const state = existing.state ?? newSubscriber();

  // Upsert the row WITHOUT touching any consent field. `status` is only set on
  // insert (via the default), so an existing verified number is not demoted.
  try {
    const { error } = await supabaseAdmin
      .from("sms_subscribers")
      .upsert(
        {
          phone_e164: phoneE164,
          user_id: input.evidence.userId ?? null,
          consent_source: input.evidence.source,
          disclosure_version: input.evidence.disclosureVersion,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "phone_e164", ignoreDuplicates: false },
      );
    if (error) throw error;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }

  const recorded = await recordConsentEvent({
    phoneE164,
    event: "disclosure_shown",
    evidence: input.evidence,
    detail: { prefilledFromFile: true },
  });
  if (!recorded.ok) {
    return { ok: false, error: "Could not record the disclosure; the opt-in was not started." };
  }

  const nextStep = canSendMarketing(state)
    ? "already_active"
    : state.status === "verified" && state.marketingConsent
      ? "confirm"
      : "verify";

  return { ok: true, phoneE164, state, nextStep };
}

/**
 * Apply a state-machine event and persist it, recording evidence first.
 *
 * ORDER MATTERS AND IS THE SAME ORDER `reserveAndSendStage` USES: record the
 * evidence, then change the state. A state change with no event behind it is
 * unexplainable later; an event with no state change is merely redundant. Given
 * one has to happen first, the harmless failure is the one to risk.
 */
export async function applyConsentEvent(input: {
  phoneE164: string;
  event: SmsEvent;
  eventName: string;
  evidence?: Partial<ConsentEvidence>;
  twilioMessageSid?: string | null;
  now?: number;
}): Promise<
  | { ok: true; state: SubscriberState; marketingActive: boolean }
  | { ok: false; error: string; refused?: string }
> {
  const loaded = await loadSubscriber(input.phoneE164);
  if (!loaded.ok) return { ok: false, error: "Could not read the subscriber." };

  const current = loaded.state ?? newSubscriber();
  const result = transition(current, input.event, {
    now: input.now ?? Date.now(),
    verifyAttempts: 0,
  });
  if (!result.ok) {
    return { ok: false, error: result.reason, refused: result.reason };
  }

  const recorded = await recordConsentEvent({
    phoneE164: input.phoneE164,
    event: input.eventName,
    evidence: input.evidence,
    twilioMessageSid: input.twilioMessageSid,
  });
  if (!recorded.ok) {
    // THE ONE EXCEPTION, and it is the opt-out. Refusing to revoke because an
    // audit row would not write is indefensible: the customer said stop. The
    // state change proceeds and the missing evidence is an operational alarm,
    // not a reason to keep messaging them.
    if (input.event !== "marketing_revoked") {
      return { ok: false, error: "Could not record consent evidence; no state was changed." };
    }
  }

  const next = result.next;
  try {
    const { error } = await supabaseAdmin
      .from("sms_subscribers")
      .update({
        status: next.status,
        marketing_consent: next.marketingConsent,
        marketing_consent_at: next.marketingConsent ? new Date(input.now ?? Date.now()).toISOString() : null,
        double_optin_confirmed_at: next.doubleOptinConfirmedAt,
        verified_at: next.verifiedAt,
        opted_out_at: next.optedOutAt,
        resubscribed_at: next.resubscribedAt,
        resubscribe_count: next.resubscribeCount,
        updated_at: new Date().toISOString(),
      })
      .eq("phone_e164", input.phoneE164);
    if (error) throw error;
  } catch (error) {
    return {
      ok: false,
      error: `Could not update ${maskPhone(input.phoneE164)}: ${
        error instanceof Error ? error.message.slice(0, 200) : "unknown"
      }`,
    };
  }

  return { ok: true, state: next, marketingActive: canSendMarketing(next) };
}
