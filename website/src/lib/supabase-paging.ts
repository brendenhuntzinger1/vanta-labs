import "server-only";

// Reading a whole table through PostgREST, without lying about it.
//
// Every financial-reporting surface used to read its orders with a single
// `.limit(N)` — 2,000 on reconciliation, 10,000 on the revenue fallback,
// 20,000 on the profit dashboard, and one select with no bound at all. All four
// share the same failure: when the store outgrows the number, the read comes
// back short and the report is computed from the short read. No error, no flag,
// no way for the operator to tell an under-reported total from a real one.
//
// Two rules make that impossible here:
//
//   1. PAGE UNTIL THE SOURCE RETURNS NOTHING. Not "until a page comes back
//      shorter than requested" — PostgREST's `db-max-rows` (Supabase's "Max
//      rows" setting) caps EVERY response, so under a cap below the page size
//      every page is short and a short-page test stops on the first one. The
//      offset advances by the rows actually received, so a capped page is
//      resumed rather than skipped.
//
//   2. WHEN THE CEILING IS REACHED, SAY SO. `maxRows` exists to bound memory,
//      not to define the answer. Hitting it sets `truncated`, and the callers
//      surface that to the operator instead of quietly reporting a smaller
//      number.

export interface PageResponse<T> {
  data: T[] | null;
  error: { message?: string } | null;
}

export interface PagedRead<T> {
  rows: T[];
  /** True when `maxRows` stopped the read before the source was exhausted. */
  truncated: boolean;
}

/** PostgREST's own default page size, and Supabase's default max-rows. */
export const DEFAULT_PAGE_SIZE = 1000;

export async function readAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResponse<T>>,
  options: { maxRows: number; pageSize?: number; label?: string },
): Promise<PagedRead<T>> {
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const rows: T[] = [];
  let from = 0;

  while (rows.length < options.maxRows) {
    const want = Math.min(pageSize, options.maxRows - rows.length);
    const { data, error } = await fetchPage(from, from + want - 1);
    if (error) throw new Error(`${options.label ?? "paged read"} failed: ${error.message ?? "unknown error"}`);
    const batch = data ?? [];
    if (batch.length === 0) return { rows, truncated: false };
    rows.push(...batch);
    from += batch.length;
  }

  // At the ceiling. One more row settles whether anything was left behind, so
  // `truncated` is observed rather than assumed.
  const { data: probe, error: probeError } = await fetchPage(from, from);
  if (probeError) throw new Error(`${options.label ?? "paged read"} failed: ${probeError.message ?? "unknown error"}`);
  return { rows, truncated: (probe ?? []).length > 0 };
}
