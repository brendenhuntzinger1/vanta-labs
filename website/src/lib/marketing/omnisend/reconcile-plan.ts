/**
 * The nightly reconcile's decisions, made from data and nothing else.
 *
 * Pure on purpose, like contact-payload.ts. The write-back is the one place
 * where Omnisend's view of a person can CHANGE the store's consent record, so
 * the rule that decides what to write is small, has no I/O, and is pinned by
 * reconcile-plan.test.ts against fixed inputs. The server-only half
 * (reconcile.ts) loads the sets, fetches the pages, and applies what this
 * returns; it never adds a decision of its own.
 *
 * THE RULE, in one sentence: an Omnisend status may make the store's record
 * SMALLER (an unsubscribe becomes a suppression, an SMS opt-out becomes an
 * opt-out stamp) or may ADD a consent the store never heard about (a sign-up
 * through Omnisend's own form), but it may never re-open one the store has
 * closed. A suppressed address stays suppressed whatever Omnisend says
 * (spec §3.2: copied exactly, never widened).
 *
 * NO "server-only" IMPORT HERE. That is what makes it unit-testable, and it is
 * also why it must never touch the database or the environment.
 */

export type OmnisendChannelStatus = "subscribed" | "unsubscribed" | "nonSubscribed";

/** One contact as Omnisend reports it, reduced to what the write-back reads. */
export type OmnisendContactRead = {
  email: string | null;
  phone: string | null;
  emailStatus: OmnisendChannelStatus | null;
  smsStatus: OmnisendChannelStatus | null;
  updatedAt?: string | null;
};

/** What the store already knows, each set lowercased by the loader. */
export type KnownConsent = {
  /** email_suppressions. */
  suppressed: Set<string>;
  /** The consented audience: both consent stores, minus suppressions. */
  subscribers: Set<string>;
  /** Addresses whose account already carries an SMS opt-out stamp. */
  smsOptedOut: Set<string>;
};

export type WriteBackPlan = {
  /** Write email_suppressions {reason: unsubscribed, source: omnisend}. */
  suppress: string[];
  /** Stamp customer_preferences.sms_opted_out_at. */
  smsOptOut: string[];
  /** Write marketing_subscribers {source: omnisend-form}. */
  newSubscribers: string[];
};

function normalizeEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

export function planWriteBack(contacts: OmnisendContactRead[], known: KnownConsent): WriteBackPlan {
  const suppress = new Set<string>();
  const smsOptOut = new Set<string>();
  const newSubscribers = new Set<string>();

  for (const contact of contacts) {
    const email = normalizeEmail(contact.email);
    // A contact with no email identifier has nothing to key a store record on;
    // the SMS stores are keyed by account, and the account is found by email.
    if (!email) continue;

    if (contact.emailStatus === "unsubscribed" && !known.suppressed.has(email)) {
      suppress.add(email);
    } else if (
      contact.emailStatus === "subscribed"
      && !known.subscribers.has(email)
      // Never widened: a suppressed address is not re-subscribed on the
      // strength of a status Omnisend holds, whoever set it there.
      && !known.suppressed.has(email)
    ) {
      newSubscribers.add(email);
    }

    if (contact.smsStatus === "unsubscribed" && !known.smsOptedOut.has(email)) {
      smsOptOut.add(email);
    }
  }

  return {
    suppress: [...suppress],
    smsOptOut: [...smsOptOut],
    newSubscribers: [...newSubscribers],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function statusOf(value: unknown): OmnisendChannelStatus | null {
  return value === "subscribed" || value === "unsubscribed" || value === "nonSubscribed" ? value : null;
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/**
 * The `GET /contacts` envelope, read defensively.
 *
 *   { contacts: [ { identifiers: [ { type, id, channels: { email?: { status }, sms?: { status } } } ],
 *                  updatedAt } ],
 *     paging: { cursors: { after, before }, hasMore, limit } }
 *
 * A contact can carry several identifiers; the first email and the first
 * phone are the ones read, because the store keys everything on one address.
 * Anything missing or mis-typed reads as null, never as a status — a null
 * status plans nothing, which is the safe direction for a write-back.
 */
export function parseOmnisendContacts(body: unknown): OmnisendContactRead[] {
  const root = asRecord(body);
  const list = Array.isArray(root?.contacts) ? root.contacts : [];
  const contacts: OmnisendContactRead[] = [];

  for (const raw of list) {
    const contact = asRecord(raw);
    if (!contact) continue;
    const identifiers = Array.isArray(contact.identifiers) ? contact.identifiers : [];

    let email: string | null = null;
    let phone: string | null = null;
    let emailStatus: OmnisendChannelStatus | null = null;
    let smsStatus: OmnisendChannelStatus | null = null;

    for (const rawIdentifier of identifiers) {
      const identifier = asRecord(rawIdentifier);
      if (!identifier) continue;
      const channels = asRecord(identifier.channels);
      if (identifier.type === "email" && email === null) {
        email = normalizeEmail(identifier.id);
        emailStatus = statusOf(asRecord(channels?.email)?.status);
      } else if (identifier.type === "phone" && phone === null) {
        phone = textOrNull(identifier.id);
        smsStatus = statusOf(asRecord(channels?.sms)?.status);
      }
    }

    if (email === null && phone === null) continue;
    contacts.push({ email, phone, emailStatus, smsStatus, updatedAt: textOrNull(contact.updatedAt) });
  }

  return contacts;
}

/** The cursor to follow, if Omnisend says there is another page. */
export function parseOmnisendPaging(body: unknown): { after: string | null; hasMore: boolean } {
  const paging = asRecord(asRecord(body)?.paging);
  const cursors = asRecord(paging?.cursors);
  const after = textOrNull(cursors?.after);
  return { after, hasMore: paging?.hasMore === true && after !== null };
}

/**
 * The newest updatedAt among the contacts read: the next run's watermark.
 * Compared as instants, not strings, so a mix of offsets cannot mis-order.
 */
export function latestUpdatedAt(contacts: OmnisendContactRead[]): string | null {
  let latest: { at: number; text: string } | null = null;
  for (const contact of contacts) {
    const text = textOrNull(contact.updatedAt);
    if (!text) continue;
    const at = Date.parse(text);
    if (!Number.isFinite(at)) continue;
    if (!latest || at > latest.at) latest = { at, text };
  }
  return latest?.text ?? null;
}
