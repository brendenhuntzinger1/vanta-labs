/**
 * Rolling daily spend/revenue rows up into period totals.
 *
 * Separate from `spend-dashboard.ts` and free of `server-only` so it can be
 * tested directly, without a database.
 *
 * ── THE ONE ARITHMETIC RULE ──
 *
 * **Every ratio is recomputed from the summed parts. None is ever averaged
 * across days.**
 *
 * The mean of daily ROAS is not the period's ROAS. It weights a $2 day the same
 * as a $2,000 one, so one cheap day with a lucky order can lift a month's
 * "average ROAS" above 1.0 while the month lost money — see the worked case in
 * spend-aggregate.test.ts, where averaging is wrong by a factor of 46 in the
 * flattering direction. The same holds for CTR, CVR, CPC, CPM and CPA.
 *
 * So every rate here is `total ÷ total`, and null when the denominator is zero,
 * because a ratio with no denominator is unknown rather than 0.
 *
 * ── PLATFORM COUNTS STAY SEPARATE ──
 *
 * `platformConversions` is what the ad platform says it converted, under its own
 * attribution model. It is carried through untouched and never enters ROAS, CPA
 * or CVR — those are computed only from `orders`, our own paid-order count.
 * Blending them would pick one attribution model arbitrarily and hide that the
 * two disagree, which is usually the most informative thing on the page.
 */

export type Parts = { spend: number; revenue: number; orders: number; impressions: number; clicks: number };

export type Rates = {
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cvr: number | null;
  cpa: number | null;
  roas: number | null;
};

export type PlatformRow = Parts & Rates & {
  platform: string;
  /** The platform's own conversion count. Null when it reported none at all. */
  platformConversions: number | null;
};

export type CampaignRow = Parts & Rates & {
  platform: string;
  utmCampaign: string;
  campaignName: string | null;
  platformConversions: number | null;
};

export type CreativeRow = Parts & Rates & {
  platform: string;
  utmContent: string;
  adName: string | null;
  campaignName: string | null;
  /** How many distinct ads carry this tag on this platform. */
  ads: number;
  platformConversions: number | null;
};

export type UntaggedRow = {
  platform: string;
  adId: string;
  adName: string | null;
  campaignName: string | null;
  spend: number;
  reason: string;
};

export type UnattributedRevenueRow = {
  platform: string;
  utmCampaign: string | null;
  orders: number;
  revenue: number;
};

export const EMPTY_PARTS: Parts = { spend: 0, revenue: 0, orders: 0, impressions: 0, clicks: 0 };

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Sum a platform count, preserving "not reported at all" as null. */
function addCount(acc: number | null, raw: unknown): number | null {
  if (raw === null || raw === undefined) return acc;
  const n = Number(raw);
  if (!Number.isFinite(n)) return acc;
  return (acc ?? 0) + n;
}

export function ratios(p: Parts): Rates {
  return {
    ctr: p.impressions > 0 ? p.clicks / p.impressions : null,
    cpc: p.clicks > 0 ? p.spend / p.clicks : null,
    cpm: p.impressions > 0 ? (p.spend / p.impressions) * 1000 : null,
    cvr: p.clicks > 0 ? p.orders / p.clicks : null,
    cpa: p.orders > 0 ? p.spend / p.orders : null,
    roas: p.spend > 0 ? p.revenue / p.spend : null,
  };
}

function accumulate(acc: Parts, row: Record<string, unknown>): Parts {
  acc.spend += num(row.spend);
  acc.revenue += num(row.net_revenue);
  acc.orders += num(row.orders);
  acc.impressions += num(row.impressions);
  acc.clicks += num(row.clicks);
  return acc;
}

/** Sum `ad_platform_daily` rows per platform, biggest spender first. */
export function aggregatePlatforms(rows: Record<string, unknown>[]): PlatformRow[] {
  const by = new Map<string, { parts: Parts; conversions: number | null }>();
  for (const row of rows) {
    const platform = String(row.platform ?? "unknown");
    const entry = by.get(platform) ?? { parts: { ...EMPTY_PARTS }, conversions: null };
    accumulate(entry.parts, row);
    entry.conversions = addCount(entry.conversions, row.platform_conversions);
    by.set(platform, entry);
  }
  return [...by.entries()]
    .map(([platform, e]) => ({ platform, ...e.parts, ...ratios(e.parts), platformConversions: e.conversions }))
    .sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);
}

/** Sum `ad_campaign_daily` rows per (platform, utm_campaign). */
export function aggregateCampaigns(rows: Record<string, unknown>[]): CampaignRow[] {
  const by = new Map<string, { platform: string; utmCampaign: string; campaignName: string | null; parts: Parts; conversions: number | null }>();
  for (const row of rows) {
    const utmCampaign = String(row.utm_campaign ?? "");
    if (!utmCampaign) continue;
    const platform = String(row.platform ?? "unknown");
    const key = `${platform}:${utmCampaign}`;
    const entry = by.get(key) ?? {
      platform, utmCampaign, campaignName: text(row.campaign_name),
      parts: { ...EMPTY_PARTS }, conversions: null,
    };
    accumulate(entry.parts, row);
    entry.conversions = addCount(entry.conversions, row.platform_conversions);
    by.set(key, entry);
  }
  return [...by.values()]
    .map((e) => ({
      platform: e.platform, utmCampaign: e.utmCampaign, campaignName: e.campaignName,
      ...e.parts, ...ratios(e.parts), platformConversions: e.conversions,
    }))
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend);
}

/**
 * Sum `ad_creative_roas_daily` rows per (platform, utm_content).
 *
 * Keyed by platform AND tag: the same creative can run on two platforms, and
 * merging them would hide that it works on one and not the other — exactly the
 * comparison worth having.
 *
 * Only creatives that actually spent are returned. A creative with no spend has
 * no ROAS, and sorting nulls to the top would put untested work at the head of a
 * "best ads" list.
 */
export function aggregateCreatives(rows: Record<string, unknown>[]): CreativeRow[] {
  const by = new Map<string, {
    platform: string; utmContent: string; adName: string | null; campaignName: string | null;
    ads: number; parts: Parts; conversions: number | null;
  }>();
  for (const row of rows) {
    const utmContent = String(row.utm_content ?? "");
    if (!utmContent) continue;
    const platform = String(row.platform ?? "unknown");
    const key = `${platform}:${utmContent}`;
    const entry = by.get(key) ?? {
      platform, utmContent, adName: text(row.ad_name), campaignName: text(row.campaign_name),
      ads: 0, parts: { ...EMPTY_PARTS }, conversions: null,
    };
    accumulate(entry.parts, row);
    entry.conversions = addCount(entry.conversions, row.platform_conversions);
    // `ads` comes from the view's own count of distinct ads sharing the tag on
    // that day. Taking the max rather than the sum: the same ad appearing on
    // seven days is one ad, not seven.
    entry.ads = Math.max(entry.ads, Math.trunc(num(row.ads)) || 1);
    by.set(key, entry);
  }
  return [...by.values()]
    .map((e) => ({
      platform: e.platform, utmContent: e.utmContent, adName: e.adName, campaignName: e.campaignName,
      ads: e.ads, ...e.parts, ...ratios(e.parts), platformConversions: e.conversions,
    }))
    .filter((c) => c.spend > 0)
    .sort((a, b) => (b.roas ?? -Infinity) - (a.roas ?? -Infinity) || b.spend - a.spend);
}

export function totalParts(rows: Parts[]): Parts {
  return rows.reduce<Parts>(
    (acc, p) => ({
      spend: acc.spend + p.spend,
      revenue: acc.revenue + p.revenue,
      orders: acc.orders + p.orders,
      impressions: acc.impressions + p.impressions,
      clicks: acc.clicks + p.clicks,
    }),
    { ...EMPTY_PARTS },
  );
}

/** Sum `ad_spend_untagged` rows per ad — spend we can see but cannot measure. */
export function aggregateUntagged(rows: Record<string, unknown>[]): UntaggedRow[] {
  const by = new Map<string, UntaggedRow>();
  for (const row of rows) {
    const platform = String(row.platform ?? "unknown");
    const adId = String(row.ad_id ?? "");
    const key = `${platform}:${adId}`;
    const acc = by.get(key) ?? {
      platform, adId,
      adName: text(row.ad_name),
      campaignName: text(row.campaign_name),
      spend: 0,
      reason: String(row.reason ?? ""),
    };
    acc.spend += num(row.spend);
    by.set(key, acc);
  }
  return [...by.values()].sort((a, b) => b.spend - a.spend);
}

/** Sum `ad_revenue_unattributed` — revenue we can place on a platform but not an ad. */
export function aggregateUnattributedRevenue(rows: Record<string, unknown>[]): UnattributedRevenueRow[] {
  const by = new Map<string, UnattributedRevenueRow>();
  for (const row of rows) {
    const platform = String(row.platform ?? "unknown");
    const utmCampaign = text(row.utm_campaign);
    const key = `${platform}:${utmCampaign ?? ""}`;
    const acc = by.get(key) ?? { platform, utmCampaign, orders: 0, revenue: 0 };
    acc.orders += num(row.orders);
    acc.revenue += num(row.net_revenue);
    by.set(key, acc);
  }
  return [...by.values()].sort((a, b) => b.revenue - a.revenue);
}
