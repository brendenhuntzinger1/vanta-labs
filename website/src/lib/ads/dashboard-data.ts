import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_GUARDRAILS, type Guardrails } from "./guardrails";
import { assessTikTokReadiness, type ReadinessReport } from "./tiktok-client";
import { derive } from "./decisions";
import type { DerivedMetrics, PerformanceSnapshot } from "./types";

/**
 * Everything the owner dashboard needs, in one read.
 *
 * Two rules run through this file.
 *
 * **A missing table is a state, not a crash.** `ads-system.sql` has not been
 * applied yet, so every query here can legitimately fail with "relation does
 * not exist". The dashboard must still render — showing an empty, explained
 * interface is the whole point of building it before the data exists.
 *
 * **Empty is never dressed up as zero.** "No campaigns yet" and "campaigns
 * spending nothing" are different facts, and a dashboard that renders them
 * identically teaches the owner to distrust it. `schemaReady` carries that
 * distinction to the UI.
 */

export type TodayStrip = {
  spend: number;
  revenue: number;
  purchases: number;
  cpa: number | null;
  roas: number | null;
};

export type CreativeRow = {
  creativeId: string;
  hook: string;
  archetype: string;
  status: string;
  spend: number;
  purchases: number;
  revenue: number;
  metrics: DerivedMetrics;
};

export type RecommendationRow = {
  decisionId: string;
  creativeId: string;
  action: string;
  rationale: string;
  decidedMetrics: string[];
  unresolvedMetrics: string[];
  createdAt: string;
};

export type PendingApprovalRow = {
  creativeId: string;
  hook: string;
  archetype: string;
  assetsReady: number;
  assetsTotal: number;
  status: string;
};

export type ReferenceRow = {
  referenceId: string;
  company: string | null;
  platform: string;
  sourceUrl: string | null;
  ownerNote: string | null;
  analysed: boolean;
};

export type ExperimentRow = {
  experimentId: string;
  name: string;
  axis: string;
  status: string;
  arms: number;
  looksTaken: number;
  plannedLooks: number;
};

export type AdsDashboard = {
  /** False when the ad schema has not been applied. Drives every empty state. */
  schemaReady: boolean;
  schemaError: string | null;
  guardrails: Guardrails;
  tiktok: ReadinessReport;
  today: TodayStrip;
  winners: CreativeRow[];
  losers: CreativeRow[];
  creatives: CreativeRow[];
  references: ReferenceRow[];
  referenceCount: number;
  unanalysedReferences: number;
  patternCount: number;
  recommendations: RecommendationRow[];
  experiments: ExperimentRow[];
  pendingApproval: PendingApprovalRow[];
};

const EMPTY_TODAY: TodayStrip = { spend: 0, revenue: 0, purchases: 0, cpa: null, roas: null };

function snapshotFrom(row: Record<string, unknown>): PerformanceSnapshot {
  const num = (v: unknown) => Number(v ?? 0);
  return {
    snapshotId: String(row.creative_id ?? ""),
    creativeId: String(row.creative_id ?? ""),
    platform: (row.platform as "tiktok" | "meta") ?? "tiktok",
    campaignId: String(row.campaign_id ?? ""),
    adGroupId: String(row.ad_group_id ?? ""),
    adId: String(row.ad_id ?? ""),
    statDate: String(row.stat_date ?? ""),
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: row.reach === null ? null : num(row.reach),
    clicks: num(row.clicks),
    videoViews: row.video_views === null ? null : num(row.video_views),
    views2s: row.views_2s === null ? null : num(row.views_2s),
    views6s: row.views_6s === null ? null : num(row.views_6s),
    viewsComplete: row.views_complete === null ? null : num(row.views_complete),
    platformConversions: row.platform_conversions === null ? null : num(row.platform_conversions),
    siteSessions: num(row.site_sessions),
    siteAddToCarts: num(row.site_add_to_carts),
    siteCheckouts: num(row.site_checkouts),
    sitePurchases: num(row.site_purchases),
    siteRevenue: num(row.site_revenue),
    siteRefunds: num(row.site_refunds),
    recordedAt: String(row.recorded_at ?? ""),
  };
}

/**
 * Roll daily rows up per creative. Kept here rather than in SQL so the same
 * derivation runs over live rows and over test fixtures, and so a schema that
 * does not exist yet costs nothing.
 */
function rollUp(rows: Record<string, unknown>[], hooks: Map<string, { hook: string; archetype: string; status: string }>): CreativeRow[] {
  const byCreative = new Map<string, PerformanceSnapshot[]>();
  for (const row of rows) {
    const snapshot = snapshotFrom(row);
    const list = byCreative.get(snapshot.creativeId) ?? [];
    list.push(snapshot);
    byCreative.set(snapshot.creativeId, list);
  }

  return [...byCreative.entries()].map(([creativeId, snapshots]) => {
    const total = snapshots.reduce<PerformanceSnapshot>((acc, s) => ({
      ...acc,
      spend: acc.spend + s.spend,
      impressions: acc.impressions + s.impressions,
      clicks: acc.clicks + s.clicks,
      views2s: (acc.views2s ?? 0) + (s.views2s ?? 0),
      views6s: (acc.views6s ?? 0) + (s.views6s ?? 0),
      siteSessions: acc.siteSessions + s.siteSessions,
      siteAddToCarts: acc.siteAddToCarts + s.siteAddToCarts,
      siteCheckouts: acc.siteCheckouts + s.siteCheckouts,
      sitePurchases: acc.sitePurchases + s.sitePurchases,
      siteRevenue: acc.siteRevenue + s.siteRevenue,
      siteRefunds: acc.siteRefunds + s.siteRefunds,
    }), { ...snapshots[0], spend: 0, impressions: 0, clicks: 0, views2s: 0, views6s: 0, siteSessions: 0, siteAddToCarts: 0, siteCheckouts: 0, sitePurchases: 0, siteRevenue: 0, siteRefunds: 0 });

    const meta = hooks.get(creativeId);
    return {
      creativeId,
      hook: meta?.hook ?? creativeId,
      archetype: meta?.archetype ?? "unknown",
      status: meta?.status ?? "unknown",
      spend: total.spend,
      purchases: total.sitePurchases,
      revenue: total.siteRevenue - total.siteRefunds,
      metrics: derive(total),
    };
  });
}

type QueryOutcome<T> = { rows: T[]; missing: boolean; error: string | null };

/**
 * Query a table, distinguishing "not created yet" from a real failure.
 *
 * Postgres reports an absent relation as 42P01. Treating that as a normal
 * pre-migration state — rather than an error — is what lets the dashboard be
 * built and reviewed before the schema is applied.
 */
async function safeSelect<T>(table: string, columns: string, build?: (q: ReturnType<typeof buildQuery>) => unknown): Promise<QueryOutcome<T>> {
  function buildQuery() {
    return supabaseAdmin.from(table).select(columns);
  }
  try {
    const query = build ? (build(buildQuery()) as ReturnType<typeof buildQuery>) : buildQuery();
    const { data, error } = await query;
    if (error) {
      const missing = error.code === "42P01" || /does not exist/i.test(error.message ?? "");
      return { rows: [], missing, error: missing ? null : error.message };
    }
    return { rows: (data ?? []) as T[], missing: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rows: [], missing: /does not exist/i.test(message), error: /does not exist/i.test(message) ? null : message };
  }
}

export async function getAdsDashboard(): Promise<AdsDashboard> {
  const todayIso = new Date().toISOString().slice(0, 10);

  const [creativeRes, perfRes, todayRes, refRes, patternRes, decisionRes, experimentRes, guardrailRes, mediaRes] =
    await Promise.all([
      safeSelect<Record<string, unknown>>("ad_creatives", "creative_id,hook,archetype,status,concept_id"),
      safeSelect<Record<string, unknown>>("ad_performance_daily", "*"),
      safeSelect<Record<string, unknown>>("ad_performance_daily", "*", (q) => q.eq("stat_date", todayIso)),
      safeSelect<Record<string, unknown>>("ad_reference_creatives", "reference_id,company,platform,source_url,owner_note,observed"),
      safeSelect<Record<string, unknown>>("ad_patterns", "pattern_id"),
      safeSelect<Record<string, unknown>>("ad_decisions", "decision_id,creative_id,action,rationale,decided_metrics,unresolved_metrics,created_at"),
      safeSelect<Record<string, unknown>>("ad_experiments", "experiment_id,name,axis,status,planned_looks,looks_taken"),
      safeSelect<Record<string, unknown>>("ad_guardrails", "*"),
      safeSelect<Record<string, unknown>>("ad_media_requests", "creative_id,status"),
    ]);

  const schemaReady = !creativeRes.missing && !perfRes.missing;
  const schemaError = [creativeRes.error, perfRes.error, refRes.error].find(Boolean) ?? null;

  const hooks = new Map(
    creativeRes.rows.map((r) => [
      String(r.creative_id),
      { hook: String(r.hook ?? ""), archetype: String(r.archetype ?? ""), status: String(r.status ?? "") },
    ]),
  );

  const allCreatives = rollUp(perfRes.rows, hooks);
  const todayRows = rollUp(todayRes.rows, hooks);
  const today: TodayStrip = todayRows.length
    ? todayRows.reduce<TodayStrip>(
        (acc, c) => {
          const spend = acc.spend + c.spend;
          const revenue = acc.revenue + c.revenue;
          const purchases = acc.purchases + c.purchases;
          return { spend, revenue, purchases, cpa: purchases > 0 ? spend / purchases : null, roas: spend > 0 ? revenue / spend : null };
        },
        { ...EMPTY_TODAY },
      )
    : EMPTY_TODAY;

  // Ranked by return, but only among creatives that actually spent — a creative
  // with no spend has no ROAS, and sorting nulls to the top would put untested
  // work at the head of a "winners" list.
  const spending = allCreatives.filter((c) => c.spend > 0);
  const byRoas = [...spending].sort((a, b) => (b.metrics.roas ?? -Infinity) - (a.metrics.roas ?? -Infinity));

  const mediaByCreative = new Map<string, { total: number; ready: number }>();
  for (const row of mediaRes.rows) {
    const id = String(row.creative_id);
    const entry = mediaByCreative.get(id) ?? { total: 0, ready: 0 };
    entry.total += 1;
    if (row.status === "complete") entry.ready += 1;
    mediaByCreative.set(id, entry);
  }

  const pendingApproval: PendingApprovalRow[] = creativeRes.rows
    .filter((r) => ["ready", "generating", "approved_for_production"].includes(String(r.status)))
    .map((r) => {
      const id = String(r.creative_id);
      const media = mediaByCreative.get(id) ?? { total: 0, ready: 0 };
      return {
        creativeId: id,
        hook: String(r.hook ?? ""),
        archetype: String(r.archetype ?? ""),
        assetsReady: media.ready,
        assetsTotal: media.total,
        status: String(r.status ?? ""),
      };
    });

  const references: ReferenceRow[] = refRes.rows.map((r) => {
    const observed = (r.observed ?? {}) as Record<string, unknown>;
    return {
      referenceId: String(r.reference_id),
      company: (r.company as string | null) ?? null,
      platform: String(r.platform ?? "other"),
      sourceUrl: (r.source_url as string | null) ?? null,
      ownerNote: (r.owner_note as string | null) ?? null,
      analysed: Object.values(observed).some((v) => v !== null && v !== undefined && v !== ""),
    };
  });

  const guardrailRow = guardrailRes.rows[0];
  const guardrails: Guardrails = guardrailRow
    ? {
        mode: guardrailRow.mode as Guardrails["mode"],
        dailyAccountCeiling: Number(guardrailRow.daily_account_ceiling),
        campaignDailyCeiling: Number(guardrailRow.campaign_daily_ceiling),
        maxBudgetIncreasePct: Number(guardrailRow.max_budget_increase_pct),
        maxBudgetIncreaseAbsolute: Number(guardrailRow.max_budget_increase_absolute),
        minConversionsToScale: Number(guardrailRow.min_conversions_to_scale),
        minDaysToScale: Number(guardrailRow.min_days_to_scale),
        minImpressionsToKill: Number(guardrailRow.min_impressions_to_kill),
        autoApprovedActions: (guardrailRow.auto_approved_actions as Guardrails["autoApprovedActions"]) ?? [],
        frozen: Boolean(guardrailRow.frozen),
        frozenReason: (guardrailRow.frozen_reason as string | undefined) ?? undefined,
      }
    : DEFAULT_GUARDRAILS;

  return {
    schemaReady,
    schemaError,
    guardrails,
    tiktok: assessTikTokReadiness(process.env),
    today,
    winners: byRoas.slice(0, 5),
    losers: [...byRoas].reverse().slice(0, 5),
    creatives: allCreatives,
    references: references.slice(0, 25),
    referenceCount: references.length,
    unanalysedReferences: references.filter((r) => !r.analysed).length,
    patternCount: patternRes.rows.length,
    recommendations: decisionRes.rows.map((r) => ({
      decisionId: String(r.decision_id),
      creativeId: String(r.creative_id ?? ""),
      action: String(r.action ?? ""),
      rationale: String(r.rationale ?? ""),
      decidedMetrics: (r.decided_metrics as string[]) ?? [],
      unresolvedMetrics: (r.unresolved_metrics as string[]) ?? [],
      createdAt: String(r.created_at ?? ""),
    })),
    experiments: experimentRes.rows.map((r) => ({
      experimentId: String(r.experiment_id),
      name: String(r.name ?? ""),
      axis: String(r.axis ?? ""),
      status: String(r.status ?? ""),
      arms: 0,
      looksTaken: Number(r.looks_taken ?? 0),
      plannedLooks: Number(r.planned_looks ?? 0),
    })),
    pendingApproval,
  };
}
