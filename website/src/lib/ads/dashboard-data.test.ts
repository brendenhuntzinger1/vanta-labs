import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard is built before the ad schema exists, so the case that actually
 * matters is the one where every table is missing. A dashboard that throws
 * before its first row of data is a dashboard nobody can review.
 */

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();
let missingTables = new Set<string>();
let hardError: string | null = null;

function result(table: string) {
  if (hardError) return { data: null, error: { code: "500", message: hardError } };
  if (missingTables.has(table)) {
    return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
  }
  return { data: tables.get(table) ?? [], error: null };
}

function builder(table: string) {
  const chain = {
    eq(column: string, value: unknown) {
      const base = result(table);
      if (base.error) return Promise.resolve(base);
      return Promise.resolve({ data: (base.data ?? []).filter((r) => r[column] === value), error: null });
    },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(result(table)).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: { from: (table: string) => ({ select: () => builder(table) }) },
}));

const { getAdsDashboard } = await import("./dashboard-data");

const AD_TABLES = [
  "ad_creatives", "ad_performance_daily", "ad_reference_creatives", "ad_patterns",
  "ad_decisions", "ad_experiments", "ad_guardrails", "ad_media_requests",
];

beforeEach(() => {
  tables.clear();
  missingTables = new Set();
  hardError = null;
});

describe("ads dashboard data", () => {
  it("renders an explained empty state when the schema has not been applied", async () => {
    missingTables = new Set(AD_TABLES);
    const d = await getAdsDashboard();

    expect(d.schemaReady).toBe(false);
    // A missing relation is a pre-migration state, not a failure to report.
    expect(d.schemaError).toBeNull();
    expect(d.today).toEqual({ spend: 0, revenue: 0, purchases: 0, cpa: null, roas: null });
    expect(d.winners).toEqual([]);
    expect(d.references).toEqual([]);
    expect(d.recommendations).toEqual([]);
    // Falls back to the deny-by-default guardrails rather than inventing limits.
    expect(d.guardrails.mode).toBe("recommend");
    expect(d.guardrails.autoApprovedActions).not.toContain("increase_budget");
  });

  it("surfaces a real database failure instead of hiding it as empty", async () => {
    hardError = "connection refused";
    const d = await getAdsDashboard();
    expect(d.schemaError).toBe("connection refused");
  });

  it("reports TikTok as unavailable with the credentials named", async () => {
    missingTables = new Set(AD_TABLES);
    const d = await getAdsDashboard();
    expect(d.tiktok.ready).toBe(false);
    expect(d.tiktok.missing).toContain("TIKTOK_ADS_ACCESS_TOKEN");
    expect(d.tiktok.blockedOn.join(" ")).toMatch(/eligibility/);
  });

  it("rolls performance up per creative and ranks only creatives that spent", async () => {
    const today = new Date().toISOString().slice(0, 10);
    tables.set("ad_creatives", [
      { creative_id: "vl-a", hook: "hook a", archetype: "documentation", status: "testing" },
      { creative_id: "vl-b", hook: "hook b", archetype: "ugc", status: "testing" },
      { creative_id: "vl-c", hook: "never launched", archetype: "ugc", status: "concept" },
    ]);
    tables.set("ad_performance_daily", [
      { creative_id: "vl-a", stat_date: today, spend: 100, impressions: 10000, clicks: 200, site_add_to_carts: 20, site_purchases: 5, site_revenue: 500, site_refunds: 0 },
      { creative_id: "vl-a", stat_date: today, spend: 100, impressions: 10000, clicks: 200, site_add_to_carts: 20, site_purchases: 5, site_revenue: 300, site_refunds: 100 },
      { creative_id: "vl-b", stat_date: today, spend: 200, impressions: 20000, clicks: 100, site_add_to_carts: 2, site_purchases: 0, site_revenue: 0, site_refunds: 0 },
      { creative_id: "vl-c", stat_date: today, spend: 0, impressions: 0, clicks: 0, site_add_to_carts: 0, site_purchases: 0, site_revenue: 0, site_refunds: 0 },
    ]);

    const d = await getAdsDashboard();
    expect(d.schemaReady).toBe(true);

    const a = d.creatives.find((c) => c.creativeId === "vl-a")!;
    expect(a.spend).toBe(200);
    // Revenue is net of refunds: a sale that came back is not a sale.
    expect(a.revenue).toBe(700);
    expect(a.metrics.roas).toBeCloseTo(3.5, 5);
    expect(a.hook).toBe("hook a");

    expect(d.winners[0].creativeId).toBe("vl-a");
    expect(d.losers[0].creativeId).toBe("vl-b");
    // A creative that never spent has no ROAS and must not head the winners list.
    expect(d.winners.map((w) => w.creativeId)).not.toContain("vl-c");

    expect(d.today.spend).toBe(400);
    expect(d.today.purchases).toBe(10);
    expect(d.today.cpa).toBeCloseTo(40, 5);
  });

  it("counts references awaiting analysis", async () => {
    tables.set("ad_reference_creatives", [
      { reference_id: "ref-1", company: "Brand A", platform: "tiktok", source_url: "https://x", owner_note: "nice", observed: {} },
      { reference_id: "ref-2", company: null, platform: "reels", source_url: null, owner_note: null, observed: { hook: "stop scrolling" } },
    ]);
    const d = await getAdsDashboard();
    expect(d.referenceCount).toBe(2);
    expect(d.unanalysedReferences).toBe(1);
    expect(d.references.find((r) => r.referenceId === "ref-2")?.analysed).toBe(true);
  });

  it("lists generated creatives waiting for approval with their asset progress", async () => {
    tables.set("ad_creatives", [{ creative_id: "vl-a", hook: "h", archetype: "documentation", status: "ready" }]);
    tables.set("ad_media_requests", [
      { creative_id: "vl-a", status: "complete" },
      { creative_id: "vl-a", status: "pending" },
    ]);
    const d = await getAdsDashboard();
    expect(d.pendingApproval).toEqual([
      { creativeId: "vl-a", hook: "h", archetype: "documentation", assetsReady: 1, assetsTotal: 2, status: "ready" },
    ]);
  });

  it("reads stored guardrails over the defaults when they exist", async () => {
    tables.set("ad_guardrails", [{
      mode: "manual_approval", daily_account_ceiling: 250, campaign_daily_ceiling: 80,
      max_budget_increase_pct: 0.15, max_budget_increase_absolute: 40,
      min_conversions_to_scale: 12, min_days_to_scale: 5, min_impressions_to_kill: 3000,
      auto_approved_actions: ["pause_ad"], frozen: true, frozen_reason: "owner stop",
    }]);
    const d = await getAdsDashboard();
    expect(d.guardrails.mode).toBe("manual_approval");
    expect(d.guardrails.dailyAccountCeiling).toBe(250);
    expect(d.guardrails.frozen).toBe(true);
    expect(d.guardrails.frozenReason).toBe("owner stop");
  });
});
