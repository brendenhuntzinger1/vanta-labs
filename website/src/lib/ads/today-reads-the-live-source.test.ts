import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE "TODAY" STRIP READ THE TABLE THAT CAN NEVER HOLD A ROW.
//
// PR #161 created ad_spend_daily for a stated reason: "ad_performance_daily
// could never hold a row: its creative_id foreign key requires a creative
// designed inside this system, and no ad running on the four live platforms has
// one. Spend had nowhere to land, so every ROAS panel was structurally empty
// rather than reporting zero."
//
// Every panel was repointed at the new table except one. The Today strip went
// on reading ad_performance_daily, so it showed
//
//     SPEND $0.00   REVENUE $0.00   PURCHASES 0   CPA —   ROAS —
//
// for ever, directly above a thirty-day panel reporting real money, on a page
// whose own copy promises "an empty panel means no data, never a guess".
//
// Measured against the harness: $573.45 of spend seeded across five days
// INCLUDING today, and the strip read $0.00. After the fix it reads $213.45 —
// today's share — with revenue $800.00, 4 purchases, CPA $53.36 and ROAS 3.75,
// each of which checks out by hand.
// ---------------------------------------------------------------------------

const rows = [
  // today
  { platform: "facebook", stat_date: "2026-09-06", spend: 30, impressions: 3000, clicks: 60, orders: 4, net_revenue: 800 },
  { platform: "tiktok", stat_date: "2026-09-06", spend: 30, impressions: 3000, clicks: 60, orders: 0, net_revenue: 0 },
  { platform: "snapchat", stat_date: "2026-09-06", spend: 153.45, impressions: 5000, clicks: 60, orders: 0, net_revenue: 0 },
  // earlier in the window — must NOT reach the Today strip
  { platform: "facebook", stat_date: "2026-09-05", spend: 120, impressions: 12000, clicks: 240, orders: 0, net_revenue: 0 },
  { platform: "reddit", stat_date: "2026-09-04", spend: 240, impressions: 12000, clicks: 240, orders: 0, net_revenue: 0 },
];

vi.mock("./dashboard-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-data")>();
  return {
    ...actual,
    safeSelect: vi.fn(async () => ({ rows: [], missing: false, error: null })),
    safeSelectAll: vi.fn(async (table: string) => ({
      rows: table === "ad_platform_daily" ? rows : [],
      missing: false,
      error: null,
      truncated: false,
    })),
  };
});

vi.mock("@/lib/supabase-server", () => {
  const client = { from: () => ({ select: () => ({ gte: () => ({}) }) }) };
  return { supabaseAdmin: client, createServerClient: () => client };
});

describe("Today is today's share of the live spend source", () => {
  it("sums only the rows dated today", async () => {
    vi.setSystemTime(new Date("2026-09-06T09:00:00Z"));
    const { getSpendDashboard } = await import("./spend-dashboard");
    const dashboard = await getSpendDashboard(30);

    // 30 + 30 + 153.45, and NOT the 120 and 240 from earlier days.
    expect(dashboard.today.spend).toBeCloseTo(213.45, 2);
    expect(dashboard.today.revenue).toBe(800);
    expect(dashboard.today.orders).toBe(4);
    expect(dashboard.today.cpa).toBeCloseTo(213.45 / 4, 4);
    expect(dashboard.today.roas).toBeCloseTo(800 / 213.45, 4);
    vi.useRealTimers();
  });

  it("still reports the whole window separately", async () => {
    vi.setSystemTime(new Date("2026-09-06T09:00:00Z"));
    const { getSpendDashboard } = await import("./spend-dashboard");
    const dashboard = await getSpendDashboard(30);
    expect(dashboard.totals.spend).toBeCloseTo(573.45, 2);
    vi.useRealTimers();
  });

  it("reports zero rather than NaN on a day with no spend", async () => {
    vi.setSystemTime(new Date("2026-09-09T09:00:00Z"));
    const { getSpendDashboard } = await import("./spend-dashboard");
    const dashboard = await getSpendDashboard(30);
    expect(dashboard.today.spend).toBe(0);
    expect(dashboard.today.roas).toBeNull();
    expect(dashboard.today.cpa).toBeNull();
    vi.useRealTimers();
  });
});

describe("the page renders that strip, not the dead one", () => {
  const page = readFileSync(join(process.cwd(), "src/app/admin/ads/page.tsx"), "utf8");

  it("reads spend.today, never d.today", () => {
    expect(page).toContain("money(spend.today.spend)");
    expect(page).not.toContain("money(d.today.spend)");
  });

  it("takes purchases from the same rollup", () => {
    expect(page).toContain("String(spend.today.orders)");
  });
});
