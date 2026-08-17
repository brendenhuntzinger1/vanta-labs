import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readAllRows } from "@/lib/supabase-page";

// ---------------------------------------------------------------------------
// PostgREST caps a single response at max-rows (1000 on Supabase) and says
// nothing about it — the array is valid, it just stops. The local test rig's
// stand-in imposes no such cap, so this behaviour is UNREACHABLE end to end
// here: an integration test would pass against the shim whether the paging
// exists or not. These tests simulate the cap directly, which is the only way
// to prove the loop actually keeps going.
//
// The case that matters most is the suppression list. A truncated read does not
// error; it silently stops naming people who unsubscribed, and the next
// campaign mails them.
// ---------------------------------------------------------------------------

/** A fake table of `total` rows that never returns more than 1000 at a time. */
function cappedTable(total: number) {
  const calls: Array<[number, number]> = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const size = Math.min(to - from + 1, 1000);
    const rows = [];
    for (let i = from; i < Math.min(from + size, total); i++) rows.push({ email: `person${i}@example.com` });
    return Promise.resolve({ data: rows, error: null });
  };
  return { page, calls };
}

describe("readAllRows keeps going past the server's row cap", () => {
  it("returns everything when the table fits in one page", async () => {
    const { page, calls } = cappedTable(42);
    const rows = await readAllRows(page);
    expect(rows).toHaveLength(42);
    expect(calls).toHaveLength(1);
  });

  it("returns everything when the table is EXACTLY one page", async () => {
    // The boundary that a naive "stop when empty" loop gets wrong in the other
    // direction: 1000 rows is a full page, so it must ask once more.
    const { page, calls } = cappedTable(1000);
    const rows = await readAllRows(page);
    expect(rows).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it("returns all 2,500 rows across three requests — the case an unpaged read truncates to 1,000", async () => {
    const { page, calls } = cappedTable(2500);
    const rows = await readAllRows(page);
    expect(rows).toHaveLength(2500);
    expect(calls).toHaveLength(3);
    // No gaps and no repeats: every row appears exactly once.
    expect(new Set(rows.map((r) => (r as { email: string }).email)).size).toBe(2500);
  });

  it("asks for contiguous, non-overlapping ranges", async () => {
    const { page, calls } = cappedTable(2500);
    await readAllRows(page);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("handles an empty table without a second request", async () => {
    const { page, calls } = cappedTable(0);
    expect(await readAllRows(page)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("errors are surfaced, never turned into a short result", () => {
  it("throws rather than returning a partial list", async () => {
    // A swallowed error would return fewer rows and look like success — which
    // for a suppression list means quietly mailing people who unsubscribed.
    const page = vi.fn().mockResolvedValue({ data: null, error: new Error("connection lost") });
    await expect(readAllRows(page)).rejects.toThrow("connection lost");
  });

  it("throws even after some pages succeeded", async () => {
    let call = 0;
    const page = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null });
      return Promise.resolve({ data: null, error: new Error("timeout") });
    });
    await expect(readAllRows(page)).rejects.toThrow("timeout");
  });
});

describe("it cannot loop forever", () => {
  it("stops if a server ignores the range and always returns a full page", async () => {
    const page = vi.fn().mockResolvedValue({
      data: Array.from({ length: 1000 }, (_, i) => ({ i })),
      error: null,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await readAllRows(page);
    expect(rows.length).toBe(1000 * 1000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
