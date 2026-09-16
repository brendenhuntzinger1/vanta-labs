import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

const LOG = "[omnisend/state]";

/**
 * omnisend_sync_state, read and written one key at a time.
 *
 * The table is a handful of jsonb rows under short keys: the contacts
 * reconcile's watermark (owned by reconcile.ts, which keeps its own accessor)
 * and the cadence stamps for the cron jobs in sweeps.ts. Both accessors have
 * the same shape and the same failure direction — an unreadable row reads as
 * "nothing recorded", which makes a job run rather than stall, and a refused
 * write is logged and swallowed, because the job it belongs to has already
 * done its work.
 *
 * Never throws. Every line is logged under [omnisend/state] followed by the
 * caller's own prefix, so a refused read is attributed to the job that asked.
 */

export async function readSyncState<T extends Record<string, unknown>>(stateKey: string, log: string): Promise<T | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("omnisend_sync_state")
      .select("value")
      .eq("key", stateKey)
      .maybeSingle();
    if (error) {
      console.error(LOG, log, "sync state read refused", stateKey, error.message);
      return null;
    }
    const value = (data as { value?: unknown } | null)?.value;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
  } catch (error) {
    console.error(LOG, log, "sync state read failed", stateKey, error);
    return null;
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
