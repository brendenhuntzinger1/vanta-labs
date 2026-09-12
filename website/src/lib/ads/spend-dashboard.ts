import "server-only";

import { safeSelect, safeSelectAll } from "./dashboard-data";
import { ingestAdSpend } from "./spend-ingest";
import {
  aggregateCampaigns,
  aggregateCreatives,
  aggregateNonPaidSource,
  aggregatePlatforms,
  aggregateUnattributedRevenue,
  aggregateUntagged,
  EMPTY_PARTS,
  ratios,
  totalParts,
  type CampaignRow,
  type CreativeRow,
  type NonPaidSourceRow,
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

export type { CampaignRow, CreativeRow, NonPaidSourceRow, PlatformRow, UnattributedRevenueRow, UntaggedRow };

export type SpendDashboard = {
  /** False when `ads-spend-roas.sql` has not been applied. */
  schemaReady: boolean;
  schemaError: string | null;
  /** Whether a spend feed is even configured. Drives "no data" vs "no spend". */
  feedConfigured: boolean;
  /** When spend was last pulled, or null if never. */
  lastIngestedAt: string | null;
  /**
   * How old that pull is, in whole hours — null when nothing has ever landed.
   *
   * Derived here rather than in the page because the page renders it, and
   * reading the clock during render is exactly the impurity the React compiler
   * refuses. Freshness is a property of the data, so it travels with it.
   */
  lastIngestedAgeHours: number | null;
  windowDays: number;

  /** The headline. Everything the owner needs before scrolling. */
  totals: Parts & Rates & { platformConversions: number | null };

  platforms: PlatformRow[];
  campaigns: CampaignRow[];
  creatives: CreativeRow[];

  /** Best and worst by ROAS among ads that actually spent. */
  winners: CreativeRow[];
  losers: CreativeRow[];

  /**
   * TODAY, from the same source as the window above it.
   *
   * The page's Today strip read `ad_performance_daily`, which is the table PR
   * #161 was written to replace: its creative_id foreign key requires a
   * creative designed inside this system, and no ad running on the four live
   * platforms has one, so it "could never hold a row". The strip therefore read
   * $0.00 / $0.00 / 0 / — / — for ever, sitting directly above a thirty-day
   * panel showing real money, on a page whose own copy promises that "an empty
   * panel means no data, never a guess".
   *
   * Measured: $573.45 of spend seeded across five days INCLUDING today, and the
   * strip showed $0.00.
   *
   * Derived from the platform rows already fetched, so it costs no extra query
   * and cannot disagree with the window beside it.
   */
  today: Parts & Rates;

  /** Spend we can see but cannot tie to revenue. */
  untagged: UntaggedRow[];
  untaggedSpend: number;
  /** Revenue we can place on a platform but not on an ad. */
  unattributedRevenue: UnattributedRevenueRow[];
  unattributedRevenueTotal: number;

  /**
   * Revenue deliberately excluded from everything above: paid orders whose
   * utm_source names somewhere this store does not buy ads.
   *
   * Carried to the UI rather than dropped in the query layer. Before the
   * exclusion this money was in the headline — $286.54 of ChatGPT referrals
   * divided by TikTok's spend, reported as ROAS 3.36 on an ad account that had
   * sold nothing — and a correction that silently removes revenue from a page
   * is the kind that gets reverted by whoever notices the drop.
   */
  nonPaidSourceRevenue: NonPaidSourceRow[];
  nonPaidSourceRevenueTotal: number;
};

const DEFAULT_WINDOW_DAYS = 30;

/** How many rows each table shows. Bounded so a busy account cannot render
 *  10,000 rows, and the UI states what it dropped rather than truncating
 *  silently. */
export const TABLE_LIMIT = 25;

/**
 * The first day of an INCLUSIVE window of `windowDays` days.
 *
 * `windowDays - 1`, because the reads compare a DATE with `>=` and today is one
 * of the days. Without it "last 30 days" spanned 31 distinct dates — every
 * total on the page was a day wider than its own label, which on a dashboard
 * that drives spend decisions is a number that quietly does not mean what it
 * says.
 */
function since(windowDays: number): string {
  return new Date(Date.now() - Math.max(0, windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Today, as the reads' upper bound: a future-dated reporting row from a
 *  platform in a leading timezone must not enter the window unnoticed. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getSpendDashboard(windowDays = DEFAULT_WINDOW_DAYS): Promise<SpendDashboard> {
  const from = since(windowDays);
  // Bounded at both ends. See since() — the window is inclusive of today, and a
  // platform reporting a day ahead of UTC must not silently widen it.
  const to = today();

  const [platformRes, campaignRes, creativeRes, untaggedRes, unattributedRes, nonPaidRes, freshnessRes] = await Promise.all([
    // PAGED, every one of them. PostgREST caps a select at 1000 rows and says
    // so only in a header supabase-js does not surface, so an unpaged read of a
    // per-day-per-creative view returns a prefix and the sums below present that
    // prefix as a total. Four platforms over thirty days crosses 1000 at about
    // nine creatives per platform — and the two figures it would truncate,
    // untagged spend and unattributed revenue, exist precisely to state the size
    // of the blind spot.
    safeSelectAll<Record<string, unknown>>("ad_platform_daily", "*", (q) => q.gte("stat_date", from).lte("stat_date", to)),
    safeSelectAll<Record<string, unknown>>("ad_campaign_daily", "*", (q) => q.gte("stat_date", from).lte("stat_date", to)),
    safeSelectAll<Record<string, unknown>>("ad_creative_roas_daily", "*", (q) => q.gte("stat_date", from).lte("stat_date", to)),
    safeSelectAll<Record<string, unknown>>("ad_spend_untagged", "*", (q) => q.gte("stat_date", from).lte("stat_date", to)),
    safeSelectAll<Record<string, unknown>>("ad_revenue_unattributed", "*", (q) => q.gte("stat_date", from).lte("stat_date", to)),
    safeSelectAll<Record<string, unknown>>("ad_revenue_non_paid_source", "*", (q) => q.gte("stat_date", from).lte("stat_date", to)),
    safeSelect<Record<string, unknown>>("ad_spend_daily", "ingested_at", (q) =>
      q.order("ingested_at", { ascending: false }).limit(1),
    ),
  ]);

  const platforms = aggregatePlatforms(platformRes.rows);
  const campaigns = aggregateCampaigns(campaignRes.rows);
  const creatives = aggregateCreatives(creativeRes.rows);
  const untagged = aggregateUntagged(untaggedRes.rows);
  const unattributedRevenue = aggregateUnattributedRevenue(unattributedRes.rows);
  const nonPaidSourceRevenue = aggregateNonPaidSource(nonPaidRes.rows);

  // Totals come from the PLATFORM rollup, not from creatives, because platform
  // rows include untagged spend and unattributed revenue. Summing creatives
  // would silently exclude both and report a flattering, smaller denominator.
  const parts: Parts = platforms.length > 0 ? totalParts(platforms) : { ...EMPTY_PARTS };

  // The same rollup, narrowed to today's stat_date. aggregatePlatforms collapses
  // the per-day rows, so today is taken from the raw rows before that.
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayRows = aggregatePlatforms(
    platformRes.rows.filter((row) => String(row.stat_date ?? "").slice(0, 10) === todayIso),
  );
  const todayParts: Parts = todayRows.length > 0 ? totalParts(todayRows) : { ...EMPTY_PARTS };
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

  const lastIngestedAt = (freshnessRes.rows[0]?.ingested_at as string | undefined) ?? null;
  const lastIngestedMs = lastIngestedAt ? Date.parse(lastIngestedAt) : NaN;

  return {
    schemaReady: !platformRes.missing,
    schemaError: [platformRes.error, campaignRes.error, creativeRes.error, untaggedRes.error].find(Boolean) ?? null,
    feedConfigured: Boolean(process.env.WINDSOR_API_KEY?.trim()),
    lastIngestedAt,
    lastIngestedAgeHours: Number.isNaN(lastIngestedMs)
      ? null
      : Math.max(0, Math.floor((Date.now() - lastIngestedMs) / 3_600_000)),
    windowDays,

    totals: { ...parts, ...ratios(parts), platformConversions },
    today: { ...todayParts, ...ratios(todayParts) },

    platforms,
    campaigns: campaigns.slice(0, TABLE_LIMIT),
    creatives: creatives.slice(0, TABLE_LIMIT),

    winners: ranked.slice(0, cut),
    losers: cut > 0 ? ranked.slice(-cut).reverse() : [],

    untagged: untagged.slice(0, TABLE_LIMIT),
    untaggedSpend: untagged.reduce((sum, u) => sum + u.spend, 0),
    unattributedRevenue: unattributedRevenue.slice(0, TABLE_LIMIT),
    unattributedRevenueTotal: unattributedRevenue.reduce((sum, u) => sum + u.revenue, 0),
    nonPaidSourceRevenue: nonPaidSourceRevenue.slice(0, TABLE_LIMIT),
    nonPaidSourceRevenueTotal: nonPaidSourceRevenue.reduce((sum, u) => sum + u.revenue, 0),
  };
}

/** Kick a spend refresh by hand, bypassing the six-hour gate. For an operator
 *  pressing refresh; the cron calls `ingestAdSpend` with no argument. */
export function refreshSpendNow() {
  return ingestAdSpend({ force: true });
}
