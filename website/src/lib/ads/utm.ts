/**
 * The join key, in one file.
 *
 * Spend comes from four ad platforms. Revenue comes from this store's own
 * orders. Nothing connects them except the tags carried in the ad's landing
 * URL, so the code that WRITES those tags and the code that READS them back
 * have to agree exactly — and the only way to guarantee that is for both to be
 * this module.
 *
 * The convention:
 *
 *   https://vantalabsresearch.com/products/bpc-157
 *     ?utm_source=tiktok            <- platform, normalised
 *     &utm_medium=paid_social       <- always this for a paid ad
 *     &utm_campaign=launch_q3       <- the campaign, owner's own naming
 *     &utm_content=hook_a_ugc       <- THE CREATIVE. This is the join key.
 *     &utm_term=broad_18_34         <- ad group, optional
 *
 * `utm_content` is the one that matters. Without it there is spend per ad and
 * revenue per platform, and no way to say which ad earned which sale.
 */

/** The four platforms this store advertises on, as spelled internally. */
export const AD_PLATFORMS = ["facebook", "tiktok", "reddit", "snapchat"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/**
 * Collapse a platform's many spellings onto one.
 *
 * Mirrors `public.ad_platform_key` in `ads-spend-roas.sql`. The mapping exists
 * twice because one copy has to run in Postgres to join the views and the other
 * has to run in TypeScript to normalise on ingest; `utm.test.ts` asserts the
 * two agree on every key. An unknown source is lowercased and returned rather
 * than dropped — an unrecognised platform is worth seeing, not hiding.
 */
export function adPlatformKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  switch (value) {
    case "fb":
    case "meta":
    case "facebook":
    case "instagram":
    case "ig":
      return "facebook";
    case "tt":
    case "tiktok":
      return "tiktok";
    case "reddit":
      return "reddit";
    case "snap":
    case "snapchat":
      return "snapchat";
    default:
      return value;
  }
}

/**
 * Whether a utm_source names a platform this store actually buys ads on.
 *
 * The counterpart to `adPlatformKey`, and the distinction between them is the
 * whole point. `adPlatformKey` passes an unrecognised value through, because on
 * the SPEND side it came from an ad connector and really is a platform. This
 * asks the opposite question of a value that came from a URL a browser was
 * handed, which anyone — and plenty of software, unprompted — may write
 * anything into. ChatGPT appends `?utm_source=chatgpt.com` to every link it
 * hands out; treating that as an ad credited organic sales to an ad account
 * that had sold nothing.
 *
 * Mirrors clause 1 of `public.is_paid_ad_source` in `ads-spend-roas.sql`. The
 * SQL side has a second clause this cannot have — "or any platform with spend
 * recorded against it" — because it can read the spend table and this is pure.
 */
export function isKnownAdPlatform(raw: string | null | undefined): boolean {
  const key = adPlatformKey(raw);
  return key !== null && (AD_PLATFORMS as readonly string[]).includes(key);
}

/**
 * Tag characters that survive a round trip through four ad platforms' URL
 * handling, a browser, and a Postgres text column.
 *
 * Deliberately narrow. Ad platforms rewrite, truncate and re-encode
 * destination URLs, and a tag that arrives back differently from how it left is
 * a tag that joins to nothing — which presents as "this ad made no money"
 * rather than as an error. Lowercase alphanumerics, hyphen and underscore only.
 */
const SAFE_TAG = /^[a-z0-9_-]+$/;

export function isSafeTag(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && SAFE_TAG.test(value);
}

/**
 * Coerce a label into a safe tag, or null if nothing usable survives.
 *
 * Returns null rather than a mangled guess for an empty result: silently
 * inventing a tag would create a join key that matches the wrong ad.
 */
export function toSafeTag(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");
  return slug.length > 0 ? slug : null;
}

export type AdTags = {
  platform: AdPlatform | string;
  /** Campaign name, owner's own naming. */
  campaign: string;
  /** The creative. This is what per-ad ROAS joins on. */
  content: string;
  /** Ad group or audience. Optional — useful, not load-bearing. */
  term?: string | null;
};

export type BuildResult =
  | { ok: true; url: string }
  | { ok: false; problems: string[] };

/**
 * Build the landing URL to paste into a platform's ad builder.
 *
 * Refuses rather than repairs. A URL that is silently corrected produces spend
 * that attributes to the wrong creative for as long as the ad runs, and nobody
 * discovers it, because the dashboard looks populated. Every problem is
 * reported at once so the caller fixes one thing.
 */
export function buildAdLandingUrl(input: {
  baseUrl: string;
  path: string;
  tags: AdTags;
}): BuildResult {
  const problems: string[] = [];

  const platform = adPlatformKey(input.tags.platform);
  if (!platform) problems.push("platform is required");

  if (!isSafeTag(input.tags.campaign)) {
    problems.push(`utm_campaign ${JSON.stringify(input.tags.campaign)} must be lowercase a-z, 0-9, _ or - (max 64)`);
  }
  if (!isSafeTag(input.tags.content)) {
    problems.push(`utm_content ${JSON.stringify(input.tags.content)} must be lowercase a-z, 0-9, _ or - (max 64)`);
  }
  if (input.tags.term != null && !isSafeTag(input.tags.term)) {
    problems.push(`utm_term ${JSON.stringify(input.tags.term)} must be lowercase a-z, 0-9, _ or - (max 64)`);
  }
  if (!input.path.startsWith("/")) {
    problems.push(`path ${JSON.stringify(input.path)} must start with /`);
  }

  let url: URL;
  try {
    url = new URL(input.path, input.baseUrl);
  } catch {
    problems.push(`baseUrl ${JSON.stringify(input.baseUrl)} is not a valid URL`);
    return { ok: false, problems };
  }

  if (problems.length > 0) return { ok: false, problems };

  url.searchParams.set("utm_source", platform as string);
  url.searchParams.set("utm_medium", "paid_social");
  url.searchParams.set("utm_campaign", input.tags.campaign);
  url.searchParams.set("utm_content", input.tags.content);
  if (input.tags.term) url.searchParams.set("utm_term", input.tags.term);

  return { ok: true, url: url.toString() };
}

/**
 * Read the tags back out of an ad's destination URL, as reported by the platform.
 *
 * This is the ingest side of the contract. The URL has been through the
 * platform by the time we see it, so it may carry the platform's own macros
 * (`{{ad.id}}`, `__CLICKID__`), extra tracking parameters, or a different
 * encoding. Anything that is not a tag we recognise is ignored; a `utm_content`
 * that is not a safe tag is treated as ABSENT rather than accepted, because a
 * corrupted key joins to the wrong creative and that is worse than no join.
 */
export function parseAdTagsFromUrl(rawUrl: string | null | undefined): {
  utmSource: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
} {
  const empty = { utmSource: null, utmCampaign: null, utmContent: null, utmTerm: null };
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return empty;

  let params: URLSearchParams;
  try {
    params = new URL(rawUrl.trim()).searchParams;
  } catch {
    // A relative or malformed destination still often carries a query string,
    // and throwing it away would lose real tags. Fall back to whatever follows
    // the first '?'.
    const q = rawUrl.indexOf("?");
    if (q < 0) return empty;
    params = new URLSearchParams(rawUrl.slice(q + 1));
  }

  const read = (key: string): string | null => {
    const value = params.get(key);
    if (typeof value !== "string") return null;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    // Unexpanded platform macros are not values. They reach reporting whenever
    // an ad is built with a macro the platform only substitutes at click time.
    if (/[{}<>]|^__.*__$/.test(trimmed)) return null;
    return trimmed;
  };

  const content = read("utm_content");

  return {
    utmSource: adPlatformKey(read("utm_source")),
    utmCampaign: read("utm_campaign"),
    utmContent: isSafeTag(content) ? content : null,
    utmTerm: read("utm_term"),
  };
}
