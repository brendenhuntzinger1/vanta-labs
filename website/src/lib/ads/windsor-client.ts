/**
 * One spend feed for four ad platforms.
 *
 * Meta, TikTok, Reddit and Snapchat are already connected and authenticated
 * through Windsor.ai, which normalises all four behind one REST endpoint. That
 * is why this file is one client rather than four, with four OAuth dances, four
 * pagination styles and four rate limiters.
 *
 * ══ EVERY FIELD NAME BELOW WAS READ BACK FROM THE LIVE API. ══
 *
 * This is not a style note. Windsor does not reject an unknown field — it
 * OMITS the column. A wrong name therefore produces a row that parses cleanly
 * with that value silently null, forever, and the system reports itself
 * healthy while ingesting incomplete data. The first version of this file had
 * four such names:
 *
 *   tiktok   adgroup_id/adgroup_name  ->  ad_group_id/ad_group_name
 *   reddit   adgroup_id/adgroup_name  ->  ad_group_id/ad_group_name
 *   snapchat adsquad_id/adsquad_name  ->  ad_squad_id/ad_squad_name
 *   reddit   (assumed no landing URL) ->  ad_click_url exists
 *
 * The Reddit one was the expensive mistake: believing it exposed no destination
 * URL meant believing Reddit ads could never be auto-attributed to a creative,
 * which is wrong and would have sent the owner off to hand-name every ad.
 *
 * So: NO GUESSED ALIASES, and no fallback chains. A fallback that tries three
 * names and takes whichever answers is the same silent failure wearing a
 * seatbelt — it hides which name was right. One verified name per field, pinned
 * by windsor-fields.test.ts.
 *
 * TO ADD OR CHANGE A FIELD: call Windsor's own field list for that connector,
 * confirm the id comes back, then change BOTH the map and the test.
 *
 * WHAT THIS FILE DOES NOT DO: decide anything. It fetches and normalises.
 * Windowing, idempotency and persistence live in `spend-ingest.ts`, so all of
 * that is testable without a network.
 */

import { adPlatformKey, parseAdTagsFromUrl } from "./utm";

export const WINDSOR_ENDPOINT = "https://connectors.windsor.ai";

/** Connector slugs, as Windsor spells them. `facebook` covers Instagram too. */
export const WINDSOR_CONNECTORS = ["facebook", "tiktok", "reddit", "snapchat"] as const;
export type WindsorConnector = (typeof WINDSOR_CONNECTORS)[number];

/**
 * Per-connector field names, all verified against the live API.
 *
 * `destinationUrl: null` for Snapchat is a fact about the platform, not a gap to
 * paper over: Snapchat exposes no landing URL through this connector, so its ads
 * cannot be auto-attributed to a creative and must instead be NAMED for their
 * `utm_content`. Saying so plainly is what lets the dashboard explain the blind
 * spot rather than just showing a smaller number.
 *
 * `conversions` / `conversionValue` are the PLATFORM'S OWN counts. They are
 * stored beside ours and never mixed into ROAS — each platform counts under its
 * own attribution model and they will disagree with our order table.
 */
export type FieldMap = {
  /** Ad group / ad set / ad squad — each platform's middle tier, whatever it calls it. */
  adgroupId: string;
  adgroupName: string;
  /** The ad's destination URL, or null where the connector exposes none. */
  destinationUrl: string | null;
  /** The platform's own purchase count. */
  conversions: string;
  /** The platform's own purchase value, or null where none is exposed. */
  conversionValue: string | null;
};

export const FIELDS: Record<WindsorConnector, FieldMap> = {
  facebook: {
    adgroupId: "adset_id",
    adgroupName: "adset_name",
    destinationUrl: "link_url",
    conversions: "actions_purchase",
    conversionValue: "action_values_purchase",
  },
  tiktok: {
    adgroupId: "ad_group_id",
    adgroupName: "ad_group_name",
    destinationUrl: "landing_page_url",
    conversions: "complete_payment",
    // Windsor's own label for this id is "Purchase value (website)". The id
    // reads like a rate; it is not. Verified from the connector's field list.
    conversionValue: "total_complete_payment_rate",
  },
  reddit: {
    adgroupId: "ad_group_id",
    adgroupName: "ad_group_name",
    destinationUrl: "ad_click_url",
    // Click-attributed purchases only. Reddit reports click and view conversions
    // separately (conversion_purchase_views is the other half); counting both
    // would credit an impression nobody clicked, which is precisely the
    // over-crediting this system exists to avoid.
    conversions: "conversion_purchase_clicks",
    conversionValue: "purchase_total_value",
  },
  snapchat: {
    adgroupId: "ad_squad_id",
    adgroupName: "ad_squad_name",
    destinationUrl: null,
    conversions: "conversion_purchases",
    conversionValue: "conversion_purchases_value",
  },
};

/** Fields every connector has. Verified present on all four. */
export const COMMON_FIELDS = [
  "date",
  "campaign",
  "campaign_id",
  "ad_id",
  "ad_name",
  "spend",
  "clicks",
  "impressions",
] as const;

export function fieldsFor(connector: WindsorConnector): string[] {
  const map = FIELDS[connector];
  return [
    ...COMMON_FIELDS,
    map.adgroupId,
    map.adgroupName,
    map.destinationUrl,
    map.conversions,
    map.conversionValue,
  ].filter((f): f is string => typeof f === "string");
}

/** A normalised spend row, matching `ad_spend_daily` one-to-one. */
export type SpendRow = {
  platform: string;
  adId: string;
  statDate: string;
  campaignId: string | null;
  campaignName: string | null;
  adgroupId: string | null;
  adgroupName: string | null;
  adName: string | null;
  landingUrl: string | null;
  utmContent: string | null;
  utmCampaign: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  /** The platform's own purchase count. Null means it reported none at all. */
  platformConversions: number | null;
  platformConversionValue: number | null;
  currency: string;
};

export type RowRejection = { reason: string; row: unknown };

/**
 * Numbers arrive as strings, as nulls, as "0.00", and occasionally with commas.
 *
 * A value that cannot be read becomes null, never 0. Zero is a real measurement
 * — an ad that spent nothing — and conflating "no spend" with "we failed to
 * parse the spend" is how a broken feed reads as a cheap campaign.
 */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** `2026-09-06`, `2026-09-06T00:00:00Z` and `2026/09/06` all mean the same day. */
export function toStatDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slashed = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(trimmed);
  if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`;
  return null;
}

// Written as explicit \u escapes rather than a literal character range: the
// literal form is invisible in a diff and corrupts in transit, and this is what
// stands between a platform-supplied ad name and the database.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function toText(raw: unknown, max = 512): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/** A count that must stay distinguishable from "not reported". */
function toCount(raw: unknown): number | null {
  const n = toNumber(raw);
  if (n === null) return null;
  return Math.max(0, Math.trunc(n));
}

/**
 * Turn one raw Windsor row into a `SpendRow`, or say why it cannot be.
 *
 * REJECTS RATHER THAN GUESSES on the three fields that must be right: a row
 * with no ad id has no primary key, a row with no readable date cannot be
 * placed in time, and a row whose spend will not parse would understate cost.
 * Everything else is optional and absent means absent — a connector that omits
 * ad-group names or conversions still yields a usable spend row, because
 * refusing the whole row would lose real money data over a missing label.
 *
 * Rejections are returned, not thrown and not logged-and-dropped, so the ingest
 * can report how much it refused.
 */
export function normalizeSpendRow(
  connector: WindsorConnector,
  raw: unknown,
  options: { currency?: string } = {},
): { ok: true; row: SpendRow } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "row is not an object" };
  const r = raw as Record<string, unknown>;
  const map = FIELDS[connector];

  const adId = toText(r.ad_id, 128);
  if (!adId) return { ok: false, reason: "missing ad_id" };

  const statDate = toStatDate(r.date);
  if (!statDate) return { ok: false, reason: `unparseable date ${JSON.stringify(r.date)}` };

  const spend = toNumber(r.spend);
  if (spend === null) return { ok: false, reason: `unparseable spend ${JSON.stringify(r.spend)}` };
  if (spend < 0) return { ok: false, reason: `negative spend ${spend}` };

  const landingUrl = map.destinationUrl ? toText(r[map.destinationUrl], 2048) : null;
  const tags = parseAdTagsFromUrl(landingUrl);

  return {
    ok: true,
    row: {
      platform: adPlatformKey(connector) ?? connector,
      adId,
      statDate,
      campaignId: toText(r.campaign_id, 128),
      campaignName: toText(r.campaign),
      adgroupId: toText(r[map.adgroupId], 128),
      adgroupName: toText(r[map.adgroupName]),
      adName: toText(r.ad_name),
      landingUrl,
      utmContent: tags.utmContent,
      utmCampaign: tags.utmCampaign,
      // Missing impressions and clicks are normal on a day with no delivery, so
      // they floor at 0; conversions stay null when unreported, because "the
      // platform says zero purchases" and "the platform has no pixel" are
      // different facts and the dashboard shows them differently.
      spend,
      impressions: Math.max(0, Math.trunc(toNumber(r.impressions) ?? 0)),
      clicks: Math.max(0, Math.trunc(toNumber(r.clicks) ?? 0)),
      platformConversions: toCount(r[map.conversions]),
      platformConversionValue: map.conversionValue ? toNumber(r[map.conversionValue]) : null,
      currency: options.currency ?? "USD",
    },
  };
}

export type FetchOutcome =
  | { ok: true; rows: SpendRow[]; rejections: RowRejection[] }
  | { ok: false; error: string };

/**
 * Fetch one connector's daily spend for a date range.
 *
 * `fetchImpl` is injected so the ingest can be tested end to end without a
 * network and without a live API key.
 */
export async function fetchConnectorSpend(input: {
  connector: WindsorConnector;
  apiKey: string;
  dateFrom: string;
  dateTo: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<FetchOutcome> {
  const doFetch = input.fetchImpl ?? fetch;
  const url = new URL(`${WINDSOR_ENDPOINT}/${input.connector}`);
  url.searchParams.set("api_key", input.apiKey);
  url.searchParams.set("date_from", input.dateFrom);
  url.searchParams.set("date_to", input.dateTo);
  url.searchParams.set("fields", fieldsFor(input.connector).join(","));

  let response: Response;
  try {
    response = await doFetch(url.toString(), { signal: input.signal });
  } catch (error) {
    return { ok: false, error: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    // The body carries Windsor's own explanation (an expired connector, a
    // revoked ad-account grant). Passing it through beats "HTTP 400", because
    // the fix differs for each and an operator reads this at 2am.
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      /* a body we cannot read is still an HTTP status worth reporting */
    }
    return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: `response was not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  // Windsor documents `{ data: [...] }`; a bare array is accepted too.
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!raw) return { ok: false, error: "response carried no data array" };

  const rows: SpendRow[] = [];
  const rejections: RowRejection[] = [];
  for (const item of raw) {
    const outcome = normalizeSpendRow(input.connector, item);
    if (outcome.ok) rows.push(outcome.row);
    else rejections.push({ reason: outcome.reason, row: item });
  }

  return { ok: true, rows, rejections };
}
