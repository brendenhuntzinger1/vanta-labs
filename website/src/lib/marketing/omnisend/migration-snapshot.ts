import "server-only";

import { omnisendActive } from "@/lib/marketing/omnisend/client";
import type { ContactFacts } from "@/lib/marketing/omnisend/contact-payload";
import { collectContactFacts } from "@/lib/marketing/omnisend/contacts";
import { recordMigrationSnapshot } from "@/lib/marketing/omnisend/migration-state";
import {
  loadAudience,
  loadPaidBuyers,
  loadSuppressionReasons,
  loadWithdrawnConsent,
  mapWithConcurrency,
} from "@/lib/marketing/omnisend/reconcile";
import { isValidSnapshotLabel, orderPushTargets } from "@/lib/marketing/omnisend/reconcile-plan";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The consent snapshot: what the STORE says about every address, at one
 * instant, under a label.
 *
 * Taken before the first write to Omnisend and again whenever the operator
 * wants proof. It records the store's own view — the same three consent
 * stores collectContactFacts reads, in the same order of precedence — and
 * never asks Omnisend anything, so two snapshots compared address by address
 * show exactly what changed in the store between them. The invariant the
 * comparison proves is that nothing widened: no address that was
 * unsubscribed or suppressed under the earlier label is subscribed under
 * the later one on the strength of anything Omnisend holds.
 *
 * The population is the push's population — the consented audience, then
 * the paid buyers without consent — walked through the loaders reconcile.ts
 * exports, plus every address on the suppression list, plus everyone who
 * withdrew consent without landing there: a guest whose unsubscribed_at is
 * set and an account with the marketing box unticked. None of those are
 * pushed, but they are the people a resubscribe would harm, so a snapshot
 * that left them out could not prove the one thing it exists for.
 *
 * One snapshot per label. A label that already has rows is skipped, never
 * appended to, so an operator who runs it twice gets the same evidence, not
 * a doubled table. Rows go in chunks of 500.
 *
 * Never throws: this runs from an admin button, and it may not fail the
 * request. Whatever went wrong is in the log under `[omnisend/snapshot]`
 * and in `skipped`. No log line names an address.
 */

const LOG = "[omnisend/snapshot]";
const SNAPSHOT_CHUNK = 500;
const FACTS_CONCURRENCY = 8;

export type OmnisendSnapshotResult = {
  label: string;
  takenAt: string;
  /** Addresses in the population walked. */
  addresses: number;
  /** Rows written under the label (or already there, when skipped). */
  rows: number;
  skipped: string | null;
};

type SnapshotRow = {
  taken_at: string;
  label: string;
  email: string;
  email_status: string;
  sms_status: string;
  phone_present: boolean;
  sources: { email: string | null; sms: string | null };
  suppressed_reason: string | null;
  orders: number;
  last_order_at: string | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * One row, straight from the facts. `sms_status` is "none" for an account
 * with neither SMS consent nor an opt-out stamp and for every guest, so the
 * column is never null and a later comparison needs no special case.
 */
function snapshotRow(facts: ContactFacts, input: { label: string; takenAt: string; suppressedReason: string | null }): SnapshotRow {
  return {
    taken_at: input.takenAt,
    label: input.label,
    email: facts.email,
    email_status: facts.emailConsent.status,
    sms_status: facts.smsConsent?.status ?? "none",
    phone_present: Boolean(String(facts.phone ?? "").trim()),
    sources: { email: facts.emailConsent.source ?? null, sms: facts.smsConsent?.source ?? null },
    suppressed_reason: input.suppressedReason,
    orders: Math.max(0, Math.trunc(Number(facts.orders) || 0)),
    last_order_at: facts.lastOrderAt ?? null,
  };
}

/** Rows already under the label, or null when the table could not be read. */
async function countLabelRows(label: string): Promise<number | null> {
  try {
    const { count, error } = await supabaseAdmin
      .from("omnisend_consent_snapshot")
      .select("id", { count: "exact", head: true })
      .eq("label", label);
    if (error) {
      console.error(LOG, "label count refused", { error: error.message });
      return null;
    }
    return count ?? 0;
  } catch (error) {
    console.error(LOG, "label count failed", error);
    return null;
  }
}

async function insertRows(rows: SnapshotRow[]): Promise<{ inserted: number; failedChunks: number }> {
  let inserted = 0;
  let failedChunks = 0;
  for (const [index, batch] of chunk(rows, SNAPSHOT_CHUNK).entries()) {
    try {
      const { error } = await supabaseAdmin
        .from("omnisend_consent_snapshot")
        .insert(batch);
      if (error) {
        failedChunks += 1;
        console.error(LOG, "chunk insert refused", { chunk: index, size: batch.length, error: error.message });
        continue;
      }
      inserted += batch.length;
    } catch (error) {
      failedChunks += 1;
      console.error(LOG, "chunk insert failed", { chunk: index, size: batch.length, error });
    }
  }
  return { inserted, failedChunks };
}

export async function snapshotOmnisendConsent(opts: { label: string }): Promise<OmnisendSnapshotResult> {
  const label = String(opts.label ?? "").trim();
  const takenAt = new Date().toISOString();
  const result: OmnisendSnapshotResult = { label, takenAt, addresses: 0, rows: 0, skipped: null };

  // Gate first, before any database work, in the same order the transport
  // enforces: a preview deployment records nothing.
  const gate = omnisendActive();
  if (!gate.active) return { ...result, skipped: gate.reason };
  if (!isValidSnapshotLabel(label)) return { ...result, skipped: "label must be 1-64 letters, digits or hyphens" };

  const startedAt = Date.now();
  try {
    const existing = await countLabelRows(label);
    if (existing === null) return { ...result, skipped: "snapshot table unreadable; nothing recorded" };
    if (existing > 0) return { ...result, rows: existing, skipped: `label already has ${existing} row(s); nothing recorded` };

    const [audience, buyerRead, suppressions, withdrawn] = await Promise.all([
      loadAudience(),
      loadPaidBuyers(),
      loadSuppressionReasons(),
      loadWithdrawnConsent(),
    ]);
    // A partial population is not evidence: without the whole audience, the
    // whole suppression list or the whole withdrawn set, a later comparison
    // could not tell "missing from the snapshot" from "changed since", so
    // nothing is recorded.
    if (!audience || !suppressions || !withdrawn) {
      return { ...result, skipped: "audience, suppression list or withdrawn consent unreadable; nothing recorded" };
    }
    const buyers = buyerRead.buyers;

    const targets = [...new Set([
      ...orderPushTargets(audience, buyers),
      ...[...suppressions.keys()].sort(),
      ...[...withdrawn].sort(),
    ])];
    result.addresses = targets.length;

    const facts = await mapWithConcurrency(targets, FACTS_CONCURRENCY, (email) => collectContactFacts(email));
    const rows: SnapshotRow[] = [];
    let unreadable = 0;
    for (const [index, entry] of facts.entries()) {
      if (!entry) {
        unreadable += 1;
        continue;
      }
      const email = targets[index];
      const suppressedReason = suppressions.has(email) ? (suppressions.get(email) ?? "unspecified") : null;
      rows.push(snapshotRow(entry, { label, takenAt, suppressedReason }));
    }

    const { inserted, failedChunks } = await insertRows(rows);
    result.rows = inserted;
    if (inserted > 0) await recordMigrationSnapshot({ label, at: takenAt });

    const notes: string[] = [];
    if (unreadable > 0) notes.push(`${unreadable} address(es) could not be collected`);
    if (failedChunks > 0) notes.push(`${failedChunks} chunk(s) refused`);
    result.skipped = notes.length > 0 ? notes.join("; ") : null;

    console.info(LOG, "taken", { label, addresses: targets.length, rows: inserted, unreadable, failedChunks, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    console.error(LOG, "snapshot threw", error);
    return { ...result, skipped: `snapshot threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
