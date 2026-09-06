/**
 * One spend feed for four ad platforms.
 *
 * Meta, TikTok, Reddit and Snapchat are already connected and authenticated
 * through Windsor.ai, which normalises all four behind one REST endpoint. That
 * is the whole reason this file is ~200 lines instead of four API clients with
 * four OAuth dances, four pagination styles and four rate limiters.
 *
 * THE FIELD NAMES BELOW WERE VERIFIED AGAINST THE LIVE API, not guessed. They
 * differ per connector in ways that are not predictable — TikTok exposes
 * `landing_page_url`, Meta calls the same thing `link_url`, and Reddit and
 * Snapchat expose no destination URL at all. Windsor rejects an unknown field
 * for some connectors and silently omits it for others, so a guessed name shows
 * up as a missing column rather than an error. If you add a field, confirm it
 * with the connector's own field list first.
 *
 * WHAT THIS FILE DOES NOT DO: decide anything. It fetches and it normalises.
 * Windowing, idempotency and persistence are `spend-ingest.ts`, so all of that
 * is testable without a network.
 */

import { adPlatformKey, parseAdTagsFromUrl } from "./utm";

export const WINDSOR_ENDPOINT = "https://connectors.windsor.ai";

/** Connector slugs, as Windsor spells them. `facebook` covers Instagram too. */
export const WINDSOR_CONNECTORS = ["facebook", "tiktok", "reddit", "snapchat"] as const;
export type WindsorConnector = (typeof WINDSOR_CONNECTORS)[number];

/**
 * Per-connector field names.
 *
 * `destinationUrl` is null where the connector has no such field. That is a
 * fact about the platform, not a gap to paper over: per-ad revenue on Reddit
 * and Snapchat depends on the tag being known some other way, and pretending
 * otherwise would produce silently unattributed spend.
 */
type FieldMap = {
  /** Ad group / ad set / ad squad — each platform's middle tier, whatever it calls it. */
  adgroupId: string | null;
  adgroupName: string | null;
  destinationUrl: string | null;
};

const FIELDS: Record<WindsorConnector, FieldMap> = {
  facebook: { adgroupId: "adset_id", adgroupName: "adset_name", destinationUrl: "link_url" },
  tiktok: { adgroupId: "adgroup_id", adgroupName: "adgroup_name", destinationUrl: "landing_page_url" },
  reddit: { adgroupId: "adgroup_id", adgroupName: "adgroup_name", destinationUrl: null },
  snapchat: { adgroupId: "adsquad_id", adgroupName: "adsquad_name", destinationUrl: null },
};

/** Fields every connector has. Verified present on all four. */
const COMMON_FIELDS = ["date", "campaign", "campaign_id", "ad_id", "ad_name", "spend", "clicks", "impressions"];

export function fieldsFor(connector: WindsorConnector): string[] {
  const map = FIELDS[connector];
  return [...COMMON_FIELDS, map.adgroupId, map.adgroupName, map.destinationUrl].filter(
    (f): f is string => typeof f === "string",
  );
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
  spend: number;
  impressions: number;
  clicks: number;
  currency: string;
};

export type RowRejection = { reason: string; row: unknown };

/**
 * Numbers arrive as strings, as nulls, as "0.00", and occasionally as
 * locale-formatted text.
 *
 * A value that cannot be read becomes null, never 0. Zero is a real
 * measurement — an ad that spent nothing — and conflating "no spend" with "we
 * failed to parse the spend" is how a broken feed reads as a cheap campaign.
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

/**
 * Turn one raw Windsor row into a `SpendRow`, or say why it cannot be.
 *
 * REJECTS RATHER THAN GUESSES. A row without an ad id or a readable date has no
 * primary key, so storing it would either fail or — worse, if a fallback were
 * invented — merge two different ads into one. A row whose spend will not parse
 * is rejected for the reason above. Rejections are returned, not thrown and not
 * logged-and-dropped, so the ingest can report how much it refused.
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
      adgroupId: map.adgroupId ? toText(r[map.adgroupId], 128) : null,
      adgroupName: map.adgroupName ? toText(r[map.adgroupName]) : null,
      adName: toText(r.ad_name),
      landingUrl,
      utmContent: tags.utmContent,
      // Impressions and clicks missing is normal on a day with no delivery;
      // spend missing is not, which is why only spend rejects the row.
      spend,
      impressions: Math.max(0, Math.trunc(toNumber(r.impressions) ?? 0)),
      clicks: Math.max(0, Math.trunc(toNumber(r.clicks) ?? 0)),
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
  url.searchParams.set("_renderer", "json");

  let response: Response;
  try {
    response = await doFetch(url.toString(), { signal: input.signal });
  } catch (error) {
    return { ok: false, error: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    // The body carries Windsor's own explanation (an expired connector, a
    // revoked ad-account grant). Passing it through beats "HTTP 400", because
    // the fix is different for each and an operator reads this at 2am.
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

  // Windsor returns `{ data: [...] }`; some connectors return a bare array.
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
