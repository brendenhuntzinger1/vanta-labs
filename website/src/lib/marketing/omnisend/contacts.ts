import "server-only";

import { findUserByEmail } from "@/lib/auth-confirmation-email";
import { recipientHasAttested } from "@/lib/email/recipient-attestation";
import { PAID_ORDER_STATUSES, isProductPurchaseOrder } from "@/lib/ledger";
import { omnisendActive, omnisendRequest } from "@/lib/marketing/omnisend/client";
import {
  buildContactPayload,
  splitName,
  type ChannelConsent,
  type ContactFacts,
} from "@/lib/marketing/omnisend/contact-payload";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The store's record of a person, gathered for Omnisend.
 *
 * Consent is COPIED, never widened (spec §3.2). The email channel status is
 * derived from the same three stores the in-house sender consults — the
 * suppression list, the guest opt-in list and the account preference — in the
 * same order of precedence, so a person Omnisend may mail is exactly a person
 * the store may mail. SMS starts from the account box and nothing else.
 *
 * Every read tolerates its own failure. A missing table or a transient
 * refusal degrades ONE fact (logged), and the direction of every degradation
 * is the safe one: an unreadable consent store yields nonSubscribed, never
 * subscribed. The one exception is the suppression read, which on failure is
 * "unknown" rather than "not suppressed", and unknown means NO FACTS AT ALL
 * (collectContactFacts returns null and every caller skips the address).
 * It used to mean "unsubscribed, changed now", which was worse than a guess:
 * Omnisend keeps the status with the newest statusChangedAt, so one
 * transient refusal unsubscribed the person for good and the next
 * write-back mirrored it into the store. Fail closed means do not push.
 */

const LOG = "[omnisend/contacts]";

export type ContactExtras = {
  link?: ContactFacts["link"];
  codes?: ContactFacts["codes"];
  /** The store-minted gift for Omnisend's abandoned-cart flow (cart-offers.ts). */
  recoveryGift?: ContactFacts["recoveryGift"];
};

type SubscriberRow = { email: string; source: string | null; opted_in_at: string | null; unsubscribed_at: string | null };
type SuppressionRow = { email: string; reason: string | null; created_at: string | null };
type PreferencesRow = {
  marketing_emails: boolean | null;
  updated_at: string | null;
  phone: string | null;
  sms_marketing: boolean | null;
  sms_consent_at: string | null;
  sms_opted_out_at: string | null;
  referral_code: string | null;
};
type OrderRow = {
  customer_name: string | null;
  state: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  amount_paid: number | string | null;
  paid_at: string | null;
  created_at: string | null;
  order_type: string | null;
  replacement_of: string | null;
};

/** The suppression read distinguishes "none" from "could not tell". */
type SuppressionRead = { known: true; row: SuppressionRow | null } | { known: false };

function normalizeEmail(email: string): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

async function readSubscriber(email: string): Promise<SubscriberRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("marketing_subscribers")
      .select("email, source, opted_in_at, unsubscribed_at")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      console.error(LOG, "subscriber read refused", error.message);
      return null;
    }
    return (data as SubscriberRow | null) ?? null;
  } catch (error) {
    console.error(LOG, "subscriber read failed", error);
    return null;
  }
}

/**
 * Unknown, not "not suppressed". Every other read failing means a fact is
 * missing; this one failing "clean" would mean a person who unsubscribed is
 * told to Omnisend as subscribed. The caller maps unknown to "no facts".
 */
async function readSuppression(email: string): Promise<SuppressionRead> {
  try {
    const { data, error } = await supabaseAdmin
      .from("email_suppressions")
      .select("email, reason, created_at")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      console.error(LOG, "suppression read refused", error.message);
      return { known: false };
    }
    return { known: true, row: (data as SuppressionRow | null) ?? null };
  } catch (error) {
    console.error(LOG, "suppression read failed", error);
    return { known: false };
  }
}

async function readUser(email: string): Promise<{ id: string; fullName: string | null } | null> {
  try {
    const user = await findUserByEmail(email);
    if (!user?.id) return null;
    const fullName = user.user_metadata?.full_name;
    return { id: user.id, fullName: typeof fullName === "string" && fullName.trim() ? fullName : null };
  } catch (error) {
    console.error(LOG, "auth user lookup failed", error);
    return null;
  }
}

async function readPreferences(userId: string): Promise<PreferencesRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("customer_preferences")
      .select("marketing_emails, updated_at, phone, sms_marketing, sms_consent_at, sms_opted_out_at, referral_code")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      // A column this select names that the database does not have (an
      // unapplied migration) lands here too, and reads as "no preferences":
      // the account opt-in is lost for this sync, which is the direction that
      // cannot mail anyone who did not ask.
      console.error(LOG, "preferences read refused", error.message);
      return null;
    }
    return (data as PreferencesRow | null) ?? null;
  } catch (error) {
    console.error(LOG, "preferences read failed", error);
    return null;
  }
}

/**
 * Paid product orders for the address, newest first.
 *
 * Replacement reships and membership charges are not purchases of product
 * (the same isProductPurchaseOrder every ledger uses), so they neither count
 * nor spend. Paid means the store's own definition — PAID_ORDER_STATUSES —
 * not the single literal, so an order recorded as "completed" is still a
 * purchase. Bounded rather than paged: this is one address, and no customer
 * has hundreds of orders; if one ever does, the newest 500 still give the
 * right name, address, last order and customer tag.
 */
async function readOrders(email: string): Promise<OrderRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("customer_name, state, city, postal_code, country, amount_paid, paid_at, created_at, order_type, replacement_of")
      .eq("customer_email", email)
      .in("payment_status", Array.from(PAID_ORDER_STATUSES))
      .order("paid_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) {
      console.error(LOG, "orders read refused", error.message);
      return [];
    }
    return ((data ?? []) as OrderRow[]).filter((row) => isProductPurchaseOrder(row));
  } catch (error) {
    console.error(LOG, "orders read failed", error);
    return [];
  }
}

async function readAttested(email: string): Promise<boolean> {
  try {
    return await recipientHasAttested(email);
  } catch (error) {
    console.error(LOG, "attestation lookup failed", error);
    return false;
  }
}

/**
 * Spec §3.2, in order of precedence. Suppressed wins over everything; then
 * either consent store makes the address subscribed; then a guest opt-out
 * that was never re-consented; then a person the store merely knows about.
 */
function emailConsentFrom(input: {
  subscriber: SubscriberRow | null;
  suppression: Extract<SuppressionRead, { known: true }>;
  prefs: PreferencesRow | null;
  now: string;
}): ChannelConsent {
  const { subscriber, suppression, prefs, now } = input;
  if (suppression.row) {
    return { status: "unsubscribed", changedAt: suppression.row.created_at ?? now };
  }
  const subscriberActive = Boolean(subscriber) && !subscriber?.unsubscribed_at;
  if (subscriberActive || prefs?.marketing_emails) {
    const changedAt = (subscriberActive ? subscriber?.opted_in_at : prefs?.updated_at) ?? now;
    const source = subscriberActive && subscriber?.source ? subscriber.source : "account-settings";
    return { status: "subscribed", changedAt, source };
  }
  if (subscriber?.unsubscribed_at) {
    return { status: "unsubscribed", changedAt: subscriber.unsubscribed_at };
  }
  return { status: "nonSubscribed", changedAt: now };
}

/** SMS: the account box with a number is consent; the opt-out stamp is not; nothing else is anything. */
function smsConsentFrom(prefs: PreferencesRow | null, now: string): ChannelConsent | null {
  if (!prefs) return null;
  const phone = String(prefs.phone ?? "").trim();
  if (prefs.sms_marketing && phone) {
    return { status: "subscribed", changedAt: prefs.sms_consent_at ?? prefs.updated_at ?? now, source: "account-settings" };
  }
  if (prefs.sms_opted_out_at) {
    return { status: "unsubscribed", changedAt: prefs.sms_opted_out_at };
  }
  return null;
}

/**
 * orders.country holds whatever the checkout of the day wrote — a code or a
 * name. Only a value that is unambiguously a code or a known name becomes a
 * countryCode; anything else is left for the payload's US default.
 */
function countryCodeFrom(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  const name = value.toLowerCase();
  if (name === "united states" || name === "united states of america" || name === "usa") return "US";
  if (name === "canada") return "CA";
  return null;
}

function orderTime(row: OrderRow): number {
  const at = new Date(String(row.paid_at ?? row.created_at ?? "")).getTime();
  return Number.isNaN(at) ? 0 : at;
}

export async function collectContactFacts(email: string, extras: ContactExtras = {}): Promise<ContactFacts | null> {
  const address = normalizeEmail(email);
  if (!address) return null;
  const now = new Date().toISOString();

  const [subscriber, suppression, user, orders, attested] = await Promise.all([
    readSubscriber(address),
    readSuppression(address),
    readUser(address),
    readOrders(address),
    readAttested(address),
  ]);
  if (!suppression.known) {
    // Cannot tell whether this person unsubscribed. Telling Omnisend
    // "subscribed" on a guess is the one error this module may never make,
    // and telling it "unsubscribed" on a guess is permanent (see the header).
    // So nothing is told: the address is skipped this time and the next
    // push, hook or sweep reads it again.
    console.error(LOG, "suppression read unknown; contact skipped", { domain: address.slice(address.indexOf("@") + 1) });
    return null;
  }
  const prefs = user ? await readPreferences(user.id) : null;

  const timed = orders.map((row) => ({ row, at: orderTime(row) })).filter((entry) => entry.at > 0);
  const latest = [...timed].sort((a, b) => b.at - a.at)[0]?.row ?? orders[0] ?? null;
  const firstAt = timed.length ? Math.min(...timed.map((entry) => entry.at)) : null;
  const lastAt = timed.length ? Math.max(...timed.map((entry) => entry.at)) : null;
  const totalSpent = Math.round(orders.reduce((sum, row) => sum + (Number(row.amount_paid ?? 0) || 0), 0) * 100) / 100;

  // The name the customer most recently gave at checkout beats the one on the
  // account, which may be years old; the account's is the fallback for a
  // subscriber who has never bought.
  const { firstName, lastName } = splitName(latest?.customer_name || user?.fullName || null);

  return {
    email: address,
    firstName,
    lastName,
    phone: prefs?.phone ?? null,
    countryCode: countryCodeFrom(latest?.country),
    state: latest?.state ?? null,
    city: latest?.city ?? null,
    postalCode: latest?.postal_code ?? null,
    emailConsent: emailConsentFrom({ subscriber, suppression, prefs, now }),
    smsConsent: smsConsentFrom(prefs, now),
    attested,
    orders: orders.length,
    totalSpent,
    firstOrderAt: firstAt === null ? null : new Date(firstAt).toISOString(),
    lastOrderAt: lastAt === null ? null : new Date(lastAt).toISOString(),
    referralCode: prefs?.referral_code ?? null,
    link: extras.link ?? null,
    codes: extras.codes ?? {},
    recoveryGift: extras.recoveryGift ?? null,
  };
}

/**
 * Collect, build, post. True when Omnisend accepted the contact.
 *
 * The gate is asked FIRST, before any database work: a preview deployment or
 * a build without a key returns here having done nothing, which is the same
 * order the transport itself enforces.
 */
export async function upsertOmnisendContact(email: string, extras: ContactExtras = {}): Promise<boolean> {
  try {
    const active = omnisendActive();
    if (!active.active) return false;
    const facts = await collectContactFacts(email, extras);
    if (!facts) return false;
    const body = buildContactPayload(facts);
    const result = await omnisendRequest({ method: "POST", path: "/contacts", body });
    if (!result.ok) {
      console.error(LOG, "contact upsert refused", { status: result.status, error: result.error });
    }
    return result.ok;
  } catch (error) {
    console.error(LOG, "contact upsert failed", error);
    return false;
  }
}
