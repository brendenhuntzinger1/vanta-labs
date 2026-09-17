/**
 * WHAT OMNISEND'S MAILBOX VERDICTS MEAN FOR THE SUPPRESSION LIST — the pure half.
 *
 * THE GAP THIS CLOSES. The nightly write-back already mirrors an Omnisend
 * UNSUBSCRIBE into `email_suppressions`, because the contacts API carries a
 * channel status and `unsubscribed` is one of its three values. It carries no
 * bounce field at all. So once Omnisend owns marketing sending, a hard bounce
 * or a spam complaint that Omnisend observes reaches the store only if Omnisend
 * also flips the channel to `unsubscribed` — which is not documented and was
 * not observed. Resend's webhook does that job today and stops seeing marketing
 * mail at cutover, which would leave the store's list — the list that protects
 * the domain carrying every receipt — learning nothing about dead or hostile
 * addresses.
 *
 * WHERE THE FACTS COME FROM. `POST /api/events/query` returns per-contact
 * events, and two of its standard names are exactly the verdicts wanted:
 * `marked message as spam` and `message delivery failed`. It takes contact ids
 * (up to 100 a call, 20 calls a minute), which the contacts read already has.
 *
 * THE TWO VERDICTS ARE NOT THE SAME KIND OF FACT, and this module exists so
 * that distinction is a tested rule rather than a line of prose:
 *
 *   * `marked message as spam` is unambiguous and it is the mailbox owner's
 *     own act. It maps to `complained`, which suppression-reasons.ts classes
 *     as PROVIDER_IMPOSED and the customer cannot lift from their account page.
 *     One is enough.
 *
 *   * `message delivery failed` does NOT say whether the failure is permanent.
 *     A full mailbox and a mailbox that never existed produce the same event
 *     name. Writing an unliftable `bounced` for a customer whose mailbox was
 *     full for a week is the expensive direction of that mistake, so a failure
 *     only counts toward the consecutive-run escalation the store already has
 *     (CONSECUTIVE_SOFT_BOUNCE_LIMIT, reason `soft_bounce_run`) — customer-
 *     reversible — UNLESS the event's own properties say the failure was
 *     permanent, in which case it is a real `bounced`.
 *
 * No `server-only`, no I/O: every decision here is a function of events the
 * caller fetched, so the rules can be tested without a network or a database.
 */

/** The two standard Omnisend event names this feed reads. */
export const SPAM_EVENT = "marked message as spam";
export const DELIVERY_FAILED_EVENT = "message delivery failed";

/** How many delivery failures, with no success in between, retire an address. */
export const DELIVERY_FAILURE_RUN_LIMIT = 5;

export type OmnisendContactEvent = {
  contactID: string;
  eventName: string;
  eventOccurredAt: string;
  properties?: Record<string, unknown> | null;
};

/** What the store should do about one address, and why. */
export type ProviderVerdict = {
  email: string;
  /** The reason written to email_suppressions. */
  reason: "complained" | "bounced" | "soft_bounce_run";
  /** When the mailbox said so — dates the suppression, never `now`. */
  at: string;
  /** The event that decided it, for the alert context. */
  evidence: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Does this delivery failure say, in its own properties, that it is permanent?
 *
 * Omnisend's event name does not distinguish hard from soft, but the origin
 * that submitted it may have put a reason in `properties`. Read defensively and
 * only ever to make the verdict MORE precise: anything unrecognised falls
 * through to the run-based escalation, which is the reversible direction.
 */
export function failureIsPermanent(properties: Record<string, unknown> | null | undefined): boolean {
  if (!properties) return false;
  for (const key of ["bounceType", "bounce_type", "type", "reason", "status", "category"]) {
    const value = text(properties[key]).toLowerCase();
    if (!value) continue;
    if (/\b(hard|permanent|invalid|nonexistent|non-existent|no[_\s-]?such[_\s-]?(user|mailbox)|unknown[_\s-]?user|does[_\s-]?not[_\s-]?exist|5\.\d\.\d)\b/.test(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Turn one contact's events into the verdict for that contact, or null.
 *
 * A complaint outranks everything: it is the only verdict that is both certain
 * and costly to ignore. Otherwise a single permanent failure suppresses, and
 * failing that a long enough run of failures does.
 *
 * Events are NOT assumed sorted. Omnisend's own documentation says results are
 * grouped per contact and per origin rather than globally ordered, so the
 * newest is found rather than taken from the end.
 */
export function verdictForContact(input: {
  email: string;
  events: OmnisendContactEvent[];
}): ProviderVerdict | null {
  const { email, events } = input;
  if (!email || events.length === 0) return null;

  const complaints = events.filter((event) => event.eventName === SPAM_EVENT);
  if (complaints.length > 0) {
    return {
      email,
      reason: "complained",
      at: newestAt(complaints),
      evidence: SPAM_EVENT,
    };
  }

  const failures = events.filter((event) => event.eventName === DELIVERY_FAILED_EVENT);
  if (failures.length === 0) return null;

  const permanent = failures.filter((event) => failureIsPermanent(event.properties));
  if (permanent.length > 0) {
    return {
      email,
      reason: "bounced",
      at: newestAt(permanent),
      evidence: `${DELIVERY_FAILED_EVENT} (permanent)`,
    };
  }

  // NOT ENOUGH TO ACT ON, YET. One transient failure is a bad afternoon, not a
  // dead address, and the store's own escalation already picked the number.
  if (failures.length < DELIVERY_FAILURE_RUN_LIMIT) return null;

  return {
    email,
    reason: "soft_bounce_run",
    at: newestAt(failures),
    evidence: `${DELIVERY_FAILED_EVENT} x${failures.length}`,
  };
}

/** The latest `eventOccurredAt` in a non-empty list; the first value if none parse. */
function newestAt(events: OmnisendContactEvent[]): string {
  let bestAt = events[0].eventOccurredAt;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const ms = new Date(String(event.eventOccurredAt ?? "")).getTime();
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      bestAt = event.eventOccurredAt;
    }
  }
  return bestAt;
}

/**
 * Read the `POST /api/events/query` envelope, defensively.
 *
 *   { events: [ { contactID, eventName, eventOccurredAt, properties } ],
 *     paging: { cursors: { after }, hasMore } }
 *
 * Anything missing or mis-typed is dropped rather than guessed: a malformed
 * event that became a verdict would suppress a real customer.
 */
export function parseContactEvents(body: unknown): OmnisendContactEvent[] {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const list = Array.isArray(root?.events) ? root.events : [];
  const events: OmnisendContactEvent[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const contactID = text(record.contactID);
    const eventName = text(record.eventName);
    const eventOccurredAt = text(record.eventOccurredAt);
    if (!contactID || !eventName || !eventOccurredAt) continue;
    events.push({
      contactID,
      eventName,
      eventOccurredAt,
      properties: record.properties && typeof record.properties === "object"
        ? (record.properties as Record<string, unknown>)
        : null,
    });
  }
  return events;
}

/** The forward-only cursor from a page, or null when the page is the last. */
export function nextEventCursor(body: unknown): string | null {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const paging = root?.paging && typeof root.paging === "object" ? (root.paging as Record<string, unknown>) : null;
  const cursors = paging?.cursors && typeof paging.cursors === "object" ? (paging.cursors as Record<string, unknown>) : null;
  const after = text(cursors?.after);
  return after || null;
}

/**
 * A NEWER OPT-OUT IS NEVER REVERSED BY AN OLDER VERDICT.
 *
 * The events feed is historical and a run can lag; the suppression list already
 * holds whatever the store knows. So a verdict is only written when the address
 * is not already suppressed, or when what is already there is a reason this
 * verdict outranks AND the verdict is not older than the row it would replace.
 *
 * Ranking, weakest to strongest: nothing < soft_bounce_run < bounced <
 * complained. A complaint may overwrite a bounce because it is the stronger
 * statement about the same address; nothing ever downgrades one.
 */
const RANK: Record<string, number> = {
  soft_bounce_run: 1,
  unsubscribed: 1,
  account_preference: 1,
  bounced: 2,
  complained: 3,
};

export function verdictShouldBeWritten(input: {
  verdict: ProviderVerdict;
  existing: { reason: string | null; created_at: string | null } | null;
}): boolean {
  const { verdict, existing } = input;
  if (!existing) return true;

  const incoming = RANK[verdict.reason] ?? 0;
  const current = RANK[String(existing.reason ?? "")] ?? 0;
  // Never weaken, and never rewrite the same strength — that would only move
  // the date around and re-alert on a fact already recorded.
  if (incoming <= current) return false;

  // Stronger, but it must not be stale. An old complaint arriving after a
  // newer opt-out is still evidence, but it may not re-date the row backwards.
  const verdictMs = new Date(verdict.at).getTime();
  const existingMs = new Date(String(existing.created_at ?? "")).getTime();
  if (Number.isFinite(verdictMs) && Number.isFinite(existingMs) && verdictMs < existingMs) return false;

  return true;
}
