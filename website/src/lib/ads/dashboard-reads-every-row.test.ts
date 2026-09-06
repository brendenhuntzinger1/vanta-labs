import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE DASHBOARD READ THE FIRST THOUSAND ROWS AND CALLED IT A TOTAL.
//
// PostgREST answers a select with at most db-max-rows (1000 on Supabase) and
// says so only in the Content-Range header, which supabase-js does not surface
// unless the caller asks for a count. So a read that outgrows the cap does not
// fail, does not warn, and returns a PREFIX.
//
// The cap is reachable at ordinary scale: ad_creative_roas_daily is one row per
// (platform, day, creative), so four platforms over a thirty-day window crosses
// 1000 at about nine creatives per platform. And the reads it truncates are
// exactly the ones whose SUM is displayed — untaggedSpend and
// unattributedRevenueTotal, the two figures that exist to state the size of the
// blind spot. A blind spot that reports itself as smaller than it is.
// ---------------------------------------------------------------------------

const pagesServed: Array<[number, number]> = [];
let totalRows = 0;

vi.mock("@/lib/supabase-server", () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {
      gte: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      range: (from: number, to: number) => {
        pagesServed.push([from, to]);
        const size = to - from + 1;
        const remaining = Math.max(0, totalRows - from);
        const count = Math.min(size, remaining);
        const rows = Array.from({ length: count }, (_, i) => ({ n: from + i }));
        return Promise.resolve({ data: rows, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return chain;
  };
  const client = { from: () => ({ select: () => makeChain() }) };
  return { supabaseAdmin: client, createServerClient: () => client };
});

describe("safeSelectAll pages until the rows run out", () => {
  it("returns everything past the 1000-row cap", async () => {
    pagesServed.length = 0;
    totalRows = 2500;
    const { safeSelectAll } = await import("./dashboard-data");
    const result = await safeSelectAll<{ n: number }>("ad_creative_roas_daily", "*");
    expect(result.rows).toHaveLength(2500);
    expect(result.truncated).toBe(false);
    expect(pagesServed).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("stops after ONE request when the first page is short", async () => {
    pagesServed.length = 0;
    totalRows = 12;
    const { safeSelectAll } = await import("./dashboard-data");
    const result = await safeSelectAll<{ n: number }>("ad_platform_daily", "*");
    expect(result.rows).toHaveLength(12);
    expect(pagesServed).toHaveLength(1);
  });

  it("handles an exactly-full final page without an infinite loop", async () => {
    pagesServed.length = 0;
    totalRows = 2000;
    const { safeSelectAll } = await import("./dashboard-data");
    const result = await safeSelectAll<{ n: number }>("ad_campaign_daily", "*");
    expect(result.rows).toHaveLength(2000);
    // Two full pages, then one empty page proves the end.
    expect(pagesServed).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("says so rather than under-reporting if the backstop is ever reached", async () => {
    pagesServed.length = 0;
    totalRows = 60_000;
    const { safeSelectAll } = await import("./dashboard-data");
    const result = await safeSelectAll<{ n: number }>("ad_creative_roas_daily", "*");
    expect(result.truncated, "a silent prefix is the whole defect").toBe(true);
    expect(result.rows).toHaveLength(50_000);
  });
});

describe("the ROAS dashboard uses the paged reader for every view it sums", () => {
  it("reads all five through safeSelectAll", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src/lib/ads/spend-dashboard.ts"), "utf8");
    for (const view of [
      "ad_platform_daily",
      "ad_campaign_daily",
      "ad_creative_roas_daily",
      "ad_spend_untagged",
      "ad_revenue_unattributed",
    ]) {
      expect(source, `${view} must be read through safeSelectAll`).toMatch(
        new RegExp(`safeSelectAll<[\\s\\S]{0,60}?>\\("${view}"`),
      );
    }
  });

  it("leaves the deliberately-limited freshness probe alone", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src/lib/ads/spend-dashboard.ts"), "utf8");
    // One row, newest first — paging it would be pointless work.
    expect(source).toMatch(/safeSelect<[\s\S]{0,60}?>\("ad_spend_daily", "ingested_at"/);
  });
});
