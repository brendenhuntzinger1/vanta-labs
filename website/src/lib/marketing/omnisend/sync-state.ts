import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

const LOG = "[omnisend/state]";

/**
 * omnisend_sync_state, read and written one key at a time.
 *
 * The table is a handful of jsonb rows under short keys: the contacts
 * reconcile's watermark (owned by reconcile.ts, which keeps its own accessor)
 * and the cadence stamps and the order backstop's floor for the cron jobs in
 * sweeps.ts. A refused write is logged and swallowed, because the job it
 * belongs to has already done its work.
 *
 * A read answers `{ value, unreadable }` rather than a bare value, because
 * "no record" and "could not read the record" are different facts and one
 * caller needs the difference: the order backstop stamps its floor on a
 * first run, and a database hiccup that read as a first run would move that
 * floor forward past orders it still owes. The cadence jobs are free to
 * treat unreadable as "not recorded", which makes them run rather than stall.
 *
 * Never throws. Every line is logged under [omnisend/state] followed by the
 * caller's own prefix, so a refused read is attributed to the job that asked.
 */

export type SyncStateRead<T> = {
  /** The stored object, or null when there is none or it could not be read. */
  value: T | null;
  /** True when the read was refused or threw, so `value: null` means nothing about the row. */
  unreadable: boolean;
};

export async function readSyncState<T extends Record<string, unknown>>(stateKey: string, log: string): Promise<SyncStateRead<T>> {
  try {
    const { data, error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .select("value")
      .eq("key", stateKey)
      .maybeSingle();
    if (error) {
      console.error(LOG, log, "sync state read refused", stateKey, error.message);
      return { value: null, unreadable: true };
    }
    const value = (data as { value?: unknown } | null)?.value;
    return {
      value: value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null,
      unreadable: false,
    };
  } catch (error) {
    console.error(LOG, log, "sync state read failed", stateKey, error);
    return { value: null, unreadable: true };
  }
}

export async function writeSyncState(stateKey: string, value: Record<string, unknown>, log: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .upsert({ key: stateKey, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) {
      console.error(LOG, log, "sync state write refused", stateKey, error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error(LOG, log, "sync state write failed", stateKey, error);
    return false;
  }
}
