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
