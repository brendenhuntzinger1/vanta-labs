import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Prove the inventory reservation architecture exists in the LIVE database.
 *
 * This is the one assumption that cannot be left standing before launch. The
 * reservation layer fails OPEN by design — if `reserve_inventory()` is absent,
 * `reserveInventoryForOrder` degrades and checkout proceeds without a hold. That
 * is the right call for a limiter outage (a customer must not be blocked by
 * infrastructure), and it is exactly why a missing migration is dangerous:
 * every page looks correct, every test passes, and two customers can buy the
 * same last unit with nothing anywhere reporting a problem.
 *
 * Every probe here is READ ONLY. The functions are detected through PostgREST's
 * own OpenAPI document rather than by calling them — calling reserve_inventory
 * to see whether it exists would hold real stock, and calling
 * finalize_inventory_for_order would permanently decrement it. Existence is
 * established by reading the schema the database publishes about itself.
 */

/** Everything src/lib/sql/inventory-reservations.sql is responsible for. */
export const REQUIRED_FUNCTIONS = [
  "reserve_inventory",
  "finalize_inventory_for_order",
  "release_inventory_for_order",
  "expire_stale_reservations",
] as const;

export type CheckResult = {
  name: string;
  present: boolean;
  /** What was actually observed, including the database's own error text. */
  detail: string;
};

export type ReservationCheck = {
  /** True only when every object the migration creates was found. */
  applied: boolean;
  /** True when the probe itself could not run — unknown, not absent. */
  inconclusive: boolean;
  checks: CheckResult[];
  summary: string;
};

/**
 * Read PostgREST's OpenAPI document and list the RPCs it exposes.
 *
 * Returns null when the document cannot be read at all, which must be reported
 * as "cannot determine" rather than "no functions" — a failed request is not
 * evidence of a missing migration.
 */
async function exposedRpcNames(): Promise<Set<string> | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const spec = (await response.json()) as { paths?: Record<string, unknown> };
    if (!spec?.paths) return null;
    return new Set(
      Object.keys(spec.paths)
        .filter((path) => path.startsWith("/rpc/"))
        .map((path) => path.slice("/rpc/".length)),
    );
  } catch {
    return null;
  }
}

/** A plain read. Absence of the column surfaces as an error, not as no rows. */
async function columnExists(table: string, column: string): Promise<CheckResult> {
  const name = `${table}.${column}`;
  try {
    const { error } = await supabaseAdmin.from(table).select(column).limit(1);
    if (!error) return { name, present: true, detail: "Column is readable." };
    return { name, present: false, detail: error.message };
  } catch (error) {
    return { name, present: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function tableExists(table: string): Promise<CheckResult> {
  try {
    const { error } = await supabaseAdmin.from(table).select("id").limit(1);
    if (!error) return { name: table, present: true, detail: "Table is readable." };
    return { name: table, present: false, detail: error.message };
  } catch (error) {
    return { name: table, present: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkInventoryReservation(): Promise<ReservationCheck> {
  const [reservedOnProducts, reservedOnDoses, reservationsTable, rpcs] = await Promise.all([
    columnExists("products", "reserved_quantity"),
    columnExists("product_doses", "reserved_quantity"),
    tableExists("inventory_reservations"),
    exposedRpcNames(),
  ]);

  const functionChecks: CheckResult[] = REQUIRED_FUNCTIONS.map((fn) => {
    if (rpcs === null) {
      return { name: `${fn}()`, present: false, detail: "Could not read the database's published schema." };
    }
    return rpcs.has(fn)
      ? { name: `${fn}()`, present: true, detail: "Published by the database." }
      : { name: `${fn}()`, present: false, detail: "Not published — the function does not exist." };
  });

  const checks = [reservedOnProducts, reservedOnDoses, reservationsTable, ...functionChecks];
  // A failed schema read means unknown. Reporting that as "not applied" would
  // send someone to re-run a migration that may already be there.
  const inconclusive = rpcs === null;
  const applied = !inconclusive && checks.every((check) => check.present);
  const missing = checks.filter((check) => !check.present).map((check) => check.name);

  return {
    applied,
    inconclusive,
    checks,
    summary: inconclusive
      ? "Cannot determine — the database's published schema could not be read. This is not evidence either way."
      : applied
        ? "Applied. Reservations are enforced by the database, so concurrent checkouts cannot oversell the last unit."
        : `NOT APPLIED — missing: ${missing.join(", ")}. Checkout proceeds without holds, so two customers can buy the same last unit.`,
  };
}
