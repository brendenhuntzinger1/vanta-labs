import "server-only";

import { findUserByEmail } from "@/lib/auth-confirmation-email";
import { omnisendActive, omnisendRequest } from "@/lib/marketing/omnisend/client";
import {
  DELIVERY_FAILED_EVENT,
  SPAM_EVENT,
  nextEventCursor,
  parseContactEvents,
  verdictForContact,
  verdictShouldBeWritten,
  type OmnisendContactEvent,
  type ProviderVerdict,
} from "@/lib/marketing/omnisend/provider-verdicts-plan";
import { readSyncState, writeSyncState } from "@/lib/marketing/omnisend/sync-state";
import { recordSystemAlert } from "@/lib/monitoring";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * THE MAILBOX VERDICTS OMNISEND SEES, WRITTEN INTO THE STORE'S SUPPRESSION LIST.
 *
 * The nightly write-back mirrors an Omnisend UNSUBSCRIBE because the contacts
 * API carries a channel status. It carries no bounce field, so hard bounces and
 * spam complaints — the two facts that actually wreck a sending domain — had no
 * path back at all. Resend's webhook does that job today and stops seeing
 * marketing mail at cutover. This closes it before that happens.
 *
 * HOW, given what the API actually offers. `POST /api/events/query` returns
 * per-contact events and two of its standard names are the verdicts wanted:
 * `marked message as spam` and `message delivery failed`. It requires contact
 * ids, up to 100 per call, rate limited to 20 calls a minute. So each run pages
 * the contact list for (id, email), asks for each event name in chunks, and
 * turns the answers into suppressions through the pure rules in
 * provider-verdicts-plan.ts.
 *
 * PULLED, NOT PUSHED, and that is the strength rather than a compromise. It is
 * authenticated by this store's own API key against Omnisend's servers, so
 * there is nothing forgeable about it — unlike an inbound webhook, which
 * Omnisend's Public API does not offer to register anyway and which would be an
 * unsigned endpoint able to suppress any address (see webhooks/email/route.ts
 * for what that costs).
 *
 * NEVER THROWS. It runs from cron beside the other Omnisend sweeps, and a
 * marketing sync that fails is a log line and a result, never a 2am page.
 *
 * THE WATERMARK ONLY ADVANCES ON A CLEAN RUN. A run that could not read a page,
 * or could not write a suppression it decided on, leaves the watermark where it
 * was so the next run sees the same window again. Re-reading is free; missing a
 * complaint is not.
 */

const LOG = "[omnisend/verdicts]";
const STATE_KEY = "provider_verdicts";
/** Omnisend's ceiling for contact ids in one events query. */
const CONTACT_CHUNK = 100;
/** Omnisend's ceiling for `GET /contacts?limit=`. */
const CONTACTS_PAGE_SIZE = 250;
/** Far more contacts than this account will hold; stops an unbounded walk. */
const MAX_CONTACT_PAGES = 40;
/**
 * 20 events-query calls a minute is the documented limit and this job makes two
 * per chunk of a hundred contacts. Stopping at this many chunks keeps a run
 * inside both the rate limit and the sweep's wall-clock budget; whatever is not
 * reached is reached on the next tick, because the watermark did not move.
 */
const MAX_CHUNKS_PER_RUN = 8;
/**
 * How far back the first run looks. After that the watermark carries it. Thirty
 * days is longer than any plausible gap between runs and short enough that a
 * first run is one window rather than the whole history of the account.
 */
const FIRST_RUN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export type OmnisendVerdictSweepResult = {
  /** Contacts whose events were asked for. */
  scanned: number;
  /** Verdicts the rules produced. */
  decided: number;
  /** Suppressions actually written. */
  suppressed: number;
  /** Verdicts deliberately not written (weaker than, or older than, what is held). */
  held: number;
  /** True when anything failed, which also holds the watermark. */
  incomplete: boolean;
  skipped: string | null;
};

type ContactRef = { id: string; email: string };

function empty(): Omit<OmnisendVerdictSweepResult, "skipped"> {
  return { scanned: 0, decided: 0, suppressed: 0, held: 0, incomplete: false };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every contact Omnisend holds, as (id, email).
 *
 * The events query is keyed by Omnisend's own contact id, which
 * parseOmnisendContacts deliberately does not carry — it exists to read consent
 * and keys everything on the address. So this reads the id here rather than
 * widening that parser for one caller.
 */
async function readContactRefs(): Promise<{ contacts: ContactRef[]; complete: boolean }> {
  const contacts: ContactRef[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_CONTACT_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(CONTACTS_PAGE_SIZE) });
    if (cursor) query.set("after", cursor);
    const result = await omnisendRequest<unknown>({ method: "GET", path: `/contacts?${query.toString()}` });
    if (!result.ok) {
      console.error(LOG, "contact page refused", result.error);
      return { contacts, complete: false };
    }

    const root = result.body && typeof result.body === "object" ? (result.body as Record<string, unknown>) : null;
    const list = Array.isArray(root?.contacts) ? root.contacts : [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
      if (id && email) contacts.push({ id, email });
    }

    cursor = nextEventCursor(result.body);
    if (!cursor) return { contacts, complete: true };
  }

  console.error(LOG, "contact walk hit the page ceiling; treating the run as incomplete");
  return { contacts, complete: false };
}

/** Every stored event of one name for up to a hundred contacts, following the cursor. */
async function readEvents(input: {
  contactIDs: string[];
  eventName: string;
  from: string;
}): Promise<{ events: OmnisendContactEvent[]; complete: boolean }> {
  const events: OmnisendContactEvent[] = [];
  let after: string | null = null;

  // Bounded: a contact with a pathological number of failures cannot hold the
  // sweep open for ever.
  for (let page = 0; page < 10; page += 1) {
    const body: Record<string, unknown> = {
      contactIDs: input.contactIDs,
      eventName: input.eventName,
      from: input.from,
      limit: 250,
    };
    if (after) body.after = after;

    const result = await omnisendRequest<unknown>({ method: "POST", path: "/events/query", body });
    if (!result.ok) {
      // 403 means the API key lacks the `events.read` scope. Said plainly
      // because the symptom otherwise is "no bounces ever appear", which looks
      // exactly like a healthy list.
      console.error(LOG, "events query refused", input.eventName, result.status, result.error);
      return { events, complete: false };
    }

    events.push(...parseContactEvents(result.body));
    after = nextEventCursor(result.body);
    if (!after) return { events, complete: true };
  }

  console.error(LOG, "events paging hit the ceiling for", input.eventName);
  return { events, complete: false };
}

/** What the store already holds about these addresses. */
async function readExistingSuppressions(
  emails: string[],
): Promise<Map<string, { reason: string | null; created_at: string | null }> | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("email_suppressions")
      .select("email, reason, created_at")
      .in("email", emails);
    if (error) {
      console.error(LOG, "suppression read refused", error.message);
      return null;
    }
    const held = new Map<string, { reason: string | null; created_at: string | null }>();
    for (const row of (data ?? []) as Array<{ email?: string; reason?: string | null; created_at?: string | null }>) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (email) held.set(email, { reason: row.reason ?? null, created_at: row.created_at ?? null });
    }
    return held;
  } catch (error) {
    console.error(LOG, "suppression read failed", error);
    return null;
  }
}

/**
 * Write one verdict.
 *
 * Mirrors applySuppression in reconcile.ts, including the retry without
 * `source` for a database that has not run email-lifecycle-2026-09-04.sql, and
 * the best-effort mirror onto the account's marketing toggle so
 * /account/settings agrees with the list rather than inviting the customer to
 * undo a suppression the mailbox imposed.
 */
async function writeVerdict(verdict: ProviderVerdict): Promise<boolean> {
  try {
    const row = { email: verdict.email, reason: verdict.reason, created_at: verdict.at };
    let { error } = await supabaseAdmin
      .from("email_suppressions")
      .upsert({ ...row, source: "omnisend" }, { onConflict: "email" });
    if (error && /source/i.test(String(error.message ?? ""))) {
      ({ error } = await supabaseAdmin.from("email_suppressions").upsert(row, { onConflict: "email" }));
    }
    if (error) {
      console.error(LOG, "suppression write refused", error.message);
      return false;
    }

    try {
      const user = await findUserByEmail(verdict.email);
      if (user?.id) {
        await supabaseAdmin
          .from("customer_preferences")
          .upsert(
            { user_id: user.id, marketing_emails: false, updated_at: new Date().toISOString() },
            { onConflict: "user_id" },
          );
      }
    } catch {
      // Non-fatal: email_suppressions is the authoritative gate.
    }
    return true;
  } catch (error) {
    console.error(LOG, "suppression write failed", error);
    return false;
  }
}

export async function omnisendProviderVerdictsSweep(): Promise<OmnisendVerdictSweepResult> {
  const gate = omnisendActive();
  if (!gate.active) return { ...empty(), skipped: gate.reason };

  const outcome = empty();
  try {
    const startedAt = new Date();
    const state = await readSyncState<{ since?: string }>(STATE_KEY, LOG);
    const since = state.value?.since ?? new Date(startedAt.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();

    const { contacts, complete: contactsComplete } = await readContactRefs();
    if (!contactsComplete) outcome.incomplete = true;
    if (contacts.length === 0) {
      return { ...outcome, skipped: contactsComplete ? "no contacts" : "contact read incomplete" };
    }

    const byId = new Map(contacts.map((contact) => [contact.id, contact.email]));
    const chunks = chunk(contacts, CONTACT_CHUNK).slice(0, MAX_CHUNKS_PER_RUN);
    if (chunks.length * CONTACT_CHUNK < contacts.length) {
      // Said out loud rather than silently truncated: the next run picks the
      // rest up because the watermark is about to be held.
      console.error(LOG, `stopped at ${chunks.length} chunks of ${Math.ceil(contacts.length / CONTACT_CHUNK)}`);
      outcome.incomplete = true;
    }

    /** contactID → every relevant event for it in this window. */
    const eventsByContact = new Map<string, OmnisendContactEvent[]>();
    for (const group of chunks) {
      const contactIDs = group.map((contact) => contact.id);
      outcome.scanned += contactIDs.length;
      for (const eventName of [SPAM_EVENT, DELIVERY_FAILED_EVENT]) {
        const { events, complete } = await readEvents({ contactIDs, eventName, from: since });
        if (!complete) outcome.incomplete = true;
        for (const event of events) {
          const list = eventsByContact.get(event.contactID);
          if (list) list.push(event);
          else eventsByContact.set(event.contactID, [event]);
        }
      }
    }

    const verdicts: ProviderVerdict[] = [];
    for (const [contactID, events] of eventsByContact) {
      const email = byId.get(contactID);
      if (!email) continue;
      const verdict = verdictForContact({ email, events });
      if (verdict) verdicts.push(verdict);
    }
    outcome.decided = verdicts.length;
    if (verdicts.length === 0) {
      if (!outcome.incomplete) {
        await writeSyncState(STATE_KEY, { since: startedAt.toISOString() }, LOG);
      }
      return { ...outcome, skipped: null };
    }

    const held = await readExistingSuppressions(verdicts.map((verdict) => verdict.email));
    if (!held) {
      // Unreadable is NOT "nothing is suppressed". Writing on that assumption
      // could downgrade a complaint to a soft-bounce run.
      return { ...outcome, incomplete: true, skipped: "suppression list unreadable" };
    }

    for (const verdict of verdicts) {
      if (!verdictShouldBeWritten({ verdict, existing: held.get(verdict.email) ?? null })) {
        outcome.held += 1;
        continue;
      }
      const written = await writeVerdict(verdict);
      if (!written) {
        outcome.incomplete = true;
        continue;
      }
      outcome.suppressed += 1;

      // A complaint damages the domain that also carries receipts, so it is
      // the one worth waking somebody for. A bounce is list hygiene.
      await recordSystemAlert({
        type: verdict.reason === "complained" ? "email_complaint" : "email_hard_bounce",
        severity: verdict.reason === "complained" ? "warning" : "info",
        message: verdict.reason === "complained"
          ? "A recipient marked Omnisend email as spam. Suppressed from all marketing."
          : `Omnisend reported an undeliverable address (${verdict.evidence}). Suppressed from marketing.`,
        context: { email: verdict.email, source: "omnisend", evidence: verdict.evidence, at: verdict.at },
      }).catch(() => {});
    }

    if (!outcome.incomplete) {
      await writeSyncState(STATE_KEY, { since: startedAt.toISOString() }, LOG);
    }
    return { ...outcome, skipped: null };
  } catch (error) {
    console.error(LOG, "verdict sweep threw", error);
    return { ...outcome, incomplete: true, skipped: `verdict sweep threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
