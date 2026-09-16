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

/** How many contacts a `GET /contacts` page carries, counted without reading any of them. */
export function countContactsOnPage(body: unknown): number {
  const root = asRecord(body);
  return Array.isArray(root?.contacts) ? root.contacts.length : 0;
}

/**
 * The order the push visits addresses in: the consented audience first, so
 * the people Omnisend may actually mail are the ones a capped run is sure to
 * refresh, then every buyer the store has no consent for (pushed as
 * nonSubscribed, for segments and lifetime value only). Sorted so two runs
 * over the same store walk the same list, and never an address twice.
 */
export function orderPushTargets(audience: Set<string>, buyers: Set<string>): string[] {
  const targets = [...audience].sort();
  for (const email of [...buyers].sort()) {
    if (!audience.has(email)) targets.push(email);
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Batches. Omnisend processes a batch in the background: POST /batches answers
// { batchID, totalCount } at once, and GET /batches/{batchID} later reports
// { status, totalCount, finishedCount, errorsCount, createdAt, startedAt,
// endedAt } with status pending → inProgress → finished | stopped. A 200 on
// the POST therefore proves nothing about the contacts; what happened to
// them is only known on the next run, which is why the ids are remembered.
// ---------------------------------------------------------------------------

export type OmnisendBatchStatus = "pending" | "inProgress" | "finished" | "stopped";

/** `POST /batches`, reduced to what is remembered. */
export type BatchSubmission = { id: string; totalCount: number | null };

/** `GET /batches/{batchID}`, reduced to what the report reads. */
export type OmnisendBatchRead = {
  id: string | null;
  status: OmnisendBatchStatus | null;
  totalCount: number | null;
  finishedCount: number | null;
  errorsCount: number | null;
  endedAt: string | null;
};

/** One remembered submission, as stored under omnisend_sync_state "batches". */
export type BatchRecord = {
  id: string;
  submittedAt: string;
  /** The last status a poll reported; "unknown" until the first poll answers. */
  status: OmnisendBatchStatus | "unknown";
  totalCount: number | null;
  finishedCount: number | null;
  errorsCount: number | null;
  checkedAt: string | null;
};

/** Enough to see a full nightly push (2000 contacts is 20 batches) with room for a bad week. */
export const MAX_BATCH_RECORDS = 50;

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function batchStatusOf(value: unknown): OmnisendBatchStatus | null {
  return value === "pending" || value === "inProgress" || value === "finished" || value === "stopped" ? value : null;
}

export function parseBatchSubmission(body: unknown): BatchSubmission | null {
  const root = asRecord(body);
  const id = textOrNull(root?.batchID);
  if (!id) return null;
  return { id, totalCount: countOrNull(root?.totalCount) };
}

export function parseBatchStatus(body: unknown): OmnisendBatchRead {
  const root = asRecord(body);
  return {
    id: textOrNull(root?.batchID),
    status: batchStatusOf(root?.status),
    totalCount: countOrNull(root?.totalCount),
    finishedCount: countOrNull(root?.finishedCount),
    errorsCount: countOrNull(root?.errorsCount),
    endedAt: textOrNull(root?.endedAt),
  };
}

function submittedAtOf(record: BatchRecord): number {
  const at = Date.parse(record.submittedAt);
  return Number.isFinite(at) ? at : 0;
}

/** The stored `{ batches: [...] }` value, read defensively: a junk entry is dropped, a junk field is null. */
export function parseBatchRecords(value: unknown): BatchRecord[] {
  const root = asRecord(value);
  const list = Array.isArray(root?.batches) ? root.batches : [];
  const records: BatchRecord[] = [];
  for (const raw of list) {
    const entry = asRecord(raw);
    const id = textOrNull(entry?.id);
    const submittedAt = textOrNull(entry?.submittedAt);
    if (!entry || !id || !submittedAt) continue;
    records.push({
      id,
      submittedAt,
      status: batchStatusOf(entry.status) ?? "unknown",
      totalCount: countOrNull(entry.totalCount),
      finishedCount: countOrNull(entry.finishedCount),
      errorsCount: countOrNull(entry.errorsCount),
      checkedAt: textOrNull(entry.checkedAt),
    });
  }
  return records;
}

/**
 * The remembered list after this run's submissions: known ids keep what a
 * poll already told us, new ids start as unknown, and only the newest
 * MAX_BATCH_RECORDS survive, ordered by submission instant.
 */
export function rememberBatches(existing: BatchRecord[], submitted: BatchSubmission[], submittedAt: string): BatchRecord[] {
  const byId = new Map<string, BatchRecord>();
  for (const record of existing) byId.set(record.id, record);
  for (const submission of submitted) {
    if (byId.has(submission.id)) continue;
    byId.set(submission.id, {
      id: submission.id,
      submittedAt,
      status: "unknown",
      totalCount: submission.totalCount,
      finishedCount: null,
      errorsCount: null,
      checkedAt: null,
    });
  }
  return [...byId.values()]
    .sort((a, b) => submittedAtOf(a) - submittedAtOf(b))
    .slice(-MAX_BATCH_RECORDS);
}

export function batchUnfinished(record: BatchRecord): boolean {
  return record.status !== "finished" && record.status !== "stopped";
}

/** A poll's answer folded into the record; a field the poll did not carry keeps its last value. */
export function applyBatchRead(record: BatchRecord, read: OmnisendBatchRead, checkedAt: string): BatchRecord {
  return {
    ...record,
    status: read.status ?? record.status,
    totalCount: read.totalCount ?? record.totalCount,
    finishedCount: read.finishedCount ?? record.finishedCount,
    errorsCount: read.errorsCount ?? record.errorsCount,
    checkedAt,
  };
}

function countText(value: number | null): string {
  return value === null ? "?" : String(value);
}

/**
 * What the report cannot yet call resolved, one line per batch. Ids and
 * counts only: a batch note never names an address.
 */
export function batchNotes(records: BatchRecord[]): string[] {
  const notes: string[] = [];
  for (const record of records) {
    if (record.status === "finished") {
      if ((record.errorsCount ?? 0) > 0) {
        notes.push(`batch ${record.id} finished with ${countText(record.errorsCount)} item error(s) of ${countText(record.totalCount)}`);
      }
    } else if (record.status === "stopped") {
      notes.push(
        `batch ${record.id} stopped after ${countText(record.finishedCount)} of ${countText(record.totalCount)} items, `
        + `${countText(record.errorsCount)} item error(s)`,
      );
    } else {
      notes.push(`batch ${record.id} not finished (${record.status})`);
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Snapshot labels. A label names one consent snapshot; the operator compares
// two of them. Short and plain so it can sit in a SQL literal and a log line.
// ---------------------------------------------------------------------------

const SNAPSHOT_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** `pre-migration-<UTC date>`: the label the admin route uses when none is given. */
export function defaultSnapshotLabel(nowMs = Date.now()): string {
  return `pre-migration-${new Date(nowMs).toISOString().slice(0, 10)}`;
}

export function isValidSnapshotLabel(label: string): boolean {
  return SNAPSHOT_LABEL.test(label);
}

// ---------------------------------------------------------------------------
// The reconciliation report. Every field is a count or a batch id; no
// address, phone number, token or code is ever carried here, because the
// report is returned to the admin browser and written to the audit log.
// ---------------------------------------------------------------------------

export type OmnisendReconcileReport = {
  /** What the store says, at the start of the run. */
  store: {
    /** The consented audience: both consent stores, minus suppressions and non-mailable sinks. */
    consented: number;
    /** Paid product buyers outside the consented audience; pushed as nonSubscribed. */
    buyersWithoutConsent: number;
    /** Rows on email_suppressions. */
    suppressed: number;
    /** Contacts walked this run whose account carries SMS consent with a number. */
    smsConsented: number;
    /** Buyer addresses dropped because they are provider sinks or otherwise non-mailable. */
    nonMailable: number;
  };
  /** Omnisend's own contact count, paged at 250; `capped` when the page ceiling stopped the count. */
  omnisend: { contactsBefore: number; contactsAfter: number; capped: boolean };
  /** What went out (or, in a dry run, what would have). */
  push: { submitted: number; batches: number; batchIds: string[]; failedBatches: number };
  /** What Omnisend changed in the store. */
  writeBack: { suppressed: number; smsOptOuts: number; formSubscribers: number };
  /** Everything the run could not settle, one line each, counts and ids only. */
  unresolved: string[];
};

export function emptyReconcileReport(): OmnisendReconcileReport {
  return {
    store: { consented: 0, buyersWithoutConsent: 0, suppressed: 0, smsConsented: 0, nonMailable: 0 },
    omnisend: { contactsBefore: 0, contactsAfter: 0, capped: false },
    push: { submitted: 0, batches: 0, batchIds: [], failedBatches: 0 },
    writeBack: { suppressed: 0, smsOptOuts: 0, formSubscribers: 0 },
    unresolved: [],
  };
}
