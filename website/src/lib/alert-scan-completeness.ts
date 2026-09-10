/**
 * WHETHER AN ALERT ACTUALLY READ THE POPULATION IT IS ABOUT.
 *
 * An alert that says "9 account(s) have been waiting" or "20 approved
 * ambassador(s) have never signed in" is making a claim about a POPULATION. It
 * is only true if the whole population was read. On 2026-09-09 and 09-10 three
 * alerts made such a claim from data that could not support it, and the worst
 * of them named twenty real people who were signing in perfectly well.
 *
 * WHY THIS IS A SHARED THING RATHER THAN A FIX IN TWO FILES.
 * commission-accrual-repair.ts had already solved it, and said why:
 *
 *     // The one condition under which this sweep can fail to SEE a missing
 *     // commission. Silent truncation is how the old `.limit()` scan hid the
 *     // backlog in the first place, so it is said out loud.
 *
 * That was right, and it stayed in that one file. Weeks later auth-health.ts
 * shipped the identical bug against a different table. A lesson learned once
 * and left local is a lesson the next file has to learn again, so this
 * generalises that pattern instead of inventing a second one — including its
 * vocabulary. `truncated` is the same word BoundedRead uses in supabase-page.ts,
 * with the same meaning: the read stopped before the source was exhausted.
 *
 * TWO WAYS TO SATISFY THE RULE, and callers pick per alert:
 *
 *   WITHHOLD — do not raise the alert at all when the finding could be an
 *   artefact of the short read. Right when truncation can MANUFACTURE the
 *   finding, as an empty user listing manufactured twenty lockouts.
 *
 *   LABEL — raise it, passing `scan`, and let the count be read as a floor.
 *   Right when the finding is real but possibly undercounted: every row that
 *   was read is still a genuine one, and an undercount is the safe direction.
 */

/**
 * How completely the alert's underlying scan read its source.
 *
 * Deliberately the same shape and word as `BoundedRead.truncated`, so a caller
 * holding a bounded read can pass it straight through with no translation.
 */
export interface ScanCompleteness {
  /** True when the read stopped before the source was exhausted. */
  truncated: boolean;
  /** How many rows were read, when the caller knows. Bounds the undercount. */
  scanned?: number;
}

/** The sentence appended to a counted claim built on a short read. */
const INCOMPLETE_MARKER = "This scan was incomplete";

/**
 * Rewrite a counted-population claim so it reads as a floor rather than a total.
 *
 * Returns the message untouched when the scan finished, or when no scan was
 * declared — the qualifier has to be free in the ordinary case or it becomes
 * noise on every alert, which is how a caveat stops being read.
 */
export function qualifyPopulationClaim(
  message: string,
  scan: ScanCompleteness | undefined,
): string {
  if (!scan?.truncated) return message;
  // Re-qualifying compounds the caveat and buries the finding under it.
  if (message.includes(INCOMPLETE_MARKER)) return message;

  const readSoFar = typeof scan.scanned === "number"
    ? `, having read ${scan.scanned}`
    : "";

  return `${message} ${INCOMPLETE_MARKER}${readSoFar} — treat the number above as AT LEAST that many, not as a total.`;
}

/**
 * The scan's completeness, shaped for an alert's `context`.
 *
 * Recorded even when the scan FINISHED, and that is the point: an alert with no
 * scan key at all leaves a reader unable to tell whether the author checked and
 * was satisfied or never thought about it. Writing both outcomes is what gives
 * the absence a meaning.
 */
export function describeScan(
  scan: ScanCompleteness | undefined,
): { scanTruncated: boolean; scanned?: number } | undefined {
  if (!scan) return undefined;
  return scan.scanned === undefined
    ? { scanTruncated: scan.truncated }
    : { scanTruncated: scan.truncated, scanned: scan.scanned };
}
