import "server-only";

import { findUserByEmail } from "@/lib/auth-confirmation-email";
import { RECOVERY_GIFT_OFFER_KEY } from "@/lib/cart-recovery-offers";
import { loadConsentedAudience, resolveAccountEmails } from "@/lib/email/audience";
import { isNonMailableAddress } from "@/lib/email/non-mailable";
import { PAID_ORDER_STATUSES, isProductPurchaseOrder } from "@/lib/ledger";
import { omnisendActive, omnisendRequest } from "@/lib/marketing/omnisend/client";
import {
  ensureContactCode,
  findLiveContactCode,
  type ContactCode,
  type ContactCodeKind,
} from "@/lib/marketing/omnisend/codes";
import { buildContactPayload, type ContactFacts } from "@/lib/marketing/omnisend/contact-payload";
import { collectContactFacts } from "@/lib/marketing/omnisend/contacts";
import { onMarketingOptIn } from "@/lib/marketing/omnisend/hooks";
import { liveWelcomeGift } from "@/lib/marketing/omnisend/welcome-gift";
import { OMNISEND_LINK_TTL_MS, signOmnisendLink } from "@/lib/marketing/omnisend/link-token";
import {
  readBatchRecords,
  recordMigrationCutoff,
  writeBatchRecords,
} from "@/lib/marketing/omnisend/migration-state";
import {
  applyBatchRead,
  batchNotes,
  batchUnfinished,
  countContactsOnPage,
  emptyReconcileReport,
  isLaterInstant,
  latestUpdatedAt,
  mergeBatchRecords,
  orderPushTargets,
  parseBatchStatus,
  parseBatchSubmission,
  parseOmnisendContacts,
  parseOmnisendPaging,
  planWriteBack,
  rememberBatches,
  stampFor,
  writeBackStamps,
  type BatchRecord,
  type BatchSubmission,
  type OmnisendContactRead,
  type OmnisendReconcileReport,
} from "@/lib/marketing/omnisend/reconcile-plan";
import { grantWelcomeOfferForConsent } from "@/lib/offers/welcome-offer";
import { mirrorSmsConsent, recordSmsOptOut } from "@/lib/sms-consent";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The nightly contacts reconcile (spec §3.2 write-back, §3.3 token refresh,
 * §3.4 win-back codes). Two passes, in this order:
 *
 *   1. WRITE-BACK. Page the contacts Omnisend says changed since the last
 *      run's watermark and mirror what happened THERE into the store: an
 *      Omnisend unsubscribe becomes a suppression, an SMS opt-out becomes the
 *      account's opt-out stamp, a form sign-up becomes a guest subscriber
 *      row. The decisions are made by planWriteBack (pure, tested); this file
 *      only loads, fetches and applies. Runs first so a person who
 *      unsubscribed inside Omnisend is suppressed BEFORE the push below
 *      re-reads their consent, and therefore goes back as unsubscribed.
 *
 *   2. PUSH. Every consented address, then every buyer the store knows but
 *      has no consent for, is re-collected from the store's own records and
 *      sent as a contact batch: a fresh 30-day link token, the live codes,
 *      and — for a subscribed buyer whose last paid order is old enough —
 *      a newly minted win-back code. Batches of 100 through `POST /batches`,
 *      never one POST per contact, so a full pass over the audience costs
 *      audience/100 requests rather than audience requests.
 *
 * Every write is idempotent and every step tolerates its own failure. The
 * ONE thing this job may not do is widen consent, and that is enforced by
 * planWriteBack (a suppressed address is never re-subscribed), by
 * applyFormSubscriber (a site opt-out is re-opened only by a form subscribe
 * Omnisend dates after it) and by collectContactFacts (an unreadable
 * suppression store yields no facts, so the address is skipped rather than
 * pushed on a guess). A run that cannot read the suppression list skips the
 * write-back entirely rather than guessing.
 *
 * The write-back stamps the store with WHEN THE PERSON ACTED — Omnisend's
 * statusChangedAt, never later than now — not with this run's time
 * (stampFor, pure). A refused write of any of the three kinds holds the
 * watermark so the same contacts are re-read tomorrow.
 *
 * ACCOUNTABILITY (docs/omnisend/MIGRATION.md). Every run also returns a
 * report that accounts for every record as counts — what the store holds,
 * what Omnisend holds before and after, what went out in which batches,
 * what came back, and what could not be settled — and never an address.
 * Omnisend processes a batch in the background, so the ids it returns are
 * remembered in omnisend_sync_state and polled on the next run; a batch
 * that stopped or finished with item errors is reported there rather than
 * lost. The first live push records the migration cutoff, once.
 *
 * Never throws: it runs from cron and from an admin button, and neither may
 * fail over a marketing sync. Whatever went wrong is in the log under
 * `[omnisend/reconcile]`, in `skipped` and in `report.unresolved`.
 */

const LOG = "[omnisend/reconcile]";
/** omnisend_sync_state row holding `{ updatedAtFrom }`. */
const SYNC_STATE_KEY = "contacts_reconcile";
/** Omnisend's ceiling for `GET /contacts?limit=`. */
const CONTACTS_PAGE_SIZE = 250;
/** 10,000 changed contacts a night is far more than this account will see. */
const MAX_CONTACT_PAGES = 40;
/** Omnisend's ceiling for items in one batch. */
const BATCH_SIZE = 100;
const DEFAULT_PUSH_LIMIT = 2000;
/** Contacts collected from the store at once while a batch is being built. */
const FACTS_CONCURRENCY = 8;
/**
 * The push stops starting new batches past this, so a run inside a 60-second
 * function ends with a log line and a result rather than a platform timeout.
 * Whatever it did not reach, tomorrow's run reaches first.
 */
const DEFAULT_BUDGET_MS = 45_000;
/**
 * Fifty days, not the sixty the win-back flow waits for: the code is minted
 * ahead of the flow so it is already on the contact when the flow fires, and
 * its fourteen-day life comfortably spans the gap.
 */
const WINBACK_AFTER_MS = 50 * 24 * 60 * 60 * 1000;
/** Same bound the audience loader uses for its own paged reads. */
const MAX_STORE_ROWS = 500_000;
const CODE_KINDS: ContactCodeKind[] = ["welcome", "winback", "recovery"];

export type OmnisendReconcileOptions = {
  /** Plan and report, write nothing anywhere (reads Omnisend and the store as usual). */
  dryRun?: boolean;
  /** Cap on contacts pushed this run. */
  limit?: number;
  /** Wall-clock budget for the push, in milliseconds. */
  budgetMs?: number;
  /**
   * `false` runs the write-back alone: the batch poll, the changed-contacts
   * read and the mirrors (suppressions, form sign-ups with their welcome
   * offer, SMS opt-outs), and none of the full audience push. The write-back
   * is incremental by watermark and cheap, so the sweep runs it every tick;
   * the push walks every consented address and runs on its own daily cadence
   * (sweeps.ts). Omitted or `true`: both, as before.
   */
  push?: boolean;
};

export type OmnisendReconcileResult = {
  pushed: number;
  suppressed: number;
  smsOptOuts: number;
  /** sms_subscribers rows mirrored from a pop-up consent this run. */
  smsSubscribers: number;
  formSubscribers: number;
  winbackCodes: number;
  dryRun: boolean;
  skipped: string | null;
  /** Counts and batch ids only; see reconcile-plan.ts. */
  report: OmnisendReconcileReport;
};

function normalizeEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

async function readWatermark(): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .select("value")
      .eq("key", SYNC_STATE_KEY)
      .maybeSingle();
    if (error) {
      // Unreadable reads as "no watermark": the run pages more than it needs
      // to, which is the direction that cannot miss an unsubscribe.
      console.error(LOG, "watermark read refused", error.message);
      return null;
    }
    const value = (data as { value?: unknown } | null)?.value;
    const from = value && typeof value === "object" ? (value as { updatedAtFrom?: unknown }).updatedAtFrom : null;
    return typeof from === "string" && from.trim() ? from : null;
  } catch (error) {
    console.error(LOG, "watermark read failed", error);
    return null;
  }
}

async function writeWatermark(updatedAtFrom: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .upsert({ key: SYNC_STATE_KEY, value: { updatedAtFrom }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) console.error(LOG, "watermark write refused", error.message);
  } catch (error) {
    console.error(LOG, "watermark write failed", error);
  }
}

// ---------------------------------------------------------------------------
// Write-back: Omnisend → store
// ---------------------------------------------------------------------------

/**
 * Every contact changed since the watermark, following `paging.cursors.after`.
 * `complete` is false when a page was refused or the page ceiling was hit, and
 * then the watermark is NOT advanced: the next run re-reads from the same
 * point rather than skipping whatever the unread pages held.
 */
async function fetchChangedContacts(watermark: string | null): Promise<{ contacts: OmnisendContactRead[]; complete: boolean }> {
  const contacts: OmnisendContactRead[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_CONTACT_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(CONTACTS_PAGE_SIZE) });
    if (watermark) query.set("updatedAtFrom", watermark);
    if (after) query.set("after", after);
    const result = await omnisendRequest<unknown>({ method: "GET", path: `/contacts?${query.toString()}` });
    if (!result.ok) {
      console.error(LOG, "contacts page refused", { page, status: result.status, error: result.error });
      return { contacts, complete: false };
    }
    contacts.push(...parseOmnisendContacts(result.body));
    const paging = parseOmnisendPaging(result.body);
    if (!paging.hasMore || !paging.after) return { contacts, complete: true };
    after = paging.after;
  }
  console.warn(LOG, "contacts paging stopped at the page ceiling", { pages: MAX_CONTACT_PAGES, contacts: contacts.length });
  return { contacts, complete: false };
}

/**
 * Every suppressed address with the reason recorded against it, or null when
 * the list could not be read IN FULL: a short suppression list is not a
 * suppression list. The consent snapshot records the reason; the write-back
 * only needs the keys.
 */
export async function loadSuppressionReasons(): Promise<Map<string, string | null> | null> {
  try {
    const { rows, truncated } = await readAllRowsBounded<{ email: string; reason: string | null }>(
      (from, to) => supabaseAdmin
        .from("email_suppressions")
        .select("email, reason")
        .order("email", { ascending: true })
        .range(from, to),
      { maxRows: MAX_STORE_ROWS, label: "omnisend suppression read" },
    );
    if (truncated) {
      console.error(LOG, "suppression list truncated; write-back skipped");
      return null;
    }
    const suppressed = new Map<string, string | null>();
    for (const row of rows) {
      const email = normalizeEmail(row.email);
      if (email) suppressed.set(email, typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null);
    }
    return suppressed;
  } catch (error) {
    console.error(LOG, "suppression read failed", error);
    return null;
  }
}

/** The suppressed addresses alone, with the same all-or-nothing contract. */
async function loadSuppressed(): Promise<Set<string> | null> {
  const reasons = await loadSuppressionReasons();
  return reasons ? new Set(reasons.keys()) : null;
}

/** The union of both consent stores minus suppressions, or null when it could not be read in full. */
export async function loadAudience(): Promise<Set<string> | null> {
  try {
    return (await loadConsentedAudience()).all;
  } catch (error) {
    console.error(LOG, "audience read failed", error);
    return null;
  }
}

/**
 * Everyone who WITHDREW consent without landing on the suppression list: a
 * guest whose marketing_subscribers.unsubscribed_at is set, and an account
 * whose marketing_emails box is unticked, resolved to addresses the same
 * way the audience loader resolves the ticked ones. They are in neither the
 * audience nor the suppression list, and they are exactly the people a
 * re-subscribe would harm, so the consent snapshot has to hold them. Read
 * in full or not at all (null), like the suppression list: a short list is
 * not evidence. Never used to push anything.
 */
export async function loadWithdrawnConsent(): Promise<Set<string> | null> {
  try {
    const { rows: guests, truncated: guestsTruncated } = await readAllRowsBounded<{ email: string }>(
      (from, to) => supabaseAdmin
        .from("marketing_subscribers")
        .select("email")
        .not("unsubscribed_at", "is", null)
        .order("email", { ascending: true })
        .range(from, to),
      { maxRows: MAX_STORE_ROWS, label: "omnisend guest opt-out read" },
    );
    const { rows: accounts, truncated: accountsTruncated } = await readAllRowsBounded<{ user_id: string }>(
      (from, to) => supabaseAdmin
        .from("customer_preferences")
        .select("user_id")
        .eq("marketing_emails", false)
        .order("user_id", { ascending: true })
        .range(from, to),
      { maxRows: MAX_STORE_ROWS, label: "omnisend account opt-out read" },
    );
    if (guestsTruncated || accountsTruncated) {
      console.error(LOG, "withdrawn consent read truncated", { guestsTruncated, accountsTruncated });
      return null;
    }
    const withdrawn = new Set<string>();
    for (const row of guests) {
      const email = normalizeEmail(row.email);
      if (email) withdrawn.add(email);
    }
    const userIds = new Set(accounts.map((row) => String(row.user_id ?? "")).filter(Boolean));
    for (const email of await resolveAccountEmails(userIds)) {
      const address = normalizeEmail(email);
      if (address) withdrawn.add(address);
    }
    return withdrawn;
  } catch (error) {
    console.error(LOG, "withdrawn consent read failed", error);
    return null;
  }
}

/** What one write-back write did: written, nothing to write, or refused (holds the watermark). */
type WriteBackOutcome = "applied" | "nothing" | "failed";

/**
 * Mirrors suppress() in src/app/api/unsubscribe/route.ts, including the
 * retry without `source` for a database that has not run
 * email-lifecycle-2026-09-04.sql, and the best-effort mirror onto the
 * account's marketing toggle so /account/settings agrees with the list.
 * `changedAt` is Omnisend's statusChangedAt — when the person unsubscribed —
 * and dates the suppression; `now` dates the row change.
 */
async function applySuppression(email: string, changedAt: string | null, now: string): Promise<boolean> {
  try {
    const at = stampFor(changedAt, now);
    const row = { email, reason: "unsubscribed", created_at: at };
    let { error } = await supabaseAdmin
      .from("email_suppressions")
      .upsert({ ...row, source: "omnisend" }, { onConflict: "email" });
    if (error && /source/i.test(String(error.message ?? ""))) {
      ({ error } = await supabaseAdmin
        .from("email_suppressions")
        .upsert(row, { onConflict: "email" }));
    }
    if (error) {
      console.error(LOG, "suppression write refused", error.message);
      return false;
    }
    try {
      const user = await findUserByEmail(email);
      if (user?.id) {
        await supabaseAdmin
          .from("customer_preferences")
          .upsert({ user_id: user.id, marketing_emails: false, updated_at: now }, { onConflict: "user_id" });
      }
    } catch {
      // Non-fatal: email_suppressions above is the authoritative gate.
    }
    return true;
  } catch (error) {
    console.error(LOG, "suppression write failed", error);
    return false;
  }
}

/**
 * The same row recordMarketingOptIn writes, with the source that names where
 * it came from, dated when the person subscribed.
 *
 * NEVER WIDENED, EVEN HERE. A guest who unsubscribed on the site is absent
 * from the audience, so the planner offers them as a new subscriber whenever
 * Omnisend still says subscribed — with a statusChangedAt that may predate
 * the site's own opt-out by months. Only a subscribe Omnisend dates AFTER
 * unsubscribed_at is a real re-subscribe through the form; anything else,
 * and a subscribe with no date at all, leaves the closed record closed. An
 * unreadable row writes nothing, because it cannot be checked.
 */
async function applyFormSubscriber(email: string, changedAt: string | null, now: string): Promise<WriteBackOutcome> {
  try {
    const at = stampFor(changedAt, now);
    const { data, error } = await supabaseAdmin
      .from("marketing_subscribers")
      .select("unsubscribed_at")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      console.error(LOG, "form subscriber read refused", error.message);
      return "failed";
    }
    const existing = data as { unsubscribed_at?: string | null } | null;
    if (existing?.unsubscribed_at && !isLaterInstant(changedAt, existing.unsubscribed_at)) return "nothing";
    const { error: writeError } = await supabaseAdmin
      .from("marketing_subscribers")
      .upsert({ email, source: "omnisend-form", opted_in_at: at, unsubscribed_at: null }, { onConflict: "email" });
    if (writeError) {
      console.error(LOG, "form subscriber write refused", writeError.message);
      return "failed";
    }
    return "applied";
  } catch (error) {
    console.error(LOG, "form subscriber write failed", error);
    return "failed";
  }
}

/**
 * SMS consent lives on the address's own row (sms_subscribers, written by the
 * sign-up page and the checkout) and, for an account holder, on the account.
 * Both are stamped: a STOP Omnisend reports has to close whichever row a
 * later sync would otherwise read as consent. A row that already carries an
 * opt-out keeps its original timestamp: the stamp is when the person said
 * stop — Omnisend's statusChangedAt when it has one — not when this job last
 * noticed. A refused read or write on either row is "failed", which holds
 * the watermark; "nothing" is not a failure.
 */
async function applySmsOptOut(email: string, changedAt: string | null, now: string): Promise<WriteBackOutcome> {
  try {
    const at = stampFor(changedAt, now);
    const address = await recordSmsOptOut(email, at);
    const user = await findUserByEmail(email);
    if (!user?.id) return address;
    const { data, error } = await supabaseAdmin
      .from("customer_preferences")
      .select("sms_opted_out_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      console.error(LOG, "sms preference read refused", error.message);
      return "failed";
    }
    if ((data as { sms_opted_out_at?: string | null } | null)?.sms_opted_out_at) return address;
    const { error: writeError } = await supabaseAdmin
      .from("customer_preferences")
      .upsert({ user_id: user.id, sms_marketing: false, sms_opted_out_at: at, updated_at: now }, { onConflict: "user_id" });
    if (writeError) {
      console.error(LOG, "sms opt-out write refused", writeError.message);
      return "failed";
    }
    // The account stamp landed; a refused address stamp still holds the watermark.
    return address === "failed" ? "failed" : "applied";
  } catch (error) {
    console.error(LOG, "sms opt-out write failed", error);
    return "failed";
  }
}

type WriteBackCounts = {
  suppressed: number;
  smsOptOuts: number;
  /** sms_subscribers rows mirrored from a pop-up consent this run. */
  smsSubscribers: number;
  formSubscribers: number;
  /** Rows on the suppression list, or null when it could not be read in full. */
  suppressionRows: number | null;
  /** What the pass could not settle, for report.unresolved. Counts only. */
  notes: string[];
};

async function runWriteBack(input: { dryRun: boolean; audience: Set<string> | null; now: string }): Promise<WriteBackCounts> {
  const counts: WriteBackCounts = { suppressed: 0, smsOptOuts: 0, smsSubscribers: 0, formSubscribers: 0, suppressionRows: null, notes: [] };

  const suppressed = await loadSuppressed();
  if (!suppressed) {
    console.error(LOG, "write-back skipped: the suppression list could not be read");
    counts.notes.push("write-back skipped: suppression list unreadable");
    return counts;
  }
  counts.suppressionRows = suppressed.size;

  const watermark = await readWatermark();
  const { contacts, complete } = await fetchChangedContacts(watermark);

  // The SMS opt-out set is deliberately empty: the account rows that carry a
  // stamp are keyed by user id, and resolving those to addresses costs a
  // directory walk. applySmsOptOut reads the one row it is about to write
  // instead, which is the same check for the handful of changed contacts.
  const plan = planWriteBack(contacts, { suppressed, subscribers: input.audience ?? new Set(), smsOptedOut: new Set() });
  // Without the audience, "absent from both consent stores" cannot be told
  // from "present", so no subscriber row is written on a guess.
  const newSubscribers = input.audience ? plan.newSubscribers : [];
  if (!input.audience && plan.newSubscribers.length > 0) {
    console.warn(LOG, "form sign-ups not mirrored: the consented audience could not be read", { count: plan.newSubscribers.length });
    counts.notes.push(`${plan.newSubscribers.length} form sign-up(s) not mirrored: audience unreadable`);
  }
  if (!complete) counts.notes.push("write-back read incomplete: a contacts page was refused or the page ceiling was hit");

  console.info(LOG, "write-back plan", {
    watermark,
    contacts: contacts.length,
    complete,
    suppress: plan.suppress.length,
    smsOptOut: plan.smsOptOut.length,
    smsSubscribers: plan.smsSubscribers.length,
    newSubscribers: newSubscribers.length,
    dryRun: input.dryRun,
  });

  if (input.dryRun) {
    return {
      ...counts,
      suppressed: plan.suppress.length,
      smsOptOuts: plan.smsOptOut.length,
      formSubscribers: newSubscribers.length,
    };
  }

  // Each store row is dated when the person acted, as Omnisend recorded it.
  const stamps = writeBackStamps(contacts);
  let failures = 0;
  for (const email of plan.suppress) {
    if (await applySuppression(email, stamps.get(email)?.email ?? null, input.now)) counts.suppressed += 1;
    else failures += 1;
  }
  for (const email of newSubscribers) {
    const form = await applyFormSubscriber(email, stamps.get(email)?.email ?? null, input.now);
    if (form === "applied") {
      counts.formSubscribers += 1;
      // A FORM SIGN-UP IS A FIRST SUBSCRIBE THE SITE NEVER SAW. The site's
      // own sign-ups mint the welcome offer on the request path
      // (recordMarketingOptIn → onMarketingOptIn); a pop-up sign-up reaches
      // the store only here, so the same hook runs here, once, for the
      // address just mirrored: it mints the code and the gift for a never-
      // bought address and pushes the contact with both. Never for a buyer,
      // never twice (a live code is re-offered, a live gift left alone), and
      // never on a dry run. The full push later this run reads the live
      // codes and leaves the gift link as this push set it.
      await onMarketingOptIn(email, "omnisend-form");
    } else if (form === "failed") failures += 1;
  }
  // A POP-UP SMS CONSENT THE STORE HAS NEVER SEEN. Mirrored once (the mirror
  // leaves an existing row alone, so consented_at stays the date the person
  // actually agreed), and a first mirror earns the same welcome code every
  // other SMS sign-up earns — one offer, one code per address, whichever
  // screen took the tick. Never for a buyer, never a second code, and never
  // on a dry run.
  for (const subscriber of plan.smsSubscribers) {
    const mirrored = await mirrorSmsConsent({
      email: subscriber.email,
      phone: subscriber.phone,
      source: "omnisend-form",
      at: subscriber.at ?? input.now,
    });
    if (mirrored === "applied") {
      counts.smsSubscribers += 1;
      await grantWelcomeOfferForConsent(subscriber.email);
    } else if (mirrored === "failed") failures += 1;
  }
  for (const email of plan.smsOptOut) {
    const sms = await applySmsOptOut(email, stamps.get(email)?.sms ?? null, input.now);
    if (sms === "applied") counts.smsOptOuts += 1;
    else if (sms === "failed") failures += 1;
  }

  // Advance only past pages that were read in full and applied without a
  // refusal; anything else is re-read tomorrow, which costs a page and
  // cannot lose an unsubscribe.
  const latest = latestUpdatedAt(contacts);
  if (complete && failures === 0 && latest) await writeWatermark(latest);
  else if (!complete || failures > 0) console.warn(LOG, "watermark held", { complete, failures });
  if (failures > 0) counts.notes.push(`${failures} write-back write(s) refused; watermark held`);

  return counts;
}

// ---------------------------------------------------------------------------
// Push: store → Omnisend
// ---------------------------------------------------------------------------

type OrderRow = { customer_email: string | null; order_type: string | null; replacement_of: string | null };

/**
 * Everyone with a paid product order, whether or not they consented to
 * marketing, and how many buyer addresses were dropped as non-mailable
 * (provider sinks and the like) so the report can account for them.
 */
export async function loadPaidBuyers(): Promise<{ buyers: Set<string>; nonMailable: number }> {
  const buyers = new Set<string>();
  const dropped = new Set<string>();
  try {
    const { rows, truncated } = await readAllRowsBounded<OrderRow>(
      (from, to) => supabaseAdmin
        .from("orders")
        .select("customer_email, order_type, replacement_of")
        .in("payment_status", Array.from(PAID_ORDER_STATUSES))
        .order("id", { ascending: true })
        .range(from, to),
      { maxRows: MAX_STORE_ROWS, label: "omnisend buyer read" },
    );
    if (truncated) console.warn(LOG, "buyer read truncated; later buyers are pushed on a future run");
    for (const row of rows) {
      if (!isProductPurchaseOrder(row)) continue;
      const email = normalizeEmail(row.customer_email);
      if (!email) continue;
      if (isNonMailableAddress(email)) dropped.add(email);
      else buyers.add(email);
    }
  } catch (error) {
    console.error(LOG, "buyer read failed", error);
  }
  return { buyers, nonMailable: dropped.size };
}

/**
 * A subscribed buyer whose last paid order is old enough for the win-back
 * flow. Subscribed only: a nonSubscribed contact receives no marketing
 * (the automations' sending thresholds), so a code minted for one is a
 * coupon nobody can see.
 */
function lapsedBuyer(facts: ContactFacts, nowMs: number): boolean {
  if (facts.orders <= 0 || !facts.lastOrderAt) return false;
  if (facts.emailConsent.status !== "subscribed") return false;
  const last = Date.parse(facts.lastOrderAt);
  return Number.isFinite(last) && nowMs - last >= WINBACK_AFTER_MS;
}

async function gatherCodes(
  email: string,
  facts: ContactFacts,
  nowMs: number,
  dryRun: boolean,
): Promise<{ codes: Partial<Record<ContactCodeKind, ContactCode>>; mintedWinback: boolean }> {
  const [welcome, winback, recovery] = await Promise.all(CODE_KINDS.map((kind) => findLiveContactCode(kind, email)));
  const codes: Partial<Record<ContactCodeKind, ContactCode>> = {};
  if (welcome) codes.welcome = welcome;
  if (recovery) codes.recovery = recovery;
  let mintedWinback = false;
  if (winback) {
    codes.winback = winback;
  } else if (lapsedBuyer(facts, nowMs)) {
    if (dryRun) {
      mintedWinback = true;
    } else {
      const minted = await ensureContactCode("winback", email);
      if (minted) {
        codes.winback = minted;
        mintedWinback = true;
      }
    }
  }
  return { codes, mintedWinback };
}

/**
 * What the push says about the recovery gift the cart-offer sweep may have
 * set on this contact. The sweep's claim link carries a bearer token that
 * customer-offers.ts never persists (only its hash), so the object cannot
 * be rebuilt here. What CAN be told honestly is whether the gift is still
 * good: a live, unredeemed, unrevoked, unexpired row leaves the five
 * properties as the sweep set them (undefined: omitted from the merge), and
 * no such row clears them (null), so an expired gift is cleared nightly and
 * the gift template stops. An unreadable table preserves: nothing is
 * cleared on a guess.
 */
async function liveRecoveryGift(email: string, nowMs: number): Promise<null | undefined> {
  try {
    const { data, error } = await supabaseAdmin
      .from("customer_offers")
      .select("id")
      .eq("offer_key", RECOVERY_GIFT_OFFER_KEY)
      .eq("email", email)
      .is("revoked_at", null)
      .is("redeemed_at", null)
      .gt("expires_at", new Date(nowMs).toISOString())
      .limit(1);
    if (error) {
      console.error(LOG, "recovery gift read refused; gift properties left as they are", error.message);
      return undefined;
    }
    return Array.isArray(data) && data.length > 0 ? undefined : null;
  } catch (error) {
    console.error(LOG, "recovery gift read failed; gift properties left as they are", error);
    return undefined;
  }
}

type BuiltContact = { payload: Record<string, unknown>; mintedWinback: boolean; smsSubscribed: boolean };

async function buildContactItem(email: string, dryRun: boolean): Promise<BuiltContact | null> {
  try {
    const facts = await collectContactFacts(email);
    if (!facts) return null;
    const nowMs = Date.now();
    const token = await signOmnisendLink(email, nowMs);
    const link = token ? { token, endsAt: new Date(nowMs + OMNISEND_LINK_TTL_MS).toISOString() } : null;
    const { codes, mintedWinback } = await gatherCodes(email, facts, nowMs, dryRun);
    const [recoveryGift, welcomeGift] = await Promise.all([liveRecoveryGift(email, nowMs), liveWelcomeGift(email, nowMs)]);
    return {
      payload: buildContactPayload({ ...facts, link, codes, recoveryGift, welcomeGift }),
      mintedWinback,
      smsSubscribed: facts.smsConsent?.status === "subscribed" && Boolean(String(facts.phone ?? "").trim()),
    };
  } catch (error) {
    // The address is the contact's identity and stays out of the log stream;
    // the domain is enough to tell a broken import from a broken address.
    console.error(LOG, "contact build failed", { domain: email.slice(email.indexOf("@") + 1), error });
    return null;
  }
}

type PushOutcome = {
  /** Contacts submitted (or, in a dry run, that would have been). */
  pushed: number;
  winbackCodes: number;
  /** Batches accepted (or, in a dry run, that would have been posted). */
  batches: number;
  failedBatches: number;
  batchIds: string[];
  submissions: BatchSubmission[];
  /** Contacts walked whose account carries SMS consent with a number. */
  smsConsented: number;
  buyersWithoutConsent: number;
  nonMailable: number;
  /** Targets past the push limit, left for the next run. */
  capped: number;
  /** Addresses whose store record could not be read (collectContactFacts null), so not pushed. */
  unreadable: number;
  stopped: string | null;
};

async function runPush(input: { dryRun: boolean; audience: Set<string>; limit: number; deadline: number }): Promise<PushOutcome> {
  const outcome: PushOutcome = {
    pushed: 0,
    winbackCodes: 0,
    batches: 0,
    failedBatches: 0,
    batchIds: [],
    submissions: [],
    smsConsented: 0,
    buyersWithoutConsent: 0,
    nonMailable: 0,
    capped: 0,
    unreadable: 0,
    stopped: null,
  };

  // Consented first, so the people Omnisend may actually mail are the ones a
  // capped run is sure to refresh; buyers without consent go afterwards as
  // nonSubscribed, for segments and lifetime value only.
  const { buyers, nonMailable } = await loadPaidBuyers();
  outcome.nonMailable = nonMailable;
  const targets = orderPushTargets(input.audience, buyers);
  outcome.buyersWithoutConsent = targets.length - input.audience.size;
  if (targets.length > input.limit) {
    outcome.capped = targets.length - input.limit;
    console.warn(LOG, "push capped", { targets: targets.length, limit: input.limit });
  }
  const list = targets.slice(0, input.limit);

  for (const [index, batch] of chunk(list, BATCH_SIZE).entries()) {
    if (Date.now() > input.deadline) {
      outcome.stopped = `time budget reached after ${outcome.pushed} contacts`;
      console.warn(LOG, outcome.stopped, { remaining: list.length - index * BATCH_SIZE });
      break;
    }
    const built = await mapWithConcurrency(batch, FACTS_CONCURRENCY, (email) => buildContactItem(email, input.dryRun));
    const items: Array<Record<string, unknown>> = [];
    for (const entry of built) {
      if (!entry) {
        outcome.unreadable += 1;
        continue;
      }
      items.push(entry.payload);
      if (entry.mintedWinback) outcome.winbackCodes += 1;
      if (entry.smsSubscribed) outcome.smsConsented += 1;
    }
    if (items.length === 0) continue;
    if (input.dryRun) {
      outcome.pushed += items.length;
      outcome.batches += 1;
      continue;
    }
    const result = await omnisendRequest({
      method: "POST",
      path: "/batches",
      body: { method: "POST", endpoint: "contacts", items },
    });
    if (!result.ok) {
      outcome.failedBatches += 1;
      console.error(LOG, "contact batch refused", { batch: index, size: items.length, status: result.status, error: result.error });
      continue;
    }
    outcome.pushed += items.length;
    outcome.batches += 1;
    // Omnisend answers { batchID, totalCount } and processes the batch in the
    // background; the id is what lets the next run find out how it went.
    const submission = parseBatchSubmission(result.body);
    if (submission) {
      outcome.batchIds.push(submission.id);
      outcome.submissions.push(submission);
    } else {
      console.warn(LOG, "contact batch accepted without a batch id", { batch: index, size: items.length });
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Accountability: Omnisend's contact count and the fate of earlier batches
// ---------------------------------------------------------------------------

/**
 * How many contacts Omnisend holds, by paging GET /contacts at the page
 * ceiling. Bounded by MAX_CONTACT_PAGES (10,000 contacts), past which the
 * count is reported as capped rather than wrong. The report reads it before
 * anything is changed and again after a live push, though a batch that is
 * still processing is not yet in the second number: the next run's "before"
 * is the settled one.
 */
async function countOmnisendContacts(): Promise<{ count: number; capped: boolean; complete: boolean }> {
  let count = 0;
  let after: string | null = null;
  for (let page = 0; page < MAX_CONTACT_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(CONTACTS_PAGE_SIZE) });
    if (after) query.set("after", after);
    const result = await omnisendRequest<unknown>({ method: "GET", path: `/contacts?${query.toString()}` });
    if (!result.ok) {
      console.error(LOG, "contact count page refused", { page, status: result.status, error: result.error });
      return { count, capped: false, complete: false };
    }
    count += countContactsOnPage(result.body);
    const paging = parseOmnisendPaging(result.body);
    if (!paging.hasMore || !paging.after) return { count, capped: false, complete: true };
    after = paging.after;
  }
  console.warn(LOG, "contact count stopped at the page ceiling", { pages: MAX_CONTACT_PAGES, count });
  return { count, capped: true, complete: false };
}

/**
 * Ask Omnisend how the batches remembered from earlier runs went, and keep
 * the answers. Only the unfinished ones are asked about, one GET each with
 * no retry, and a transport failure stops the round rather than spending the
 * budget on a host that is not answering. A dry run polls but records
 * nothing, like every other dry-run read.
 */
async function pollBatches(input: { now: string; deadline: number; dryRun: boolean }): Promise<BatchRecord[]> {
  // An unreadable row polls nothing; the write at the end of the run reads
  // the row again for itself and refuses if it is still unreadable.
  const records = (await readBatchRecords()) ?? [];
  const updated: BatchRecord[] = [];
  let polled = 0;
  let changed = false;
  let halted = false;
  for (const record of records) {
    if (halted || !batchUnfinished(record) || Date.now() > input.deadline) {
      updated.push(record);
      continue;
    }
    const result = await omnisendRequest<unknown>({ method: "GET", path: `/batches/${encodeURIComponent(record.id)}`, retries: 0 });
    polled += 1;
    if (!result.ok) {
      console.warn(LOG, "batch poll refused", { batch: record.id, status: result.status });
      if (result.status === 0) halted = true;
      updated.push(record);
      continue;
    }
    updated.push(applyBatchRead(record, parseBatchStatus(result.body), input.now));
    changed = true;
  }
  if (changed && !input.dryRun) await writeBatchRecords(updated);
  if (records.length > 0) console.info(LOG, "batches polled", { remembered: records.length, polled, halted });
  return updated;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function reconcileOmnisendContacts(opts: OmnisendReconcileOptions = {}): Promise<OmnisendReconcileResult> {
  const dryRun = opts.dryRun === true;
  const result: OmnisendReconcileResult = {
    pushed: 0,
    suppressed: 0,
    smsOptOuts: 0, smsSubscribers: 0,
    formSubscribers: 0,
    winbackCodes: 0,
    dryRun,
    skipped: null,
    report: emptyReconcileReport(),
  };
  const report = result.report;

  // Gate first, before any database work, in the same order the transport
  // itself enforces: a preview deployment returns here having done nothing.
  const gate = omnisendActive();
  if (!gate.active) return { ...result, skipped: gate.reason };

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(5_000, Math.trunc(opts.budgetMs ?? DEFAULT_BUDGET_MS));
  const limit = Math.max(0, Math.trunc(Number(opts.limit ?? DEFAULT_PUSH_LIMIT) || 0));

  try {
    const now = new Date().toISOString();

    // Omnisend's side of the ledger, read before this run changes anything.
    // (Bound to a local because the client-snippet invariant in
    // lib/ads/omnisend-source.test.ts reads any `omnisend.` token as the
    // browser SDK; the report field keeps its documented name.)
    const remote = report.omnisend;
    const before = await countOmnisendContacts();
    remote.contactsBefore = before.count;
    remote.contactsAfter = before.count;
    remote.capped = before.capped;
    if (before.capped) report.unresolved.push(`omnisend contact count capped at ${MAX_CONTACT_PAGES} pages`);
    else if (!before.complete) report.unresolved.push("omnisend contact count incomplete: a contacts page was refused");

    // How the batches from earlier runs went, before this run submits more.
    const records = await pollBatches({ now, deadline, dryRun });
    report.unresolved.push(...batchNotes(records));

    const audience = await loadAudience();
    report.store.consented = audience?.size ?? 0;

    const writeBack = await runWriteBack({ dryRun, audience, now });
    result.suppressed = writeBack.suppressed;
    result.smsOptOuts = writeBack.smsOptOuts;
    result.smsSubscribers = writeBack.smsSubscribers;
    result.formSubscribers = writeBack.formSubscribers;
    report.writeBack = { suppressed: writeBack.suppressed, smsOptOuts: writeBack.smsOptOuts, smsSubscribers: writeBack.smsSubscribers, formSubscribers: writeBack.formSubscribers };
    report.store.suppressed = writeBack.suppressionRows ?? 0;
    report.unresolved.push(...writeBack.notes);

    if (!audience) {
      result.skipped = "consented audience unreadable; nothing pushed";
      report.unresolved.push(result.skipped);
    } else if (opts.push === false) {
      // Write-back only (see OmnisendReconcileOptions.push): no cutoff stamp,
      // no push, no count of the audience after. The daily full run does those.
      result.skipped = "write-back only; the full push runs on its own cadence";
    } else {
      // The cutoff is the instant the first live push began; written once,
      // by whichever run is first, and never by a dry run.
      if (!dryRun) await recordMigrationCutoff(now);
      const push = await runPush({ dryRun, audience, limit, deadline });
      result.pushed = push.pushed;
      result.winbackCodes = push.winbackCodes;
      report.push = { submitted: push.pushed, batches: push.batches, batchIds: push.batchIds, failedBatches: push.failedBatches };
      report.store.buyersWithoutConsent = push.buyersWithoutConsent;
      report.store.smsConsented = push.smsConsented;
      report.store.nonMailable = push.nonMailable;
      if (push.unreadable > 0) report.unresolved.push(`${push.unreadable} address(es) skipped: store record unreadable; re-read next run`);

      if (!dryRun && push.submissions.length > 0) {
        // Merged onto a FRESH read: the row read at run start is stale by
        // now (another run, a refused poll write), and an unreadable row
        // is refused rather than written over, or every unfinished id the
        // next run was going to poll would be gone.
        const fresh = await readBatchRecords();
        if (fresh === null) {
          console.error(LOG, "batches row unreadable at write time; batch ids not remembered", { submitted: push.submissions.length });
          report.unresolved.push(`${push.submissions.length} batch id(s) not remembered: batches row unreadable; the next run cannot poll them`);
        } else {
          await writeBatchRecords(rememberBatches(mergeBatchRecords(fresh, records), push.submissions, now));
        }
        report.unresolved.push(`${push.submissions.length} batch(es) submitted; Omnisend processes them in the background and the next run polls them`);
      }
      if (!dryRun && push.batches > 0) {
        const after = await countOmnisendContacts();
        remote.contactsAfter = after.count;
        remote.capped = remote.capped || after.capped;
        if (after.capped) report.unresolved.push(`omnisend contact count capped at ${MAX_CONTACT_PAGES} pages (after)`);
        else if (!after.complete) report.unresolved.push("omnisend contact count incomplete (after): a contacts page was refused");
      }

      const notes: string[] = [];
      if (push.failedBatches > 0) notes.push(`${push.failedBatches} batch(es) failed`);
      if (push.capped > 0) notes.push(`push capped: ${push.capped} target(s) left for the next run`);
      if (push.stopped) notes.push(push.stopped);
      result.skipped = notes.length > 0 ? notes.join("; ") : null;
      report.unresolved.push(...notes);
    }

    console.info(LOG, dryRun ? "dry run" : "done", { ...result, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    console.error(LOG, "reconcile threw", error);
    return { ...result, skipped: `reconcile threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
