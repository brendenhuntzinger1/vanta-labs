// ---------------------------------------------------------------------------
// A FAILED READ IS NOT A ZERO.
//
// Every admin page loaded its figures as `getSomething().catch(() => 0)` — or
// `=> []`, or `=> null`, or an object of zeroed money. The intent was sound: a
// dashboard should not 500 because one roll-up is unavailable. The consequence
// was not: the fallback is INDISTINGUISHABLE from the real answer.
//
//   Today's Revenue        $0.00 · 0 orders today
//   Net Profit · 30 days   $0.00
//   Reconciliation Flags   0
//   Sales tax              "No sales tax collected yet."
//   Reconciliation         "No inconsistencies found."
//
// Every one of those is what a healthy quiet store looks like, and every one of
// them is what a database outage looks like. The owner cannot tell which they
// are reading, so a broken admin reports an all-clear — on the exact screens
// they open to find out whether anything is wrong.
//
// So a read that fails is carried as a FAILURE, all the way to the pixel. The
// figure renders as "—" and the page says which reads did not answer. The page
// still renders; it just stops asserting things it does not know.
// ---------------------------------------------------------------------------

export type AdminRead<T> =
  | { ok: true; label: string; value: T }
  | { ok: false; label: string; value: null; error: string };

/**
 * Run a read and keep the outcome instead of collapsing it into a value.
 *
 * The label is what the operator is told did not load, so write it as a thing
 * on the screen ("Sales tax report"), not as a function name.
 */
export async function settleRead<T>(label: string, load: () => Promise<T>): Promise<AdminRead<T>> {
  try {
    return { ok: true, label, value: await load() };
  } catch (error) {
    return {
      ok: false,
      label,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The labels of the reads that did not answer. Empty means everything loaded. */
export function failedReads(reads: ReadonlyArray<AdminRead<unknown>>): string[] {
  return reads.filter((read) => !read.ok).map((read) => read.label);
}

/**
 * A figure, or an em dash when it could not be read.
 *
 * "—" and "$0.00" are the whole point of this module: one says "we do not
 * know", the other asserts that the answer is nothing.
 */
export const UNKNOWN_FIGURE = "—";

export function figure<T>(read: AdminRead<T>, render: (value: T) => string): string {
  return read.ok ? render(read.value) : UNKNOWN_FIGURE;
}
