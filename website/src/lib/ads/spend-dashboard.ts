import "server-only";

import { safeSelect } from "./dashboard-data";
import { ingestAdSpend } from "./spend-ingest";
import {
  aggregateCreatives,
  aggregatePlatforms,
  aggregateUntagged,
  EMPTY_PARTS,
  ratios,
  totalParts,
  type CreativeSpendRow,
  type Parts,
  type PlatformRow,
  type UntaggedRow,
} from "./spend-aggregate";

/**
 * What did each platform cost, and what did it earn.
 *
 * Reads the views in `ads-spend-roas.sql`. Deliberately separate from
 * `dashboard-data.ts`: that file reports on creatives DESIGNED in this system,
 * this one reports on ads actually RUNNING on the four platforms, and for now
 * those are different populations. Keeping them apart means neither has to
 * pretend the other's rows exist.
 *
 * The rule from `dashboard-data.ts` carries over unchanged: **empty is never
 * dressed up as zero.** Three different empty states are reachable here and
 * they have three different fixes — no migration, no feed, no spend — so
 * `schemaReady`, `feedConfigured` and `lastIngestedAt` all travel to the UI
 * rather than collapsing into one blank table.
 *
 * All aggregation lives in `spend-aggregate.ts` so it can be tested without a
 * database. This file is the query layer and nothing else.
 */

export type { CreativeSpendRow, PlatformRow, UntaggedRow };

export type SpendDashboard = {
  /** False when `ads-spend-roas.sql` has not been applied. */
  schemaReady: boolean;
  schemaError: string | null;
  /** Whether a spend feed is even configured. Drives "no data" vs "no spend". */
  feedConfigured: boolean;
  /** When spend was last pulled, or null if never. */
  lastIngestedAt: string | null;
  windowDays: number;
  platforms: PlatformRow[];
  totals: Parts & { ctr: number | null; cpa: number | null; roas: number | null };
  creatives: CreativeSpendRow[];
  /** Ads that spent money with no readable creative tag: the measurable blind spot. */
  untagged: UntaggedRow[];
  untaggedSpend: number;
};

const DEFAULT_WINDOW_DAYS = 30;

function since(windowDays: number): string {
  return new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
}

export async function getSpendDashboard(windowDays = DEFAULT_WINDOW_DAYS): Promise<SpendDashboard> {
  const from = since(windowDays);

  const [platformRes, creativeRes, untaggedRes, freshnessRes] = await Promise.all([
    safeSelect<Record<string, unknown>>("ad_platform_daily", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_creative_roas_daily", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_spend_untagged", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_spend_daily", "ingested_at", (q) =>
      q.order("ingested_at", { ascending: false }).limit(1),
    ),
  ]);

  const platforms = aggregatePlatforms(platformRes.rows);
  const untagged = aggregateUntagged(untaggedRes.rows);
  const parts = platforms.length > 0 ? totalParts(platforms) : { ...EMPTY_PARTS };

  return {
    schemaReady: !platformRes.missing,
    schemaError: [platformRes.error, creativeRes.error, untaggedRes.error].find(Boolean) ?? null,
    feedConfigured: Boolean(process.env.WINDSOR_API_KEY?.trim()),
    lastIngestedAt: (freshnessRes.rows[0]?.ingested_at as string | undefined) ?? null,
    windowDays,
    platforms,
    totals: { ...parts, ...ratios(parts) },
    creatives: aggregateCreatives(creativeRes.rows).slice(0, 25),
    untagged: untagged.slice(0, 25),
    untaggedSpend: untagged.reduce((sum, u) => sum + u.spend, 0),
  };
}

/** Kick a spend refresh by hand, bypassing the six-hour gate. For an operator
 *  pressing refresh; the cron calls `ingestAdSpend` with no argument. */
export function refreshSpendNow() {
  return ingestAdSpend({ force: true });
}
