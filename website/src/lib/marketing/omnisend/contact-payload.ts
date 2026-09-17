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

export type ContactCode = {
  code: string;
  endsAt: string;
  /** The percentage the coupon row carries. Absent when the caller did not read it. */
  percent?: number;
};

/**
 * The store-minted gift for Omnisend's abandoned-cart flow (cart-offers.ts).
 *
 * Text, link, floor and deadline — everything the 72-hour message needs to
 * describe and hand over the gift without a code. The link is the claim URL
 * the in-house recovery email carries, wrapped in the contact's own signed
 * door so the click lands past the account wall with the offer cookie set.
 */
export type RecoveryGiftFacts = {
  /** "a free GHK-Cu 50mg and a free Recon Water", from catalogue names. */
  text: string;
  /** Absolute claim URL. */
  link: string;
  /** The smallest order the gift may be spent against, in cents. */
  minCartCents: number;
  /** ISO 8601: when the offer row expires. */
  endsAt: string;
};

/**
 * The same four facts describe every store-minted gift Omnisend shows. The
 * welcome gift (welcome-gift.ts) is one; it rides under its own five
 * properties (vl_welcome_gift*) with the same three-way meaning as the
 * recovery gift: an object writes, null clears, undefined leaves alone.
 */
export type GiftFacts = RecoveryGiftFacts;

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
  recoveryGift?: RecoveryGiftFacts | null;
  welcomeGift?: GiftFacts | null;
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

/**
 * The date an UNKNOWN email status is stamped with.
 *
 * The epoch, on purpose: Omnisend keeps whichever status carries the later
 * date, so a status dated here can never displace one a person actually gave.
 * See buildContactPayload's email channel for the whole argument.
 */
const UNKNOWN_STATUS_CHANGED_AT = "1970-01-01T00:00:00.000Z";

/** `consent` is only meaningful for a status somebody chose, so it needs a source. */
function consentBlock(consent: ChannelConsent): { consent: { source: string; createdAt: string } } | Record<string, never> {
  const source = text(consent.source);
  return source ? { consent: { source, createdAt: consent.changedAt } } : {};
}

function readyFlag(code: string | null | undefined): "yes" | "no" {
  return text(code) ? "yes" : "no";
}

/** A whole percentage, 0 when there is none: the template prints it beside the code. */
function wholePercent(value: number | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(100, Math.round(parsed));
}

/**
 * "$100", or "$35.50" when the floor has cents — the same shape the in-house
 * gift terms sentence prints (gift-terms.ts), so a customer who has seen both
 * reads one number.
 */
export function formatMinCart(cents: number): string {
  const whole = Math.max(0, Math.round(Number(cents) || 0));
  return `$${(whole / 100).toFixed(whole % 100 === 0 ? 0 : 2)}`;
}

/** A gift is ready only when there is something to say and somewhere to send the click. */
function recoveryGiftReady(gift: RecoveryGiftFacts | null | undefined): gift is RecoveryGiftFacts {
  return Boolean(gift && text(gift.text) && text(gift.link));
}

/**
 * The five properties one store-minted gift occupies, under a prefix. The
 * merge-preserving rule below (undefined sends nothing) is applied by the
 * caller; this only spells the values for a gift that is present or cleared.
 */
function giftPropertySet(prefix: string, gift: GiftFacts | null): Record<string, string> {
  return {
    [prefix]: gift ? text(gift.text) : "",
    [`${prefix}_link`]: gift ? text(gift.link) : "",
    [`${prefix}_min`]: gift ? formatMinCart(gift.minCartCents) : "",
    [`${prefix}_ends`]: gift ? dateOnly(gift.endsAt) : "",
    [`${prefix}_ready`]: gift ? "yes" : "no",
  };
}

export function buildContactPayload(facts: ContactFacts): Record<string, unknown> {
  // Omnisend email identifiers are case-sensitive; the store's are not. Every
  // address is lowercased here so one person can never become two contacts.
  const email = facts.email.trim().toLowerCase();

  // EVERY EMAIL IDENTIFIER CARRIES A CHANNEL BLOCK, INCLUDING THE UNKNOWN ONE.
  //
  // This used to omit `channels` entirely for nonSubscribed. The reasoning was
  // right and the code was not. Omnisend's contacts reference defines
  // nonSubscribed as "Channel's status is unknown (contact hasn't subscribed or
  // unsubscribed yet)" and says "The system will return the status with the
  // latest status update date" — so posting nonSubscribed stamped `now` would
  // overwrite a `subscribed` the person gave through Omnisend's own form and
  // drop them out of every flow. Omitting the block looked like the way to
  // avoid that, and the post_contacts schema appears to allow it.
  //
  // THE API REFUSES IT. The first real contacts batch, on 2026-09-17, answered
  // 400 "Provide email channel for email identifier" for exactly one item of
  // forty-one — the one buyer with no consent on record — and created the rest.
  // So the nightly push would have silently failed for every address the store
  // knows but has no consent for, which is the entire reason buyers without
  // consent are pushed at all. A 400 per item inside a background batch is not
  // visible anywhere a person looks; it is `errorsCount` on a batch record.
  //
  // So the block goes, and the overwrite is prevented the way Omnisend
  // documents rather than by omission. Same reference, "Channel status date":
  // "If you submit a status date earlier than the one already stored, the
  // status and its date will not be updated." An unknown status is therefore
  // dated at the epoch — earlier than any real consent Omnisend can hold — and
  // loses every race by construction, while still creating a contact Omnisend
  // has never seen as nonSubscribed, which is the truth about them.
  //
  // The store's own `changedAt` is deliberately NOT used here: for this branch
  // collectContactFacts sets it to `now` (it has no record to date it with),
  // and `now` beats everything.
  const emailChannel = facts.emailConsent.status === "nonSubscribed"
    ? { channels: { email: { status: "nonSubscribed", statusChangedAt: UNKNOWN_STATUS_CHANGED_AT } } }
    : {
      channels: { email: { status: facts.emailConsent.status, statusChangedAt: facts.emailConsent.changedAt } },
      ...consentBlock(facts.emailConsent),
    };
  const identifiers: Array<Record<string, unknown>> = [
    {
      type: "email",
      id: email,
      ...emailChannel,
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
  // THE GIFT BLOCK IS MERGE-PRESERVING. Every contact upsert is a POST merge
  // on the identifier, and only the cart-offer sweep knows the gift; the
  // nightly reconcile, the consent hooks and the order hook do not. So a
  // caller that says nothing (undefined) sends none of the five keys and the
  // gift the sweep set survives; a caller that knows there is none (null, or
  // a gift with no text or link) sends the cleared values; an object sends
  // the values. "" removes a property in Omnisend, so undefined and null are
  // deliberately different things here.
  const gift = recoveryGiftReady(facts.recoveryGift) ? facts.recoveryGift : null;
  const giftProperties = facts.recoveryGift === undefined ? {} : giftPropertySet("vl_recovery_gift", gift);
  // THE WELCOME GIFT, SAME RULE. Its one writer is the opt-in hook (and the
  // reconcile, which clears it once the row is spent or expired); the paid
  // hook clears it explicitly because a first order ends the offer whether
  // or not the vial was claimed.
  const welcome = recoveryGiftReady(facts.welcomeGift) ? facts.welcomeGift : null;
  const welcomeGiftProperties = facts.welcomeGift === undefined ? {} : giftPropertySet("vl_welcome_gift", welcome);
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
    // The recovery offer for Omnisend's 72-hour message (cart-offers.ts).
    // The percentage rides beside the code so the template can print "15%
    // off" from the row that was actually minted; the gift is a separate
    // block with its own flag, because a band may carry either, both or
    // neither, and the message shows exactly what the till will honour.
    vl_recovery_percent: text(codes.recovery?.code) ? wholePercent(codes.recovery?.percent) : 0,
    ...giftProperties,
    ...welcomeGiftProperties,
  };

  const payload: Record<string, unknown> = { identifiers };
  // Profile fields are omitted rather than sent empty: an empty string here
  // would blank a value Omnisend already holds from a form or an import.
  const firstName = text(facts.firstName);
  const lastName = text(facts.lastName);
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  // The country too: a US default here would overwrite a country Omnisend
  // already holds. The default lives only in normalizeE164 above, where it
  // decides how a bare ten-digit number is read.
  const countryCode = text(facts.countryCode).toUpperCase();
  if (countryCode) payload.countryCode = countryCode;
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
