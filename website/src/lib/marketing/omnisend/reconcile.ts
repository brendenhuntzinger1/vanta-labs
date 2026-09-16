import "server-only";

import { findUserByEmail } from "@/lib/auth-confirmation-email";
import { loadConsentedAudience } from "@/lib/email/audience";
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
import { OMNISEND_LINK_TTL_MS, signOmnisendLink } from "@/lib/marketing/omnisend/link-token";
import {
  latestUpdatedAt,
  parseOmnisendContacts,
  parseOmnisendPaging,
  planWriteBack,
  type OmnisendContactRead,
} from "@/lib/marketing/omnisend/reconcile-plan";
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
 * planWriteBack (a suppressed address is never re-subscribed) and by
 * collectContactFacts (an unreadable suppression store reads as
 * unsubscribed). A run that cannot read the suppression list skips the
 * write-back entirely rather than guessing.
 *
 * Never throws: it runs from cron and from an admin button, and neither may
 * fail over a marketing sync. Whatever went wrong is in the log under
 * `[omnisend/reconcile]` and in `skipped`.
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
};

export type OmnisendReconcileResult = {
  pushed: number;
  suppressed: number;
  smsOptOuts: number;
  formSubscribers: number;
  winbackCodes: number;
  dryRun: boolean;
  skipped: string | null;
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

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

/** Null when the list could not be read IN FULL: a short suppression list is not a suppression list. */
async function loadSuppressed(): Promise<Set<string> | null> {
  try {
    const { rows, truncated } = await readAllRowsBounded<{ email: string }>(
      (from, to) => supabaseAdmin
        .from("email_suppressions")
        .select("email")
        .order("email", { ascending: true })
        .range(from, to),
      { maxRows: MAX_STORE_ROWS, label: "omnisend suppression read" },
    );
    if (truncated) {
      console.error(LOG, "suppression list truncated; write-back skipped");
      return null;
    }
    const suppressed = new Set<string>();
    for (const row of rows) {
      const email = normalizeEmail(row.email);
      if (email) suppressed.add(email);
    }
    return suppressed;
  } catch (error) {
    console.error(LOG, "suppression read failed", error);
    return null;
  }
}

/** The union of both consent stores minus suppressions, or null when it could not be read in full. */
async function loadAudience(): Promise<Set<string> | null> {
  try {
    return (await loadConsentedAudience()).all;
  } catch (error) {
    console.error(LOG, "audience read failed", error);
    return null;
  }
}

/**
 * Mirrors suppress() in src/app/api/unsubscribe/route.ts, including the
 * retry without `source` for a database that has not run
 * email-lifecycle-2026-09-04.sql, and the best-effort mirror onto the
 * account's marketing toggle so /account/settings agrees with the list.
 */
async function applySuppression(email: string, now: string): Promise<boolean> {
  try {
    const row = { email, reason: "unsubscribed", created_at: now };
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

/** The same row recordMarketingOptIn writes, with the source that names where it came from. */
async function applyFormSubscriber(email: string, now: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from("marketing_subscribers")
      .upsert({ email, source: "omnisend-form", opted_in_at: now, unsubscribed_at: null }, { onConflict: "email" });
    if (error) {
      console.error(LOG, "form subscriber write refused", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error(LOG, "form subscriber write failed", error);
    return false;
  }
}

/**
 * SMS consent lives on the account only, so a guest has nothing to stamp. An
 * account that already carries an opt-out keeps its original timestamp: the
 * stamp is when the person said stop, not when this job last noticed.
 */
async function applySmsOptOut(email: string, now: string): Promise<boolean> {
  try {
    const user = await findUserByEmail(email);
    if (!user?.id) return false;
    const { data, error } = await supabaseAdmin
      .from("customer_preferences")
      .select("sms_opted_out_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      console.error(LOG, "sms preference read refused", error.message);
      return false;
    }
    if ((data as { sms_opted_out_at?: string | null } | null)?.sms_opted_out_at) return false;
    const { error: writeError } = await supabaseAdmin
      .from("customer_preferences")
      .upsert({ user_id: user.id, sms_marketing: false, sms_opted_out_at: now, updated_at: now }, { onConflict: "user_id" });
    if (writeError) {
      console.error(LOG, "sms opt-out write refused", writeError.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error(LOG, "sms opt-out write failed", error);
    return false;
  }
}

type WriteBackCounts = { suppressed: number; smsOptOuts: number; formSubscribers: number };

async function runWriteBack(input: { dryRun: boolean; audience: Set<string> | null; now: string }): Promise<WriteBackCounts> {
  const counts: WriteBackCounts = { suppressed: 0, smsOptOuts: 0, formSubscribers: 0 };

  const suppressed = await loadSuppressed();
  if (!suppressed) {
    console.error(LOG, "write-back skipped: the suppression list could not be read");
    return counts;
  }

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
  }

  console.info(LOG, "write-back plan", {
    watermark,
    contacts: contacts.length,
    complete,
    suppress: plan.suppress.length,
    smsOptOut: plan.smsOptOut.length,
    newSubscribers: newSubscribers.length,
    dryRun: input.dryRun,
  });

  if (input.dryRun) {
    return { suppressed: plan.suppress.length, smsOptOuts: plan.smsOptOut.length, formSubscribers: newSubscribers.length };
  }

  let failures = 0;
  for (const email of plan.suppress) {
    if (await applySuppression(email, input.now)) counts.suppressed += 1;
    else failures += 1;
  }
  for (const email of newSubscribers) {
    if (await applyFormSubscriber(email, input.now)) counts.formSubscribers += 1;
    else failures += 1;
  }
  for (const email of plan.smsOptOut) {
    if (await applySmsOptOut(email, input.now)) counts.smsOptOuts += 1;
  }

  // Advance only past pages that were read in full and applied without a
  // refusal; anything else is re-read tomorrow, which costs a page and
  // cannot lose an unsubscribe.
  const latest = latestUpdatedAt(contacts);
  if (complete && failures === 0 && latest) await writeWatermark(latest);
  else if (!complete || failures > 0) console.warn(LOG, "watermark held", { complete, failures });

  return counts;
}

// ---------------------------------------------------------------------------
// Push: store → Omnisend
// ---------------------------------------------------------------------------

type OrderRow = { customer_email: string | null; order_type: string | null; replacement_of: string | null };

/** Everyone with a paid product order, whether or not they consented to marketing. */
async function loadPaidBuyers(): Promise<Set<string>> {
  const buyers = new Set<string>();
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
      if (email && !isNonMailableAddress(email)) buyers.add(email);
    }
  } catch (error) {
    console.error(LOG, "buyer read failed", error);
  }
  return buyers;
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

type BuiltContact = { payload: Record<string, unknown>; mintedWinback: boolean };

async function buildContactItem(email: string, dryRun: boolean): Promise<BuiltContact | null> {
  try {
    const facts = await collectContactFacts(email);
    if (!facts) return null;
    const nowMs = Date.now();
    const token = await signOmnisendLink(email, nowMs);
    const link = token ? { token, endsAt: new Date(nowMs + OMNISEND_LINK_TTL_MS).toISOString() } : null;
    const { codes, mintedWinback } = await gatherCodes(email, facts, nowMs, dryRun);
    return { payload: buildContactPayload({ ...facts, link, codes }), mintedWinback };
  } catch (error) {
    // The address is the contact's identity and stays out of the log stream;
    // the domain is enough to tell a broken import from a broken address.
    console.error(LOG, "contact build failed", { domain: email.slice(email.indexOf("@") + 1), error });
    return null;
  }
}

type PushOutcome = { pushed: number; winbackCodes: number; failedBatches: number; stopped: string | null };

async function runPush(input: { dryRun: boolean; audience: Set<string>; limit: number; deadline: number }): Promise<PushOutcome> {
  const outcome: PushOutcome = { pushed: 0, winbackCodes: 0, failedBatches: 0, stopped: null };

  // Consented first, so the people Omnisend may actually mail are the ones a
  // capped run is sure to refresh; buyers without consent go afterwards as
  // nonSubscribed, for segments and lifetime value only.
  const buyers = await loadPaidBuyers();
  const targets = [...input.audience].sort();
  for (const email of [...buyers].sort()) {
    if (!input.audience.has(email)) targets.push(email);
  }
  if (targets.length > input.limit) {
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
      if (!entry) continue;
      items.push(entry.payload);
      if (entry.mintedWinback) outcome.winbackCodes += 1;
    }
    if (items.length === 0) continue;
    if (input.dryRun) {
      outcome.pushed += items.length;
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
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function reconcileOmnisendContacts(opts: OmnisendReconcileOptions = {}): Promise<OmnisendReconcileResult> {
  const dryRun = opts.dryRun === true;
  const result: OmnisendReconcileResult = {
    pushed: 0,
    suppressed: 0,
    smsOptOuts: 0,
    formSubscribers: 0,
    winbackCodes: 0,
    dryRun,
    skipped: null,
  };

  // Gate first, before any database work, in the same order the transport
  // itself enforces: a preview deployment returns here having done nothing.
  const gate = omnisendActive();
  if (!gate.active) return { ...result, skipped: gate.reason };

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(5_000, Math.trunc(opts.budgetMs ?? DEFAULT_BUDGET_MS));
  const limit = Math.max(0, Math.trunc(Number(opts.limit ?? DEFAULT_PUSH_LIMIT) || 0));

  try {
    const now = new Date().toISOString();
    const audience = await loadAudience();

    const writeBack = await runWriteBack({ dryRun, audience, now });
    result.suppressed = writeBack.suppressed;
    result.smsOptOuts = writeBack.smsOptOuts;
    result.formSubscribers = writeBack.formSubscribers;

    if (!audience) {
      result.skipped = "consented audience unreadable; nothing pushed";
    } else {
      const push = await runPush({ dryRun, audience, limit, deadline });
      result.pushed = push.pushed;
      result.winbackCodes = push.winbackCodes;
      const notes: string[] = [];
      if (push.failedBatches > 0) notes.push(`${push.failedBatches} batch(es) failed`);
      if (push.stopped) notes.push(push.stopped);
      result.skipped = notes.length > 0 ? notes.join("; ") : null;
    }

    console.info(LOG, dryRun ? "dry run" : "done", { ...result, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    console.error(LOG, "reconcile threw", error);
    return { ...result, skipped: `reconcile threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
