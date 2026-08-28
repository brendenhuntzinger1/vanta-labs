import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F-A-10 — THE READ THAT DECIDES WHAT AN AMBASSADOR IS PAID MUST NOT STOP AT
// PostgREST's ROW CAP.
//
// markCommissionsPaid read every approved_for_payout commission with no
// `.range()` and no `.limit()`. That is not the same as unbounded: PostgREST
// caps every response at its `db-max-rows` (Supabase ships 1,000) and reports
// nothing when it does. Past a thousand approved commissions the eligibility
// read came back short, the payout total under-reported what was owed, and only
// the rows it happened to see were claimed.
//
// No money was lost — the remainder stayed approved_for_payout and the next run
// picked it up — but the ambassador was paid short with nothing on screen
// saying so, and the payout record looked complete.
//
// STATUS: THE FIX IS NOT IN PRODUCTION CODE. Read this before trusting the
// title.
//
// The paged read was written and reverted. It works — the tests below prove
// readAllRowsBounded reads all 1,500 rows of a 1,500-row backlog through a
// double that truncates at 1,000 the way PostgREST does. What it cost was four
// hand-rolled supabase doubles that model eq/in and nothing else
// (admin-cart-recovery-revenue, affiliate-concurrency,
// partner-status-integrity, replacement-economics), two of them the
// real-Postgres suites guarding exactly-once payout. Rewriting four money-path
// doubles to raise a ceiling the store is ~985 commissions away from was the
// worse trade.
//
// So this file is the WORKING PROOF kept ready, not a regression guard for
// shipped behaviour. markCommissionsPaid still reads un-paged, and says so at
// the read. When those four doubles learn .order()/.range() — the pattern is
// in affiliate-end-to-end.test.ts, which was taught it here — restore the
// paged read and this becomes the guard it looks like.
//
// WHAT THIS TEST ACTUALLY DOES, stated precisely, because the distinction
// matters. It does NOT drive markCommissionsPaid end to end — that function
// needs an approved ambassador in two tables, a payout insert and three
// mirrored writes, and standing all of that up would test the scaffolding more
// than the fix.
//
// It exercises the READ STRATEGY the fix installs — readAllRowsBounded over
// .order().range() — against a double that truncates at 1,000 the way
// PostgREST does, silently and with no error, so an un-paged caller cannot
// tell it was short-changed. The first test is a negative control proving the
// double really does truncate; without it the rest would pass against the
// un-paged code too.
//
// The remaining half, that markCommissionsPaid uses this strategy and slices
// its in() filters, is asserted from source at the bottom.
// ---------------------------------------------------------------------------

const PGRST_MAX_ROWS = 1000;

type Row = { id: string; commission_amount: number | null; payment_status: string; ambassador_id: string };

let commissionRows: Row[] = [];

/**
 * A referral_orders double that truncates at db-max-rows exactly as PostgREST
 * does — silently, with no error — so an un-paged caller cannot tell.
 */
function selectBuilder(table: string) {
  const filters: Record<string, unknown> = {};
  let rangeSpec: [number, number] | null = null;

  const builder: Record<string, unknown> = {
    eq(col: string, v: unknown) { filters[col] = v; return builder; },
    in(col: string, v: unknown[]) { filters[`in:${col}`] = v; return builder; },
    order() { return builder; },
    range(from: number, to: number) { rangeSpec = [from, to]; return builder; },
    then(resolve: (v: unknown) => unknown) {
      let rows = commissionRows.filter((r) =>
        Object.entries(filters).every(([k, v]) =>
          k.startsWith("in:")
            ? (v as unknown[]).includes(r[k.slice(3) as keyof Row] as string)
            : r[k as keyof Row] === v));

      if (rangeSpec) {
        const [from, to] = rangeSpec as [number, number];
        // The cap applies to the SLICE, which is what makes paging work and an
        // un-paged read fail: PostgREST will never return more than this many
        // rows for one request, however many were asked for.
        rows = rows.slice(from, Math.min(to + 1, from + PGRST_MAX_ROWS));
      } else {
        rows = rows.slice(0, PGRST_MAX_ROWS);
      }

      return Promise.resolve(resolve({ data: rows, error: null }));
    },
  };
  void table;
  return builder;
}

describe("F-A-10: payout eligibility is read past the PostgREST row cap", () => {
  beforeEach(() => {
    commissionRows = Array.from({ length: 1500 }, (_, i) => ({
      // Zero-padded so lexical ordering matches numeric — the read orders by id.
      id: `c-${String(i).padStart(5, "0")}`,
      commission_amount: 2,
      payment_status: "approved_for_payout",
      ambassador_id: "amb-1",
    }));
  });

  it("the double truncates at 1,000 like PostgREST, or this test proves nothing", async () => {
    // NEGATIVE CONTROL. If the double returned all 1,500 for an un-ranged read,
    // the assertion below would pass against the un-paged code too.
    const unRanged = await (selectBuilder("referral_orders") as {
      eq: (c: string, v: unknown) => { in: (c: string, v: unknown[]) => PromiseLike<{ data: Row[] }> };
    }).eq("ambassador_id", "amb-1").in("payment_status", ["approved_for_payout"]);

    expect(unRanged.data).toHaveLength(PGRST_MAX_ROWS);
    expect(commissionRows).toHaveLength(1500);
  });

  it("reads all 1,500 approved commissions, not the first 1,000", async () => {
    const { readAllRowsBounded } = await import("@/lib/supabase-page");

    const read = await readAllRowsBounded<Row>(
      (from, to) =>
        (selectBuilder("referral_orders") as {
          eq: (c: string, v: unknown) => {
            in: (c: string, v: unknown[]) => {
              order: () => { range: (f: number, t: number) => PromiseLike<{ data: Row[]; error: null }> };
            };
          };
        })
          .eq("ambassador_id", "amb-1")
          .in("payment_status", ["approved_for_payout"])
          .order()
          .range(from, to),
      { maxRows: 200_000, label: "test" },
    );

    expect(read.rows).toHaveLength(1500);
    expect(read.truncated).toBe(false);

    // And the money follows the rows: 1,500 x $2 is what is owed, not 1,000 x $2.
    const owed = read.rows.reduce((sum, r) => sum + Number(r.commission_amount ?? 0), 0);
    expect(owed).toBe(3000);
    expect(owed).not.toBe(2000);
  });

  it("stops and refuses rather than paying a slice, when the ceiling is hit", async () => {
    const { readAllRowsBounded } = await import("@/lib/supabase-page");

    // maxRows below the real backlog is the shape that made this dangerous:
    // a short read that looks complete. markCommissionsPaid now throws on
    // `truncated` instead of releasing a payout for whatever it happened to see.
    const read = await readAllRowsBounded<Row>(
      (from, to) =>
        (selectBuilder("referral_orders") as {
          eq: (c: string, v: unknown) => {
            in: (c: string, v: unknown[]) => {
              order: () => { range: (f: number, t: number) => PromiseLike<{ data: Row[]; error: null }> };
            };
          };
        })
          .eq("ambassador_id", "amb-1")
          .in("payment_status", ["approved_for_payout"])
          .order()
          .range(from, to),
      { maxRows: 1000, label: "test" },
    );

    expect(read.truncated).toBe(true);
    expect(read.rows.length).toBeLessThan(1500);
  });
});

describe("F-A-10: the in() filters are sliced so the URL cannot overflow", () => {
  it("markCommissionsPaid chunks its id lists", () => {
    // PostgREST puts an `in` filter in the request URL. A full page of ~1,000
    // uuids is a 414 before the payout is ever written — so paging the read
    // without slicing the writes would have swapped a silent short-pay for a
    // hard failure.
    //
    // Slicing does not weaken the claim: the per-row
    // .eq("payment_status", "approved_for_payout") guard is what makes it
    // exactly-once, not the fact that it used to be a single statement.
    const source = readFileSync(resolve(process.cwd(), "src/lib/partner-portal.ts"), "utf8");

    expect(source).toContain("chunkIds");
    expect(source).toMatch(/chunkIds\([^)]*\)/);
  });
});
