import { describe, expect, it } from "vitest";
import {
  aggregateCampaigns,
  aggregateCreatives,
  aggregatePlatforms,
  aggregateUnattributedRevenue,
  aggregateUntagged,
  ratios,
  totalParts,
} from "./spend-aggregate";

describe("every rate is recomputed from the summed parts, never averaged", () => {
  // THE CENTRAL ARITHMETIC CLAIM, pinned with the case that breaks the naive
  // version. Two days: one spent $1 and returned $10 (ROAS 10), the other spent
  // $999 and returned $99.90 (ROAS 0.1).
  //
  //   mean of the daily ROAS     = (10 + 0.1) / 2 = 5.05  -> "scale this"
  //   spend-weighted actual ROAS = 109.90 / 1000 = 0.1099 -> lost 89c on the dollar
  //
  // The averaged figure is wrong by a factor of ~46, in the flattering direction.
  it("does not let one cheap lucky day carry a period's ROAS", () => {
    const platforms = aggregatePlatforms([
      { platform: "tiktok", spend: 1, net_revenue: 10, orders: 1, impressions: 100, clicks: 10 },
      { platform: "tiktok", spend: 999, net_revenue: 99.9, orders: 1, impressions: 900, clicks: 10 },
    ]);
    expect(platforms).toHaveLength(1);
    expect(platforms[0].spend).toBe(1000);
    expect(platforms[0].revenue).toBeCloseTo(109.9, 5);
    expect(platforms[0].roas).toBeCloseTo(0.1099, 6);
    expect(platforms[0].roas).not.toBeCloseTo(5.05, 1);
  });

  it("weights CTR by impressions, not by day", () => {
    // 10/100 and 10/900 is 20/1000 = 2%, not (10% + 1.1%)/2 = 5.6%.
    const [row] = aggregatePlatforms([
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 100, clicks: 10 },
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 900, clicks: 10 },
    ]);
    expect(row.ctr).toBeCloseTo(0.02, 6);
  });

  it("computes all six rates from totals", () => {
    const r = ratios({ spend: 100, revenue: 250, orders: 5, impressions: 20000, clicks: 400 });
    expect(r.ctr).toBeCloseTo(400 / 20000, 9); // 2%
    expect(r.cpc).toBeCloseTo(100 / 400, 9); // $0.25
    expect(r.cpm).toBeCloseTo((100 / 20000) * 1000, 9); // $5.00
    expect(r.cvr).toBeCloseTo(5 / 400, 9); // 1.25%
    expect(r.cpa).toBeCloseTo(100 / 5, 9); // $20
    expect(r.roas).toBeCloseTo(250 / 100, 9); // 2.5
  });

  it("returns null rather than zero where the denominator is zero", () => {
    // A ratio with no denominator is unknown. Rendering it as 0.00 would read as
    // "this made nothing", a much stronger and different claim.
    expect(ratios({ spend: 0, revenue: 0, orders: 0, impressions: 0, clicks: 0 })).toEqual({
      ctr: null, cpc: null, cpm: null, cvr: null, cpa: null, roas: null,
    });
  });

  it("reports a real zero ROAS when spend exists and revenue does not", () => {
    // The other side of the rule: $50 spent and nothing earned is 0.00, which
    // must NOT be null — it is the most actionable number on the page.
    const r = ratios({ spend: 50, revenue: 0, orders: 0, impressions: 1000, clicks: 20 });
    expect(r.roas).toBe(0);
    expect(r.cvr).toBe(0);
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

describe("the platform's own conversion count stays separate from ours", () => {
  it("carries it through untouched and never into ROAS, CPA or CVR", () => {
    const [row] = aggregatePlatforms([
      // The platform claims 40 purchases. We recorded one order for $50.
      { platform: "facebook", spend: 100, net_revenue: 50, orders: 1, impressions: 1000, clicks: 100, platform_conversions: 40 },
    ]);
    expect(row.platformConversions).toBe(40);
    expect(row.orders).toBe(1);
    // All three derive from our one order.
    expect(row.cpa).toBe(100);
    expect(row.cvr).toBeCloseTo(0.01, 9);
    expect(row.roas).toBeCloseTo(0.5, 9);
  });

  it("keeps 'reported zero' distinct from 'not reported at all'", () => {
    // A platform with no pixel and a platform reporting zero purchases are
    // different facts, and the dashboard renders them differently.
    const [reportedZero] = aggregatePlatforms([
      { platform: "tiktok", spend: 1, net_revenue: 0, orders: 0, impressions: 1, clicks: 1, platform_conversions: 0 },
    ]);
    expect(reportedZero.platformConversions).toBe(0);

    const [notReported] = aggregatePlatforms([
      { platform: "tiktok", spend: 1, net_revenue: 0, orders: 0, impressions: 1, clicks: 1, platform_conversions: null },
    ]);
    expect(notReported.platformConversions).toBeNull();
  });

  it("sums reported counts across days while ignoring unreported ones", () => {
    const [row] = aggregatePlatforms([
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 1, clicks: 1, platform_conversions: 3 },
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 1, clicks: 1, platform_conversions: null },
      { platform: "reddit", spend: 1, net_revenue: 0, orders: 0, impressions: 1, clicks: 1, platform_conversions: 4 },
    ]);
    expect(row.platformConversions).toBe(7);
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

describe("aggregateCampaigns", () => {
  it("sums per (platform, utm_campaign) and ranks by spend", () => {
    const rows = aggregateCampaigns([
      { platform: "tiktok", utm_campaign: "launch", campaign_name: "Launch Q3", spend: 50, net_revenue: 100, orders: 2, impressions: 500, clicks: 25 },
      { platform: "tiktok", utm_campaign: "launch", campaign_name: "Launch Q3", spend: 50, net_revenue: 50, orders: 1, impressions: 500, clicks: 25 },
      { platform: "tiktok", utm_campaign: "retarget", spend: 200, net_revenue: 100, orders: 1, impressions: 100, clicks: 10 },
    ]);
    expect(rows.map((r) => r.utmCampaign)).toEqual(["retarget", "launch"]);
    expect(rows[1]).toMatchObject({ spend: 100, revenue: 150, orders: 3 });
    expect(rows[1].roas).toBeCloseTo(1.5, 9);
  });

  it("keeps the same campaign tag separate per platform", () => {
    const rows = aggregateCampaigns([
      { platform: "tiktok", utm_campaign: "launch", spend: 10, net_revenue: 100, orders: 1, impressions: 10, clicks: 5 },
      { platform: "reddit", utm_campaign: "launch", spend: 10, net_revenue: 0, orders: 0, impressions: 10, clicks: 5 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.platform === "tiktok")?.roas).toBe(10);
    expect(rows.find((r) => r.platform === "reddit")?.roas).toBe(0);
  });

  it("ignores rows with no campaign tag", () => {
    expect(aggregateCampaigns([{ platform: "reddit", utm_campaign: null, spend: 10 }])).toEqual([]);
  });
});

describe("aggregateCreatives", () => {
  it("sums per creative and ranks by ROAS", () => {
    const rows = aggregateCreatives([
      { platform: "tiktok", utm_content: "hook_a", ad_name: "A", spend: 50, net_revenue: 200, orders: 4, clicks: 20, ads: 1 },
      { platform: "tiktok", utm_content: "hook_b", ad_name: "B", spend: 50, net_revenue: 25, orders: 1, clicks: 20, ads: 1 },
      { platform: "tiktok", utm_content: "hook_a", ad_name: "A", spend: 50, net_revenue: 100, orders: 2, clicks: 20, ads: 1 },
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
      { platform: "tiktok", utm_content: "hook_a", spend: 10, net_revenue: 100, orders: 2, clicks: 5, ads: 1 },
      { platform: "facebook", utm_content: "hook_a", spend: 10, net_revenue: 1, orders: 0, clicks: 5, ads: 1 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform)).toEqual(["tiktok", "facebook"]);
    expect(rows[0].roas).toBe(10);
    expect(rows[1].roas).toBeCloseTo(0.1, 6);
  });

  it("counts distinct ads sharing a tag without multiplying across days", () => {
    // Three ads carrying one tag, seen on two days, is three ads — not six.
    const rows = aggregateCreatives([
      { platform: "tiktok", utm_content: "hook_a", spend: 10, net_revenue: 0, orders: 0, clicks: 1, ads: 3 },
      { platform: "tiktok", utm_content: "hook_a", spend: 10, net_revenue: 0, orders: 0, clicks: 1, ads: 3 },
    ]);
    expect(rows[0].ads).toBe(3);
    expect(rows[0].spend).toBe(20);
  });

  it("excludes creatives that never spent, so untested work is not a 'winner'", () => {
    const rows = aggregateCreatives([
      { platform: "tiktok", utm_content: "spent", spend: 10, net_revenue: 5, orders: 1, clicks: 1, ads: 1 },
      { platform: "tiktok", utm_content: "never_spent", spend: 0, net_revenue: 0, orders: 0, clicks: 0, ads: 1 },
    ]);
    expect(rows.map((r) => r.utmContent)).toEqual(["spent"]);
  });

  it("ignores rows with no creative tag", () => {
    expect(aggregateCreatives([{ platform: "reddit", utm_content: null, spend: 10 }])).toEqual([]);
  });
});

describe("the blind spots", () => {
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

  it("sums revenue that names a platform but no creative", () => {
    const rows = aggregateUnattributedRevenue([
      { platform: "snapchat", utm_campaign: "launch", orders: 1, net_revenue: 90 },
      { platform: "snapchat", utm_campaign: "launch", orders: 2, net_revenue: 110 },
      { platform: "reddit", utm_campaign: null, orders: 1, net_revenue: 300 },
    ]);
    expect(rows[0]).toMatchObject({ platform: "reddit", revenue: 300 });
    expect(rows[1]).toMatchObject({ platform: "snapchat", orders: 3, revenue: 200 });
  });
});
