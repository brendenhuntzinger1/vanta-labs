import "server-only";

import { deferOmnisend } from "@/lib/marketing/omnisend/defer";
import { normalizeE164 } from "@/lib/marketing/omnisend/contact-payload";
import { SMS_DISCLOSURE_VERSION, acceptableSmsPhone } from "@/lib/sms-consent-text";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * SMS MARKETING CONSENT, WRITTEN TO THE TABLE PRODUCTION ACTUALLY HAS.
 *
 * THIS MODULE WAS WRONG UNTIL 2026-09-17, AND SILENTLY SO. It wrote a table of
 * its own design — email-keyed, with `consented_at` and `consent_text` —
 * against a `sms_subscribers` that ALREADY EXISTS in production with a richer
 * and better schema: keyed on the E.164 number, carrying a status, separate
 * marketing and transactional consent, a disclosure version, opt-out keyword
 * and resubscribe counters. The migration file said `create table if not
 * exists`, so applying it would have been a silent no-op, every insert would
 * have failed on columns that do not exist, and this module catches its own
 * errors — so ticking the box would have recorded nothing, minted no code, and
 * reported nothing wrong. Found by reading production before deploying rather
 * than after.
 *
 * THE NUMBER IS THE SUBSCRIBER, which is why the real table is keyed that way:
 * a phone can be reached, an email cannot, and one person may consent from a
 * guest checkout with no account at all. `user_id` ties the row to an account
 * when there is one; `email` (added by the migration beside this file, the one
 * outstanding change) ties it to the address the welcome code is bound to,
 * because the code lives on `coupons.assigned_email`.
 *
 * WHAT A TICK RECORDS: the normalised number, the account if known, the
 * address, `marketing_consent` with its timestamp, which screen collected it,
 * and WHICH VERSION of the sentence was on screen. A later edit to the wording
 * cannot rewrite what somebody agreed to.
 *
 * RESUBSCRIBING IS NOT A SILENT UPDATE. An address that stopped and then ticks
 * the box again clears the stop, stamps `resubscribed_at` and increments
 * `resubscribe_count`, so the history of a number says what actually happened.
 *
 * Never throws. A refused write is logged and answered false; no sign-up,
 * checkout or preference save may fail over a marketing record.
 */

const LOG = "[sms-consent]";

/** Where the box was ticked. Stored on the row as `consent_source`. */
export type SmsConsentSource = "signup" | "checkout" | "account-settings" | "storefront" | "omnisend-form";

type SubscriberRow = {
  phone_e164: string;
  email?: string | null;
  user_id?: string | null;
  status?: string | null;
  marketing_consent?: boolean | null;
  marketing_consent_at?: string | null;
  opted_out_at?: string | null;
  resubscribe_count?: number | null;
};

function normalizeEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

function pushToOmnisend(email: string): void {
  deferOmnisend("sms-consent", () => import("@/lib/marketing/omnisend/hooks").then((hooks) => hooks.onPreferencesChanged(email)));
}

/** The row for a number, or null. Reads never throw. */
async function readByPhone(phone: string): Promise<SubscriberRow | null> {
  const { data, error } = await supabaseAdmin
    .from("sms_subscribers")
    .select("phone_e164, email, user_id, status, marketing_consent, marketing_consent_at, opted_out_at, resubscribe_count")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (error) {
    console.error(LOG, "subscriber read refused", error.message);
    return null;
  }
  return (data as SubscriberRow) ?? null;
}

/**
 * Record a ticked box. False when the number is not one a person could be
 * texted at, or the row was refused.
 *
 * `status` is left at the table's own default on a first insert: this store
 * does not verify a number, so claiming "verified" would be a lie told to the
 * one table a carrier would ask to see. The boolean that decides whether
 * marketing may be sent is `marketing_consent`, and that is what is set.
 */
export async function recordSmsConsent(input: {
  email: string;
  phone: string;
  source: SmsConsentSource;
  userId?: string | null;
}): Promise<boolean> {
  const email = normalizeEmail(input.email);
  const phone = normalizeE164(acceptableSmsPhone(input.phone));
  if (!email || !phone) return false;
  const now = new Date().toISOString();

  try {
    const existing = await readByPhone(phone);
    const resubscribing = Boolean(existing?.opted_out_at);

    const row: Record<string, unknown> = {
      phone_e164: phone,
      email,
      marketing_consent: true,
      marketing_consent_at: now,
      consent_source: input.source,
      disclosure_version: SMS_DISCLOSURE_VERSION,
      opted_out_at: null,
      opt_out_keyword: null,
      updated_at: now,
    };
    if (input.userId) row.user_id = input.userId;
    if (resubscribing) {
      // A stop, then a fresh tick. Both facts are kept: the row says it came
      // back and how many times, which is what an audit of a number asks.
      row.resubscribed_at = now;
      row.resubscribe_count = Number(existing?.resubscribe_count ?? 0) + 1;
      row.status = "pending";
    }

    const { error } = await supabaseAdmin
      .from("sms_subscribers")
      .upsert(row, { onConflict: "phone_e164" });
    if (error) {
      console.error(LOG, "consent row refused", { source: input.source, message: error.message });
      return false;
    }

    // THE ACCOUNT MIRROR, so the settings page shows what the checkout took.
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
 * KEEP THE NUMBER. DO NOT CLAIM PERMISSION TO TEXT IT.
 *
 * Having somebody's phone number and being allowed to market to it are two
 * different facts, and this store had no way to hold the first without
 * asserting the second: every path that stored a number went through
 * recordSmsConsent, which sets marketing_consent. So the wheel could either
 * collect a number and claim a consent nobody gave, or collect nothing.
 *
 * This is the other half. The number lands on the consent ledger and on the
 * account's profile with `marketing_consent` false, which is exactly what
 * readSmsStanding already reads as "none" — so a person whose number we hold
 * and whose box is unticked is NOT subscribed, everywhere that asks, with no
 * new state to get wrong.
 *
 * THE DAY OMNISEND SMS IS APPROVED, NOTHING HERE PROMOTES ANYBODY. Approval
 * changes what the store may send, not what anyone agreed to. A stored number
 * becomes a subscriber only by passing through recordSmsConsent, which only an
 * explicit tick calls.
 *
 * IT NEVER DOWNGRADES AND NEVER RESURRECTS, which is why the insert ignores a
 * duplicate rather than upserting. An upsert carrying `marketing_consent:
 * false` would unsubscribe a live subscriber who typed their number into the
 * wheel, and would wipe the opt-out of somebody who had said STOP. A row that
 * already exists knows more about this number than this call does, so it is
 * left alone.
 */
export async function recordPhoneOnFile(input: {
  email: string;
  phone: string;
  source: SmsConsentSource;
  userId?: string | null;
}): Promise<boolean> {
  const email = normalizeEmail(input.email);
  const phone = normalizeE164(acceptableSmsPhone(input.phone));
  if (!email || !phone) return false;
  const now = new Date().toISOString();

  try {
    const { error } = await supabaseAdmin
      .from("sms_subscribers")
      .upsert(
        {
          phone_e164: phone,
          email,
          // Stated rather than left to the column default, because the whole
          // point of this row is that the answer is no.
          marketing_consent: false,
          // WHERE THE NUMBER CAME FROM, not where a consent came from — there
          // is no consent. An audit asking "why do you hold this number"
          // should find the screen that asked for it.
          consent_source: input.source,
          updated_at: now,
        },
        { onConflict: "phone_e164", ignoreDuplicates: true },
      );
    if (error) {
      console.error(LOG, "phone row refused", { source: input.source, message: error.message });
      return false;
    }

    // THE PROFILE MIRROR, so the number is on the customer's record and a
    // later tick has something to subscribe. Deliberately only the number:
    // touching sms_marketing here would be the inference this function exists
    // to avoid, and the columns left out of an upsert are left alone.
    if (input.userId) {
      const { error: mirrorError } = await supabaseAdmin
        .from("customer_preferences")
        .upsert({ user_id: input.userId, phone, updated_at: now }, { onConflict: "user_id" });
      if (mirrorError) console.error(LOG, "profile phone refused", { source: input.source, message: mirrorError.message });
    }

    pushToOmnisend(email);
    return true;
  } catch (error) {
    console.error(LOG, "phone could not be stored", { source: input.source, error });
    return false;
  }
}

/**
 * Record a stop: the account box unticked, or Omnisend reporting STOP
 * (reconcile.ts). Every row for the ADDRESS is stopped, not just one number,
 * because a person who says stop means the person and not the handset.
 *
 * The stamp is when they said stop (`at`), not when the store found out.
 * Answers "applied", "nothing" (no row, or already stopped) or "failed".
 */
export async function recordSmsOptOut(email: string, at: string, keyword = "STOP"): Promise<"applied" | "nothing" | "failed"> {
  const address = normalizeEmail(email);
  if (!address) return "nothing";
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("phone_e164, opted_out_at")
      .eq("email", address);
    if (error) {
      console.error(LOG, "opt-out read refused", error.message);
      return "failed";
    }
    const rows = (data ?? []) as SubscriberRow[];
    const live = rows.filter((row) => !row.opted_out_at);
    if (live.length === 0) return "nothing";

    const { error: writeError } = await supabaseAdmin
      .from("sms_subscribers")
      .update({
        status: "opted_out",
        marketing_consent: false,
        opted_out_at: at,
        opt_out_keyword: keyword,
        updated_at: new Date().toISOString(),
      })
      .in("phone_e164", live.map((row) => row.phone_e164));
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
 * the store learns of it on the next write-back. This mirrors it ONCE and
 * never again: recordSmsConsent would re-stamp `marketing_consent_at` on every
 * half-hourly tick and quietly rewrite the date the person agreed, which is
 * the one field a carrier dispute turns on. A number that already has a
 * CONSENT — or a stop — is left exactly as it is.
 *
 * A NUMBER THE STORE MERELY HOLDS IS NOT A REASON TO REFUSE A REAL CONSENT,
 * and it briefly was. The guard here used to be "any row at all", which was
 * every row there could be until recordPhoneOnFile started keeping numbers
 * with no permission attached. A wheel entrant who later ticked Omnisend's own
 * pop-up would have hit that row and been left unsubscribed for ever — the
 * store holding their number, Omnisend holding their consent, and nothing
 * joining the two. There is no consent date on such a row to overwrite, which
 * is the whole reason the guard existed, so it is promoted instead.
 *
 * `at` is when Omnisend recorded the consent, not when this run found it.
 */
export async function mirrorSmsConsent(input: { email: string; phone: string; source: SmsConsentSource; at: string }): Promise<"applied" | "nothing" | "failed"> {
  const email = normalizeEmail(input.email);
  const phone = normalizeE164(acceptableSmsPhone(input.phone));
  if (!email || !phone) return "nothing";
  try {
    const existing = await readByPhone(phone);
    // A consent already recorded, or a stop: both say more than this does.
    if (existing && (existing.marketing_consent || existing.opted_out_at)) return "nothing";
    const now = new Date().toISOString();
    const row = {
      phone_e164: phone,
      email,
      marketing_consent: true,
      marketing_consent_at: input.at,
      consent_source: input.source,
      disclosure_version: SMS_DISCLOSURE_VERSION,
      created_at: now,
      updated_at: now,
    };
    // Held-but-unconsented rows already exist, so this is an upsert rather
    // than an insert: the number is the same number, and what changes is that
    // somebody has now agreed to be texted at it.
    const { error } = existing
      ? await supabaseAdmin.from("sms_subscribers").upsert(
          { ...row, created_at: undefined },
          { onConflict: "phone_e164" },
        )
      : await supabaseAdmin.from("sms_subscribers").insert(row);
    if (error) {
      console.error(LOG, "mirror write refused", error.message);
      return "failed";
    }
    return "applied";
  } catch (error) {
    console.error(LOG, "mirror could not be written", error);
    return "failed";
  }
}

/**
 * The number this address is on file with, or null.
 *
 * THIS IS WHAT A LATER TICK SUBSCRIBES. The wheel stops asking for a number
 * once one is held, so the commonest consent has an empty phone field and the
 * number has to come from here — server-side, from the store's own record,
 * never from a body the caller composed.
 *
 * Null on a refused read as well as on a genuine absence. The two are worth
 * separating for the question below, where a wrong "no" puts a field in front
 * of somebody who has already filled it in; here they are not, because both
 * mean the same thing: there is no number this call may subscribe.
 */
export async function phoneOnFileFor(email: string): Promise<string | null> {
  const address = normalizeEmail(email);
  if (!address) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("phone_e164")
      .eq("email", address)
      .limit(1);
    if (error) {
      console.error(LOG, "phone-on-file read refused", error.message);
      return null;
    }
    const held = ((data ?? []) as Array<{ phone_e164: string | null }>)
      .map((row) => String(row.phone_e164 ?? "").trim())
      .find(Boolean);
    return held ?? null;
  } catch (error) {
    console.error(LOG, "phone-on-file read failed", error);
    return null;
  }
}

/**
 * Does the store already hold a number for this address?
 *
 * Asked by the wheel so it does not make somebody type a number the store has
 * already kept. A refused read answers TRUE — the safe direction here is the
 * opposite of the consent reads above: the cost of a wrong "yes" is a number
 * not collected this once, and the cost of a wrong "no" is a field shoved in
 * front of somebody who has already filled it in.
 */
export async function readPhoneOnFile(email: string): Promise<boolean> {
  const address = normalizeEmail(email);
  if (!address) return true;
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("phone_e164")
      .eq("email", address)
      .limit(1);
    if (error) {
      console.error(LOG, "phone-on-file read refused", error.message);
      return true;
    }
    return ((data ?? []) as Array<{ phone_e164: string | null }>).some((row) => String(row.phone_e164 ?? "").trim());
  } catch (error) {
    console.error(LOG, "phone-on-file read failed", error);
    return true;
  }
}

export type SmsStanding = "none" | "subscribed" | "opted_out";

/**
 * Where an ADDRESS stands with the text list, across every number it has
 * consented from. A stop on any of them is a stop; otherwise a live marketing
 * consent on any of them is a subscription.
 *
 * A refused read answers "subscribed", the quiet direction: the cost of a
 * wrong "subscribed" is one missed invitation, and the cost of a wrong "none"
 * is interrupting somebody who already opted out.
 */
export async function readSmsStanding(email: string): Promise<SmsStanding> {
  const address = normalizeEmail(email);
  if (!address) return "subscribed";
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("marketing_consent, opted_out_at")
      .eq("email", address);
    if (error) {
      console.error(LOG, "standing read refused", error.message);
      return "subscribed";
    }
    const rows = (data ?? []) as SubscriberRow[];
    if (rows.length === 0) return "none";
    if (rows.some((row) => row.opted_out_at)) return "opted_out";
    return rows.some((row) => row.marketing_consent) ? "subscribed" : "none";
  } catch (error) {
    console.error(LOG, "standing read failed", error);
    return "subscribed";
  }
}

/**
 * THE NUMBER AND THE STANDING FOR AN ADDRESS, for a screen that has to show a
 * person their own subscription.
 *
 * The account settings page used to read `customer_preferences` alone, which
 * only ever carries a consent taken WHILE SIGNED IN. Somebody who ticked the
 * box at a guest checkout with the same address was subscribed in every way
 * that mattered — the store had their number, the sync pushed it, a text would
 * have reached them — and their own settings page showed the box unticked.
 * That is the store telling a customer something untrue about their own
 * consent, which is the one subject it cannot be casual about.
 */
export async function readSmsSubscriptionForAccount(email: string): Promise<{ phone: string | null; subscribed: boolean }> {
  const address = normalizeEmail(email);
  if (!address) return { phone: null, subscribed: false };
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_subscribers")
      .select("phone_e164, marketing_consent, marketing_consent_at, opted_out_at")
      .eq("email", address)
      .order("marketing_consent_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) {
      console.error(LOG, "account subscription read refused", error.message);
      return { phone: null, subscribed: false };
    }
    const row = ((data ?? []) as SubscriberRow[])[0];
    if (!row) return { phone: null, subscribed: false };
    return {
      phone: row.phone_e164 ?? null,
      subscribed: Boolean(row.marketing_consent) && !row.opted_out_at,
    };
  } catch (error) {
    console.error(LOG, "account subscription read failed", error);
    return { phone: null, subscribed: false };
  }
}
