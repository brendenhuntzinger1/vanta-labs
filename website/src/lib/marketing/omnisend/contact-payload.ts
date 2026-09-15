import { DISPLAY_TIME_ZONE } from "@/lib/format-date";

/**
 * The Omnisend contact, built from facts and nothing else.
 *
 * Pure on purpose. The field names below are Omnisend's, not ours, and a wrong
 * one does not error: Omnisend answers 200 and quietly ignores the property,
 * or — worse, for consent — records a channel status we did not mean. So this
 * module has no I/O and every name is pinned by contact-payload.test.ts
 * against fixed inputs. The server-only half (contacts.ts) gathers the facts
 * and posts what this returns; it never adds a field of its own.
 *
 * NO "server-only" IMPORT HERE. That is what makes it unit-testable, and it is
 * also why it must never touch the database or the environment.
 */

export type ConsentStatus = "subscribed" | "unsubscribed" | "nonSubscribed";

export type ChannelConsent = {
  status: ConsentStatus;
  /** ISO 8601: when the status last changed, from the store's own record. */
  changedAt: string;
  /** Where the consent was collected. Absent for a status that is not consent. */
  source?: string | null;
};

export type ContactCode = { code: string; endsAt: string };

export type ContactFacts = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  state?: string | null;
  city?: string | null;
  postalCode?: string | null;
  emailConsent: ChannelConsent;
  smsConsent?: ChannelConsent | null;
  attested: boolean;
  orders: number;
  totalSpent: number;
  firstOrderAt?: string | null;
  lastOrderAt?: string | null;
  referralCode?: string | null;
  link?: { token: string; endsAt: string } | null;
  codes?: Partial<Record<"welcome" | "winback" | "recovery", ContactCode>>;
};

/**
 * A phone number as Omnisend wants it: E.164, leading plus.
 *
 * Deliberately small. Stored numbers were typed into an account-settings box
 * with no validation, so punctuation and spacing vary; none of it is part of
 * the number. Without a country prefix only North American numbers can be
 * read with confidence (ten digits, or eleven with the trunk 1), which is
 * where every customer is. Anything else is null, and null means the phone
 * identifier is left off the contact rather than sent wrong: a mis-parsed
 * number is a text to a stranger.
 */
export function normalizeE164(raw: string | null | undefined, defaultCountry = "US"): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (value.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const country = String(defaultCountry ?? "").trim().toUpperCase();
  if (country !== "US" && country !== "CA") return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "Jane Q Doe" → Jane / Q Doe. One word is a first name; nothing is nothing. */
export function splitName(full: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * A calendar date in the store's display zone, or "" when there is none.
 *
 * Omnisend date properties are YYYY-MM-DD, and the day is chosen in the
 * display zone rather than sliced off the UTC timestamp because a code that
 * ends at 01:00Z is dead by 9 pm Eastern the evening BEFORE that UTC date. An
 * email saying "ends 29 September" for a code that stops working on the 28th
 * is the kind of wrong that costs an order and a complaint; the display-zone
 * day can only ever understate.
 */
function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Omnisend removes a custom property whose value is "", so absent is "". */
function text(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `consent` is only meaningful for a status somebody chose, so it needs a source. */
function consentBlock(consent: ChannelConsent): { consent: { source: string; createdAt: string } } | Record<string, never> {
  const source = text(consent.source);
  return source ? { consent: { source, createdAt: consent.changedAt } } : {};
}

function readyFlag(code: string | null | undefined): "yes" | "no" {
  return text(code) ? "yes" : "no";
}

export function buildContactPayload(facts: ContactFacts): Record<string, unknown> {
  // Omnisend email identifiers are case-sensitive; the store's are not. Every
  // address is lowercased here so one person can never become two contacts.
  const email = facts.email.trim().toLowerCase();

  const identifiers: Array<Record<string, unknown>> = [
    {
      type: "email",
      id: email,
      channels: { email: { status: facts.emailConsent.status, statusChangedAt: facts.emailConsent.changedAt } },
      ...consentBlock(facts.emailConsent),
      // Omnisend's own welcome mail stays off: the welcome flow (spec §6) is
      // the one that sends, and it is created disabled until the owner reviews it.
      sendWelcomeMessage: false,
    },
  ];

  // A phone number reaches Omnisend only alongside an SMS consent record
  // (spec §9: "phone number (only with SMS consent)"). A number typed into
  // account settings as a support contact, with the SMS box never touched, is
  // not the customer's to text and not ours to hand over.
  const phone = facts.smsConsent ? normalizeE164(facts.phone, facts.countryCode ?? "US") : null;
  if (phone && facts.smsConsent) {
    identifiers.push({
      type: "phone",
      id: phone,
      channels: { sms: { status: facts.smsConsent.status, statusChangedAt: facts.smsConsent.changedAt } },
      ...consentBlock(facts.smsConsent),
    });
  }

  const tags = ["source: website"];
  if (facts.orders > 0) tags.push("customer");
  if (facts.attested) tags.push("attested");

  const codes = facts.codes ?? {};
  const customProperties = {
    vl_link: text(facts.link?.token),
    vl_link_ends: dateOnly(facts.link?.endsAt),
    vl_attested: Boolean(facts.attested),
    vl_orders: Math.max(0, Math.trunc(Number(facts.orders) || 0)),
    vl_total_spent: round2(Number(facts.totalSpent) || 0),
    vl_first_order_at: dateOnly(facts.firstOrderAt),
    vl_last_order_at: dateOnly(facts.lastOrderAt),
    vl_referral_code: text(facts.referralCode),
    vl_welcome_code: text(codes.welcome?.code),
    vl_welcome_ends: dateOnly(codes.welcome?.endsAt),
    vl_winback_code: text(codes.winback?.code),
    vl_winback_ends: dateOnly(codes.winback?.endsAt),
    vl_recovery_code: text(codes.recovery?.code),
    vl_recovery_ends: dateOnly(codes.recovery?.endsAt),
    // Omnisend's conditional-content filter can test "is yes" but not "is not
    // empty", so each code carries an explicit flag the template sections key
    // off. Presence is the whole test: a code is only ever pushed while it is
    // live, and the nightly reconcile clears it once it expires or is spent.
    vl_welcome_ready: readyFlag(codes.welcome?.code),
    vl_winback_ready: readyFlag(codes.winback?.code),
    vl_recovery_ready: readyFlag(codes.recovery?.code),
  };

  const payload: Record<string, unknown> = { identifiers };
  // Profile fields are omitted rather than sent empty: an empty string here
  // would blank a value Omnisend already holds from a form or an import.
  const firstName = text(facts.firstName);
  const lastName = text(facts.lastName);
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  payload.countryCode = text(facts.countryCode).toUpperCase() || "US";
  const state = text(facts.state);
  const city = text(facts.city);
  const postalCode = text(facts.postalCode);
  if (state) payload.state = state;
  if (city) payload.city = city;
  if (postalCode) payload.postalCode = postalCode;
  payload.tags = tags;
  payload.customProperties = customProperties;
  return payload;
}
