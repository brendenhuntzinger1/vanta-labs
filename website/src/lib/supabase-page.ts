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

export async function readAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];

  for (let index = 0; index < MAX_PAGES; index++) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    // Surfacing the error is the caller's job — some callers must fail loudly
    // (an audience read that silently returns fewer people is the bug this
    // module exists to prevent), so the error is rethrown rather than swallowed
    // into a short result that looks like a complete one.
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }

  console.warn(`readAllRows: stopped at ${MAX_PAGES} pages; the result may be incomplete.`);
  return all;
}

// ---------------------------------------------------------------------------
// A BOUNDED VARIANT, FOR READS THAT MUST REPORT BEING INCOMPLETE.
//
// readAllRows above stops when a page comes back shorter than PAGE_SIZE, and
// its docblock is explicit about why that is sound: the page size is set equal
// to Supabase's default cap, so "short means finished".
//
// That reasoning holds exactly as long as the cap IS 1000. It is a project API
// setting, this module cannot observe it, and if it is ever set BELOW the page
// size then every page arrives short and the loop stops on the first one —
// returning one page of an arbitrarily large table, silently. Its fixed stride
// compounds that: the next request would start a full PAGE_SIZE on, skipping
// whatever the cap held back.
//
// The financial-reporting surfaces cannot accept either behaviour, because
// their output is a filing figure or a lifetime total. So this variant:
//
//   * stops only on an EMPTY page, never a short one;
//   * advances by the rows actually RECEIVED, so a capped page is resumed
//     rather than skipped;
//   * bounds memory with maxRows and REPORTS reaching it, instead of returning
//     a smaller number as though it were the answer.
//
// The cost is one extra request per read. Two functions rather than one is
// deliberate: readAllRows' callers were written against its contract, and
// changing termination semantics underneath them is not this block's call.
// See docs/findings/BLOCK-F.md finding F-19.
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
