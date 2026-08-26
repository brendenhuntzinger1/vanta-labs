import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readAllRowsBounded } from "@/lib/supabase-page";

// ---------------------------------------------------------------------------
// BLOCK F — the bounded paged read the financial surfaces use.
//
// readAllRows (same module) stops when a page comes back shorter than its page
// size, which is sound while Supabase's max-rows is exactly 1000. This variant
// cannot rely on that, because its callers produce filing figures and lifetime
// totals: a report that is quietly short is worse than one that says it is.
//
// Everything here is about the difference between "short" and "empty".
// ---------------------------------------------------------------------------

/**
 * A table of `total` rows behind a server that returns at most `cap` rows in
 * any single response — PostgREST's db-max-rows.
 */
function source(total: number, cap: number | null = null) {
  const calls: Array<[number, number]> = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const wanted = Math.max(0, Math.min(to - from + 1, total - from));
    const size = cap === null ? wanted : Math.min(wanted, cap);
    return Promise.resolve({
      data: Array.from({ length: Math.max(0, size) }, (_, i) => ({ n: from + i })),
      error: null,
    });
  };
  return { page, calls };
}

const ids = (rows: Array<{ n: number }>) => rows.map((r) => r.n);

describe("readAllRowsBounded — short pages are not the end", () => {
  it("returns every row when the source caps responses BELOW the page size", async () => {
    // The case readAllRows gets wrong: a cap of 250 makes every page short, so
    // a stop-on-short loop would return 250 of 2,500.
    const { page } = source(2500, 250);
    const { rows, truncated } = await readAllRowsBounded(page, { maxRows: 100_000 });

    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(false);
    // No gaps and no repeats — the offset followed the rows received, not the
    // page size, so nothing between the cap and the page size was skipped.
    expect(new Set(ids(rows)).size).toBe(2500);
    expect(Math.min(...ids(rows))).toBe(0);
    expect(Math.max(...ids(rows))).toBe(2499);
  });

  it("survives a cap that is not a multiple of the page size", async () => {
    const { page } = source(2500, 337);
    const { rows } = await readAllRowsBounded(page, { maxRows: 100_000 });
    expect(new Set(ids(rows)).size).toBe(2500);
  });

  it("costs one extra request to prove it reached the end, and strides by rows received", async () => {
    const { page, calls } = source(2500);
    await readAllRowsBounded(page, { maxRows: 100_000 });

    // Three pages, then the empty one that ends it. Note the FOURTH request
    // starts at 2500, not 3000: the third page returned 500 rows, so the offset
    // advanced by 500. A fixed page-size stride would have asked from 3000 and
    // skipped nothing here — but under a source cap it would skip exactly the
    // rows the cap held back, which is the bug this stride exists to avoid.
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2500, 3499]]);
  });

  it("reports truncation when the ceiling stops it short", async () => {
    const { rows, truncated } = await readAllRowsBounded(source(2500).page, { maxRows: 1000 });
    expect(rows).toHaveLength(1000);
    expect(truncated).toBe(true);
  });

  it("does not claim truncation when the ceiling lands exactly on the last row", async () => {
    // 2,500 rows and a ceiling of 2,500: the probe finds nothing, so the answer
    // is complete. Reporting it as truncated would cry wolf on every report
    // that happens to fit.
    const { rows, truncated } = await readAllRowsBounded(source(2500).page, { maxRows: 2500 });
    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(false);
  });

  it("handles an empty table in one request", async () => {
    const { page, calls } = source(0);
    const { rows, truncated } = await readAllRowsBounded(page, { maxRows: 100_000 });
    expect(rows).toEqual([]);
    expect(truncated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("throws on a page error rather than returning a short result", async () => {
    // A swallowed error would look exactly like a small store.
    const page = vi.fn().mockResolvedValue({ data: null, error: new Error("connection lost") });
    await expect(readAllRowsBounded(page, { maxRows: 10, label: "profit read" }))
      .rejects.toThrow("profit read failed: connection lost");
  });

  it("throws even after some pages have already succeeded", async () => {
    let call = 0;
    const page = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ n: i })), error: null });
      return Promise.resolve({ data: null, error: new Error("timeout") });
    });
    await expect(readAllRowsBounded(page, { maxRows: 100_000 })).rejects.toThrow("timeout");
  });

  it("cannot loop forever against a source that ignores the range", async () => {
    // maxRows is the backstop: a server replying with a full page every time
    // stops at the ceiling instead of running until memory gives out.
    const page = vi.fn().mockResolvedValue({
      data: Array.from({ length: 1000 }, (_, i) => ({ n: i })),
      error: null,
    });
    const { rows, truncated } = await readAllRowsBounded(page, { maxRows: 5000 });
    expect(rows).toHaveLength(5000);
    expect(truncated).toBe(true);
  });
});
