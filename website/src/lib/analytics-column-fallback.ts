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
 * column is unknown, drop THAT column and retry. The result is that each
 * migration becomes an independent enhancement — apply one and its columns
 * start recording, regardless of whether a different, unrelated optional
 * migration has been applied yet.
 *
 * PER-COLUMN, NOT PER-CALL. This used to track one present/absent flag for
 * the whole `optional` object, so two unrelated features sharing one call
 * (e.g. the creative-attribution columns and the live-visitor-tracker
 * columns added later) were coupled by accident: a database missing EITHER
 * one's columns silently dropped BOTH, including the one that would have
 * written fine on its own. Caught on the local harness, which — like any
 * database that has had migrations applied out of order — genuinely had
 * one set but not the other. Each column's presence is now remembered
 * independently, so the columns of a migration that HAS been applied keep
 * recording even while a different, unrelated one hasn't been.
 *
 * The verdict for each column is remembered per process so the extra round
 * trip is paid once per unknown column per serverless instance rather than on
 * every pageview, and it is re-checked from scratch after a deploy because
 * module state does not survive one.
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

/**
 * Which of the given candidate column names the error is complaining about.
 *
 * Both error shapes quote the column name — PostgREST with single quotes
 * ("Could not find the 'ttclid' column"), Postgres with double quotes
 * ('column "ttclid" does not exist", inside which a QUOTED TABLE NAME often
 * also appears — 'of relation "website_analytics_events"'). So this cannot
 * just take the first quoted token: it has to be one that is actually a
 * candidate we sent, or a table name always "wins" and nothing ever narrows.
 */
function extractUnknownColumnName(error: InsertError, candidates: readonly string[]): string | null {
  const message = String(error?.message ?? "");
  const quoted = [...message.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map((match) => match[1]);
  return quoted.find((name) => candidates.includes(name)) ?? null;
}

export function createOptionalColumnInserter(insert: InsertFn): OptionalColumnInserter {
  // Per-column, not per-call — see the header comment above for why.
  const knownAbsent = new Set<string>();

  return async function insertWithOptionalColumns(required, optional) {
    let candidate = Object.fromEntries(
      Object.entries(optional).filter(([key]) => !knownAbsent.has(key)),
    );

    // Bounded: each iteration either returns or removes exactly one column
    // from `candidate`, so this runs at most Object.keys(optional).length + 1
    // times even if every optional column turns out to be unknown.
    for (;;) {
      const { error } = await insert({ ...required, ...candidate });
      if (!error) {
        return null;
      }
      if (!isUnknownColumnError(error)) {
        return error;
      }

      const badColumn = extractUnknownColumnName(error, Object.keys(candidate));
      if (!badColumn) {
        // Couldn't attribute the error to one of our candidate columns —
        // fail safe rather than loop on an error we can't narrow: drop
        // everything optional, exactly like the previous all-or-nothing
        // behaviour, and stop.
        for (const key of Object.keys(candidate)) knownAbsent.add(key);
        const { error: fallbackError } = await insert(required);
        return fallbackError ?? null;
      }

      knownAbsent.add(badColumn);
      const { [badColumn]: _dropped, ...rest } = candidate;
      candidate = rest;
    }
  };
}
