/**
 * THE CONTROL SNAPSHOT'S SHORT MEMORY, KEPT APART FROM THE MODULE THAT USES IT.
 *
 * admin-control.ts reads the operator's settings through here (see the
 * comment on CONTROL_SNAPSHOT_TTL_MS there for why a cache exists at all). It
 * lives in its own file for one reason: the e2e fake database writes control
 * rows directly, the way a test seeds any table, and a write to the control
 * table has to forget this memory exactly as upsertControlValue does in
 * production. Importing admin-control from the fake database would drag
 * `server-only` and the Supabase client into a module that exists to replace
 * them; importing this file drags in nothing.
 */

export const CONTROL_SNAPSHOT_TTL_MS = 10_000;

const cache = new Map<string, { rows: unknown[]; expiresAt: number }>();

/** The rows remembered under `key`, or null when there are none or they have aged out. */
export function readCachedControlRows<T>(key: string, now: number): T[] | null {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt <= now) return null;
  return hit.rows as T[];
}

export function rememberControlRows(key: string, rows: unknown[], now: number): void {
  cache.set(key, { rows, expiresAt: now + CONTROL_SNAPSHOT_TTL_MS });
}

/** Forget every cached section. Every write to the control table calls this. */
export function invalidateControlSnapshotCache(): void {
  cache.clear();
}
