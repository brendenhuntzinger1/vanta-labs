import "server-only";

import { MAX_BATCH_RECORDS, parseBatchRecords, type BatchRecord } from "@/lib/marketing/omnisend/reconcile-plan";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The migration's own rows in omnisend_sync_state.
 *
 *   "migration"  { cutoffAt, snapshotLabel, snapshotAt }
 *       cutoffAt is the instant the first live contacts push began. It is
 *       written once and never moved: everything the store learns after it
 *       is the delta the nightly reconcile carries across, and everything
 *       before it is what the pre-migration snapshot recorded. The snapshot
 *       fields name the latest consent snapshot taken (migration-snapshot.ts).
 *
 *   "batches"    { batches: [ { id, submittedAt, status, totalCount,
 *                               finishedCount, errorsCount, checkedAt } ] }
 *       The last MAX_BATCH_RECORDS contact batches the push submitted, with
 *       the last status a poll reported for each. Omnisend processes a batch
 *       in the background, so a 200 on the POST proves nothing about the
 *       contacts; the next run polls the unfinished ones and folds what it
 *       learns into the reconciliation report.
 *
 * The reconcile's watermark row ("contacts_reconcile") stays with
 * reconcile.ts, which keeps its own accessor. Every accessor here has the
 * same failure direction: an unreadable row reads as "nothing recorded"
 * (null), a refused write is logged and reported as false, and nothing
 * throws. Nothing here names a person.
 */

const LOG = "[omnisend/state]";
export const MIGRATION_STATE_KEY = "migration";
export const BATCHES_STATE_KEY = "batches";

export type MigrationState = {
  /** When the first live push began; null until it has. */
  cutoffAt: string | null;
  /** The latest consent snapshot's label; null until one is taken. */
  snapshotLabel: string | null;
  snapshotAt: string | null;
};

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/** The row's value, `{}` when there is no row, null when it could not be read. */
async function readState(stateKey: string): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .select("value")
      .eq("key", stateKey)
      .maybeSingle();
    if (error) {
      console.error(LOG, "read refused", { stateKey, error: error.message });
      return null;
    }
    const value = (data as { value?: unknown } | null)?.value;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch (error) {
    console.error(LOG, "read failed", { stateKey, error });
    return null;
  }
}

async function writeState(stateKey: string, value: Record<string, unknown>): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .upsert({ key: stateKey, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) {
      console.error(LOG, "write refused", { stateKey, error: error.message });
      return false;
    }
    return true;
  } catch (error) {
    console.error(LOG, "write failed", { stateKey, error });
    return false;
  }
}

/** Null when the row could not be read; a state with null fields when nothing is recorded yet. */
export async function readMigrationState(): Promise<MigrationState | null> {
  const value = await readState(MIGRATION_STATE_KEY);
  if (value === null) return null;
  return {
    cutoffAt: textOrNull(value.cutoffAt),
    snapshotLabel: textOrNull(value.snapshotLabel),
    snapshotAt: textOrNull(value.snapshotAt),
  };
}

/**
 * Record the cutoff if none is recorded. True when a cutoff is on the row
 * afterwards, whoever wrote it; false when the row could not be read (a
 * write on a guess could move a cutoff that exists) or the write was refused.
 */
export async function recordMigrationCutoff(cutoffAt: string): Promise<boolean> {
  const existing = await readMigrationState();
  if (!existing) return false;
  if (existing.cutoffAt) return true;
  return await writeState(MIGRATION_STATE_KEY, { ...existing, cutoffAt });
}

/** Record the latest snapshot's label and instant, keeping the cutoff as it is. */
export async function recordMigrationSnapshot(input: { label: string; at: string }): Promise<boolean> {
  const existing = await readMigrationState();
  if (!existing) return false;
  return await writeState(MIGRATION_STATE_KEY, { ...existing, snapshotLabel: input.label, snapshotAt: input.at });
}

/**
 * Every remembered batch submission; empty when none, NULL when the row
 * could not be read. The two are different to the reconcile, which merges
 * its write onto a fresh read of this row: an unreadable row read as "no
 * batches" would be written over, dropping every unfinished id the next
 * run was going to poll.
 */
export async function readBatchRecords(): Promise<BatchRecord[] | null> {
  const value = await readState(BATCHES_STATE_KEY);
  return value === null ? null : parseBatchRecords(value);
}

export async function writeBatchRecords(records: BatchRecord[]): Promise<boolean> {
  return await writeState(BATCHES_STATE_KEY, { batches: records.slice(-MAX_BATCH_RECORDS) });
}
