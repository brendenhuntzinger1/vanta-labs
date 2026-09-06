import { describe, expect, it } from "vitest";
import {
  aggregateCreatives,
  aggregatePlatforms,
  aggregateUntagged,
  ratios,
  totalParts,
} from "./spend-aggregate";

describe("ratios are recomputed from the summed parts, never averaged", () => {
  // THE CENTRAL ARITHMETIC CLAIM OF THIS FILE, pinned with the case that breaks
  // the naive version. Two days: one spent $1 and returned $10 (ROAS 10), the
  // other spent $999 and returned $99.90 (ROAS 0.1).
  //
  // Mean of the daily ROAS      = (10 + 0.1) / 2 = 5.05  -> "scale this"
  // Spend-weighted actual ROAS  = 109.90 / 1000 = 0.1099 -> lost 89 cents on the dollar
  //
  // The averaged figure is off by a factor of ~46 in the flattering direction.
  it("does not let one cheap lucky day carry a period's ROAS", () => {
    const platforms = aggregatePlatforms([
      { platform: "tiktok", stat_date: "2026-09-01", spend: 1, net_revenue: 10, orders: 1, impressions: 100, clicks: 10 },
      { platform: "tiktok", stat_date: "2026-09-02", spend: 999, net_revenue: 99.9, orders: 1, impressions: 900, clicks: 10 },
    ]);
    expect(platforms).toHaveLength(1);
    expect(platforms[0].spend).toBe(1000);
    expect(platforms[0].revenue).toBeCloseTo(109.9, 5);
    expect(platforms[0].roas).toBeCloseTo(0.1099, 6);
    expect(platforms[0].roas).not.toBeCloseTo(5.05, 1);
  });

  it("weights CTR by impressions, not by day", () => {
    // 10/100 on one day and 10/900 on another is 20/1000 = 2%, not (10% + 1.1%)/2.
    const [row] = aggregatePlatforms([
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 100, clicks: 10 },
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 900, clicks: 10 },
    ]);
    expect(row.ctr).toBeCloseTo(0.02, 6);
  });

  it("returns null rather than zero where the denominator is zero", () => {
    // A ratio with no denominator is unknown. Rendering it as 0.00 would read as
    // "this made nothing", which is a different and much stronger claim.
    expect(ratios({ spend: 0, revenue: 0, orders: 0, impressions: 0, clicks: 0 })).toEqual({
      ctr: null,
      cpa: null,
      roas: null,
    });
  });

  it("reports a real zero ROAS when spend exists and revenue does not", () => {
    // The other side of the rule above: $50 spent and nothing earned is 0.00,
    // which must NOT be null — it is the most actionable number on the page.
    const r = ratios({ spend: 50, revenue: 0, orders: 0, impressions: 1000, clicks: 20 });
    expect(r.roas).toBe(0);
    expect(r.cpa).toBeNull();
  });
});

describe("aggregatePlatforms", () => {
  it("sums each platform separately and ranks by spend", () => {
    const rows = aggregatePlatforms([
      { platform: "facebook", spend: 10, net_revenue: 5, orders: 1, impressions: 100, clicks: 5 },
      { platform: "tiktok", spend: 100, net_revenue: 400, orders: 8, impressions: 900, clicks: 40 },
      { platform: "facebook", spend: 10, net_revenue: 5, orders: 1, impressions: 100, clicks: 5 },
    ]);
    expect(rows.map((r) => r.platform)).toEqual(["tiktok", "facebook"]);
    expect(rows[1]).toMatchObject({ spend: 20, revenue: 10, orders: 2 });
    expect(rows[0].roas).toBe(4);
  });

  it("treats a missing platform as 'unknown' rather than dropping the spend", () => {
    // Losing a row would understate total spend, which flatters overall ROAS.
    const rows = aggregatePlatforms([{ spend: 25, net_revenue: 0, orders: 0, impressions: 0, clicks: 0 }]);
    expect(rows[0].platform).toBe("unknown");
    expect(rows[0].spend).toBe(25);
  });

  it("survives nulls and unparseable numbers without producing NaN", () => {
    const rows = aggregatePlatforms([
      { platform: "snapchat", spend: null, net_revenue: "abc", orders: undefined, impressions: "12", clicks: null },
    ]);
    expect(rows[0].spend).toBe(0);
    expect(rows[0].revenue).toBe(0);
    expect(rows[0].impressions).toBe(12);
    expect(Number.isNaN(rows[0].spend)).toBe(false);
  });

  it("returns nothing for no rows", () => {
    expect(aggregatePlatforms([])).toEqual([]);
    expect(totalParts([])).toEqual({ spend: 0, revenue: 0, orders: 0, impressions: 0, clicks: 0 });
  });
});

describe("totalParts", () => {
  it("sums across platforms so the total ROAS is spend-weighted too", () => {
    const platforms = aggregatePlatforms([
      { platform: "tiktok", spend: 900, net_revenue: 90, orders: 2, impressions: 1000, clicks: 50 },
      { platform: "facebook", spend: 100, net_revenue: 500, orders: 10, impressions: 500, clicks: 50 },
    ]);
    const parts = totalParts(platforms);
    expect(parts.spend).toBe(1000);
    expect(parts.revenue).toBe(590);
    // 590/1000, not the mean of 0.1 and 5.
    expect(ratios(parts).roas).toBeCloseTo(0.59, 6);
    expect(ratios(parts).cpa).toBeCloseTo(1000 / 12, 6);
  });
});

describe("aggregateCreatives", () => {
  it("sums per creative and ranks by ROAS", () => {
    const rows = aggregateCreatives([
      { platform: "tiktok", utm_content: "hook_a", ad_name: "A", spend: 50, net_revenue: 200, orders: 4, clicks: 20 },
      { platform: "tiktok", utm_content: "hook_b", ad_name: "B", spend: 50, net_revenue: 25, orders: 1, clicks: 20 },
      { platform: "tiktok", utm_content: "hook_a", ad_name: "A", spend: 50, net_revenue: 100, orders: 2, clicks: 20 },
    ]);
    expect(rows.map((r) => r.utmContent)).toEqual(["hook_a", "hook_b"]);
    expect(rows[0]).toMatchObject({ spend: 100, revenue: 300, orders: 6 });
    expect(rows[0].roas).toBe(3);
    expect(rows[0].cpa).toBeCloseTo(100 / 6, 6);
  });

  it("keeps the same creative separate per platform", () => {
    // Merging them would hide that a hook works on one platform and not the
    // other, which is the comparison most worth having.
    const rows = aggregateCreatives([
      { platform: "tiktok", utm_content: "hook_a", spend: 10, net_revenue: 100, orders: 2, clicks: 5 },
      { platform: "facebook", utm_content: "hook_a", spend: 10, net_revenue: 1, orders: 0, clicks: 5 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform)).toEqual(["tiktok", "facebook"]);
    expect(rows[0].roas).toBe(10);
    expect(rows[1].roas).toBeCloseTo(0.1, 6);
  });

  it("excludes creatives that never spent, so untested work is not a 'winner'", () => {
    const rows = aggregateCreatives([
      { platform: "tiktok", utm_content: "spent", spend: 10, net_revenue: 5, orders: 1, clicks: 1 },
      { platform: "tiktok", utm_content: "never_spent", spend: 0, net_revenue: 0, orders: 0, clicks: 0 },
    ]);
    expect(rows.map((r) => r.utmContent)).toEqual(["spent"]);
  });

  it("ignores rows with no creative tag", () => {
    expect(aggregateCreatives([{ platform: "reddit", utm_content: null, spend: 10 }])).toEqual([]);
  });
});

describe("aggregateUntagged", () => {
  it("sums an ad's untagged spend across days and ranks by size", () => {
    const rows = aggregateUntagged([
      { platform: "reddit", ad_id: "r1", ad_name: "Ad One", spend: 5, reason: "no_landing_url_from_platform" },
      { platform: "reddit", ad_id: "r1", ad_name: "Ad One", spend: 7, reason: "no_landing_url_from_platform" },
      { platform: "snapchat", ad_id: "s1", spend: 20, reason: "no_landing_url_from_platform" },
    ]);
    expect(rows.map((r) => r.adId)).toEqual(["s1", "r1"]);
    expect(rows[1].spend).toBe(12);
  });

  it("carries the reason through, because the fix differs per reason", () => {
    const [row] = aggregateUntagged([
      { platform: "tiktok", ad_id: "t1", spend: 1, reason: "landing_url_carries_no_utm_content" },
    ]);
    expect(row.reason).toBe("landing_url_carries_no_utm_content");
  });
});
