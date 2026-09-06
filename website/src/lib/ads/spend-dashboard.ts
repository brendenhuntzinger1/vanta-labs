import "server-only";

import { safeSelect } from "./dashboard-data";
import { ingestAdSpend } from "./spend-ingest";
import {
  aggregateCampaigns,
  aggregateCreatives,
  aggregatePlatforms,
  aggregateUnattributedRevenue,
  aggregateUntagged,
  EMPTY_PARTS,
  ratios,
  totalParts,
  type CampaignRow,
  type CreativeRow,
  type Parts,
  type PlatformRow,
  type Rates,
  type UnattributedRevenueRow,
  type UntaggedRow,
} from "./spend-aggregate";

/**
 * What did each platform, campaign and ad cost, and what did it earn.
 *
 * Reads the views in `ads-spend-roas.sql`. Deliberately separate from
 * `dashboard-data.ts`: that file reports on creatives DESIGNED in this system,
 * this one on ads actually RUNNING on the four platforms. For now those are
 * different populations, and keeping them apart means neither has to pretend the
 * other's rows exist.
 *
 * The rule from `dashboard-data.ts` carries over: **empty is never dressed up as
 * zero.** Three different empty states are reachable and they have three
 * different fixes — no migration, no feed, no spend — so `schemaReady`,
 * `feedConfigured` and `lastIngestedAt` all travel to the UI rather than
 * collapsing into one blank table.
 *
 * All aggregation lives in `spend-aggregate.ts` so it can be tested without a
 * database. This file is the query layer and nothing else.
 */

export type { CampaignRow, CreativeRow, PlatformRow, UnattributedRevenueRow, UntaggedRow };

export type SpendDashboard = {
  /** False when `ads-spend-roas.sql` has not been applied. */
  schemaReady: boolean;
  schemaError: string | null;
  /** Whether a spend feed is even configured. Drives "no data" vs "no spend". */
  feedConfigured: boolean;
  /** When spend was last pulled, or null if never. */
  lastIngestedAt: string | null;
  windowDays: number;

  /** The headline. Everything the owner needs before scrolling. */
  totals: Parts & Rates & { platformConversions: number | null };

  platforms: PlatformRow[];
  campaigns: CampaignRow[];
  creatives: CreativeRow[];

  /** Best and worst by ROAS among ads that actually spent. */
  winners: CreativeRow[];
  losers: CreativeRow[];

  /** Spend we can see but cannot tie to revenue. */
  untagged: UntaggedRow[];
  untaggedSpend: number;
  /** Revenue we can place on a platform but not on an ad. */
  unattributedRevenue: UnattributedRevenueRow[];
  unattributedRevenueTotal: number;
};

const DEFAULT_WINDOW_DAYS = 30;

/** How many rows each table shows. Bounded so a busy account cannot render
 *  10,000 rows, and the UI states what it dropped rather than truncating
 *  silently. */
export const TABLE_LIMIT = 25;

function since(windowDays: number): string {
  return new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
}

export async function getSpendDashboard(windowDays = DEFAULT_WINDOW_DAYS): Promise<SpendDashboard> {
  const from = since(windowDays);

  const [platformRes, campaignRes, creativeRes, untaggedRes, unattributedRes, freshnessRes] = await Promise.all([
    safeSelect<Record<string, unknown>>("ad_platform_daily", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_campaign_daily", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_creative_roas_daily", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_spend_untagged", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_revenue_unattributed", "*", (q) => q.gte("stat_date", from)),
    safeSelect<Record<string, unknown>>("ad_spend_daily", "ingested_at", (q) =>
      q.order("ingested_at", { ascending: false }).limit(1),
    ),
  ]);

  const platforms = aggregatePlatforms(platformRes.rows);
  const campaigns = aggregateCampaigns(campaignRes.rows);
  const creatives = aggregateCreatives(creativeRes.rows);
  const untagged = aggregateUntagged(untaggedRes.rows);
  const unattributedRevenue = aggregateUnattributedRevenue(unattributedRes.rows);

  // Totals come from the PLATFORM rollup, not from creatives, because platform
  // rows include untagged spend and unattributed revenue. Summing creatives
  // would silently exclude both and report a flattering, smaller denominator.
  const parts: Parts = platforms.length > 0 ? totalParts(platforms) : { ...EMPTY_PARTS };
  const platformConversions = platforms.reduce<number | null>(
    (acc, p) => (p.platformConversions === null ? acc : (acc ?? 0) + p.platformConversions),
    null,
  );

  // Winners and losers come off the same ROAS-sorted list from opposite ends,
  // and never overlap: with four or fewer creatives the same row would otherwise
  // appear as both the best and the worst ad on the page.
  const ranked = creatives;
  const half = Math.floor(ranked.length / 2);
  const cut = Math.min(5, half);

  return {
    schemaReady: !platformRes.missing,
    schemaError: [platformRes.error, campaignRes.error, creativeRes.error, untaggedRes.error].find(Boolean) ?? null,
    feedConfigured: Boolean(process.env.WINDSOR_API_KEY?.trim()),
    lastIngestedAt: (freshnessRes.rows[0]?.ingested_at as string | undefined) ?? null,
    windowDays,

    totals: { ...parts, ...ratios(parts), platformConversions },

    platforms,
    campaigns: campaigns.slice(0, TABLE_LIMIT),
    creatives: creatives.slice(0, TABLE_LIMIT),

    winners: ranked.slice(0, cut),
    losers: cut > 0 ? ranked.slice(-cut).reverse() : [],

    untagged: untagged.slice(0, TABLE_LIMIT),
    untaggedSpend: untagged.reduce((sum, u) => sum + u.spend, 0),
    unattributedRevenue: unattributedRevenue.slice(0, TABLE_LIMIT),
    unattributedRevenueTotal: unattributedRevenue.reduce((sum, u) => sum + u.revenue, 0),
  };
}

/** Kick a spend refresh by hand, bypassing the six-hour gate. For an operator
 *  pressing refresh; the cron calls `ingestAdSpend` with no argument. */
export function refreshSpendNow() {
  return ingestAdSpend({ force: true });
}
