/**
 * Rolling daily spend/revenue rows up into period totals.
 *
 * Separate from `spend-dashboard.ts` and free of `server-only` so it can be
 * tested directly. The one rule worth stating: **ratios are recomputed from the
 * summed parts, never averaged across days.**
 *
 * The mean of daily ROAS is not the period's ROAS. It weights a $2 day the same
 * as a $2,000 one, and on any real spend curve that is wrong by a lot rather
 * than a little — a single cheap day with one lucky order can lift a month's
 * average ROAS above 1.0 while the month actually lost money. Same for CTR and
 * CPA. Every ratio here is `total / total`, and null when the denominator is
 * zero, because a ratio with no denominator is unknown rather than 0.
 */

export type PlatformRow = {
  platform: string;
  spend: number;
  revenue: number;
  orders: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpa: number | null;
  roas: number | null;
};

export type CreativeSpendRow = {
  platform: string;
  utmContent: string;
  adName: string | null;
  campaignName: string | null;
  spend: number;
  revenue: number;
  orders: number;
  clicks: number;
  cpa: number | null;
  roas: number | null;
};

export type UntaggedRow = {
  platform: string;
  adId: string;
  adName: string | null;
  campaignName: string | null;
  spend: number;
  reason: string;
};

export type Parts = { spend: number; revenue: number; orders: number; impressions: number; clicks: number };

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function ratios(p: Parts): { ctr: number | null; cpa: number | null; roas: number | null } {
  return {
    ctr: p.impressions > 0 ? p.clicks / p.impressions : null,
    cpa: p.orders > 0 ? p.spend / p.orders : null,
    roas: p.spend > 0 ? p.revenue / p.spend : null,
  };
}

export const EMPTY_PARTS: Parts = { spend: 0, revenue: 0, orders: 0, impressions: 0, clicks: 0 };

/** Sum `ad_platform_daily` rows per platform, biggest spender first. */
export function aggregatePlatforms(rows: Record<string, unknown>[]): PlatformRow[] {
  const byPlatform = new Map<string, Parts>();
  for (const row of rows) {
    const platform = String(row.platform ?? "unknown");
    const acc = byPlatform.get(platform) ?? { ...EMPTY_PARTS };
    acc.spend += num(row.spend);
    acc.revenue += num(row.net_revenue);
    acc.orders += num(row.orders);
    acc.impressions += num(row.impressions);
    acc.clicks += num(row.clicks);
    byPlatform.set(platform, acc);
  }
  return [...byPlatform.entries()]
    .map(([platform, parts]) => ({ platform, ...parts, ...ratios(parts) }))
    .sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);
}

export function totalParts(platforms: PlatformRow[]): Parts {
  return platforms.reduce<Parts>(
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

/**
 * Sum `ad_creative_roas_daily` rows per creative, ranked by return.
 *
 * Only creatives that actually spent are ranked. A creative with no spend has no
 * ROAS, and sorting nulls to the top would put untested work at the head of a
 * "best ads" list — the same reasoning as the winners list in
 * `dashboard-data.ts`.
 *
 * Keyed by platform AND tag: the same creative can run on two platforms, and
 * merging them would hide that it works on one and not the other, which is
 * exactly the comparison worth having.
 */
export function aggregateCreatives(rows: Record<string, unknown>[]): CreativeSpendRow[] {
  const byCreative = new Map<string, CreativeSpendRow>();
  for (const row of rows) {
    const utmContent = String(row.utm_content ?? "");
    if (!utmContent) continue;
    const platform = String(row.platform ?? "unknown");
    const key = `${platform}:${utmContent}`;
    const acc = byCreative.get(key) ?? {
      platform,
      utmContent,
      adName: text(row.ad_name),
      campaignName: text(row.campaign_name),
      spend: 0, revenue: 0, orders: 0, clicks: 0, cpa: null, roas: null,
    };
    acc.spend += num(row.spend);
    acc.revenue += num(row.net_revenue);
    acc.orders += num(row.orders);
    acc.clicks += num(row.clicks);
    byCreative.set(key, acc);
  }
  return [...byCreative.values()]
    .map((c) => ({
      ...c,
      cpa: c.orders > 0 ? c.spend / c.orders : null,
      roas: c.spend > 0 ? c.revenue / c.spend : null,
    }))
    .filter((c) => c.spend > 0)
    .sort((a, b) => (b.roas ?? -Infinity) - (a.roas ?? -Infinity));
}

/** Sum `ad_spend_untagged` rows per ad — the spend that cannot be measured. */
export function aggregateUntagged(rows: Record<string, unknown>[]): UntaggedRow[] {
  const byAd = new Map<string, UntaggedRow>();
  for (const row of rows) {
    const platform = String(row.platform ?? "unknown");
    const adId = String(row.ad_id ?? "");
    const key = `${platform}:${adId}`;
    const acc = byAd.get(key) ?? {
      platform,
      adId,
      adName: text(row.ad_name),
      campaignName: text(row.campaign_name),
      spend: 0,
      reason: String(row.reason ?? ""),
    };
    acc.spend += num(row.spend);
    byAd.set(key, acc);
  }
  return [...byAd.values()].sort((a, b) => b.spend - a.spend);
}
