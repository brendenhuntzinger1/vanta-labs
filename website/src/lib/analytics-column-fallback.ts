/**
 * Insert a row whose newer columns may not exist yet.
 *
 * Why this exists: the creative-attribution work added `utm_content`,
 * `utm_term` and `ttclid` to the analytics event insert at the same time as a
 * migration that creates them. Deploying the code without running the
 * migration makes PostgREST reject the whole insert — so every first-party
 * analytics event fails, not just the three new fields. A measurement upgrade
 * that silently switches off the measurement you already had is the worst
 * possible outcome, and it is invisible because the client fires and forgets.
 *
 * So the write degrades instead: try the full row, and if the database says a
 * column is unknown, write the row without the optional half. The result is
 * that the migration becomes an enhancement — apply it and the extra columns
 * start recording, skip it and everything that worked before keeps working.
 *
 * The verdict is remembered per process so the doubled round trip is paid once
 * per serverless instance rather than on every pageview, and it is re-checked
 * from scratch after a deploy because module state does not survive one.
 */

export type InsertError = { code?: string | null; message?: string | null } | null;
export type InsertFn = (row: Record<string, unknown>) => Promise<{ error: InsertError }>;

/**
 * PostgREST reports an unknown column as PGRST204 with a "Could not find the
 * 'x' column" message; Postgres itself uses SQLSTATE 42703. Matching both
 * keeps this correct whichever layer rejects first, and matching *only* these
 * keeps a genuine failure — a dead connection, an RLS denial — from being
 * misread as a missing column and retried pointlessly.
 */
export function isUnknownColumnError(error: InsertError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST204" || code === "42703") return true;
  const message = String(error.message ?? "").toLowerCase();
  return /could not find the .* column|column .* does not exist/.test(message);
}

export type OptionalColumnInserter = (
  required: Record<string, unknown>,
  optional: Record<string, unknown>,
) => Promise<InsertError>;

export function createOptionalColumnInserter(insert: InsertFn): OptionalColumnInserter {
  // null = not yet known, true = present, false = absent.
  let optionalColumnsPresent: boolean | null = null;

  return async function insertWithOptionalColumns(required, optional) {
    if (optionalColumnsPresent !== false) {
      const { error } = await insert({ ...required, ...optional });
      if (!error) {
        optionalColumnsPresent = true;
        return null;
      }
      if (!isUnknownColumnError(error)) return error;
      optionalColumnsPresent = false;
    }

    const { error } = await insert(required);
    return error ?? null;
  };
}
