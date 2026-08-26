import "server-only";

/**
 * Read every row of a query, a page at a time.
 *
 * PostgREST caps how many rows a single request returns — Supabase ships with
 * `max-rows=1000` — and it does so SILENTLY. There is no error and no flag; the
 * response is a valid array that simply stops. Any `select` expected to return
 * "all of them" is therefore correct right up to the moment the table crosses
 * the cap, and quietly wrong forever after.
 *
 * That is a nasty failure mode anywhere, and a dangerous one for a suppression
 * list: a truncated read of `email_suppressions` does not fail, it just stops
 * mentioning some of the people who unsubscribed, and the next campaign mails
 * them. The same shape truncates an audience (subscribers silently dropped) and
 * a metrics roll-up (numbers that look plausible and are too low).
 *
 * THIS CANNOT BE CAUGHT BY THE LOCAL TEST RIG, whose PostgREST stand-in imposes
 * no cap at all — so a test would pass against the shim and the bug would only
 * appear against real Supabase, at whatever scale crosses 1000. It is handled
 * by construction for that reason rather than left to a test to notice.
 *
 * The page size is deliberately equal to the default cap: asking for exactly
 * what the server is willing to give makes "a short page means the end" true.
 */
const PAGE_SIZE = 1000;

/** Guard against an unbounded loop if a server ever ignores `range`. */
const MAX_PAGES = 1000;

// ---------------------------------------------------------------------------
// ONE PAGER, AND WHY THE OTHER ONE IS GONE.
//
// There used to be a second helper here, `readAllRows`, which stopped as soon as
// a page came back shorter than PAGE_SIZE. Its docblock argued that was sound
// because the page size equals Supabase's default cap, so "short means finished".
//
// That reasoning holds exactly as long as the cap IS 1000. It is a project API
// setting, this module cannot observe it, and if it were ever set BELOW the page
// size then every page arrives short, the loop stops on the first one, and an
// arbitrarily large table is read as one page — silently. The fixed stride
// compounded it: the next request started a full PAGE_SIZE on, skipping whatever
// the cap had held back.
//
// Block F recorded that as F-19 and left both functions in place, because
// changing termination semantics under another block's callers was not its call.
// It IS this block's call, the callers have been moved, and a helper with a
// silent-truncation mode sitting next to one without it is an invitation. The
// last five callers were an audience read, a broadcast recipient list and a
// SUPPRESSION list — where a short read does not fail, it just stops mentioning
// some of the people who unsubscribed, and the next campaign mails them.
//
// So there is one pager, and it:
//
//   * stops only on an EMPTY page, never a short one;
//   * advances by the rows actually RECEIVED, so a capped page is resumed
//     rather than skipped;
//   * bounds memory with maxRows and REPORTS reaching it, instead of returning
//     a smaller number as though it were the answer.
//
// The cost is one extra request per read.
// ---------------------------------------------------------------------------

export interface BoundedRead<T> {
  rows: T[];
  /** True when `maxRows` stopped the read before the source was exhausted. */
  truncated: boolean;
}

export async function readAllRowsBounded<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  options: { maxRows: number; pageSize?: number; label?: string },
): Promise<BoundedRead<T>> {
  const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE);
  const rows: T[] = [];
  let from = 0;

  const fetchPage = async (start: number, end: number) => {
    const { data, error } = await page(start, end);
    if (error) {
      const message = (error as { message?: string })?.message ?? String(error);
      throw new Error(`${options.label ?? "paged read"} failed: ${message}`);
    }
    return data ?? [];
  };

  while (rows.length < options.maxRows) {
    const want = Math.min(pageSize, options.maxRows - rows.length);
    const batch = await fetchPage(from, from + want - 1);
    if (batch.length === 0) return { rows, truncated: false };
    rows.push(...batch);
    from += batch.length;
  }

  // At the ceiling. One more row settles whether anything was left behind, so
  // `truncated` is observed rather than assumed.
  const probe = await fetchPage(from, from);
  return { rows, truncated: probe.length > 0 };
}
