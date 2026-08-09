// ---------------------------------------------------------------------------
// Ad attribution — the pure half.
//
// This module answers one question: "what, if anything, do we actually know
// about how this person arrived?" It runs in the browser (capture) and on the
// server (validation before storage), so it stays free of `server-only`,
// Supabase, and anything platform-specific.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a sale is only ever credited to an ad
// when the visit carried evidence of an ad — a click id or a campaign tag. No
// inference, no "they arrived from tiktok.com so it was probably the campaign",
// no defaulting. Absence of evidence is stored as absence, because the whole
// point of this system is to eventually decide where real money goes. An
// attribution model that quietly rounds organic sales into the paid column
// makes every ROAS number downstream a flattering lie.
// ---------------------------------------------------------------------------

/** How long a touch stays eligible to be credited. Matches the 30-day window
 *  the referral programme already uses (`vl_referral_code`), so the two
 *  attribution systems on this site agree about what "recent" means. */
export const ATTRIBUTION_WINDOW_DAYS = 30;

const MAX_VALUE_LENGTH = 512;
const MAX_PATH_LENGTH = 512;
const MAX_REFERRER_LENGTH = 1200;

/** Campaign tags. Standard UTM set — the five the owner approved. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

/**
 * Platform click identifiers. Provider-agnostic by construction: adding Meta or
 * Google later is one entry here plus one column, not a new attribution model.
 * `ttclid` is TikTok, `fbclid` Meta, `gclid` Google.
 */
export const CLICK_ID_KEYS = ["ttclid", "fbclid", "gclid"] as const;

export type UtmKey = (typeof UTM_KEYS)[number];
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];

export interface AttributionTouch {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  ttclid: string | null;
  fbclid: string | null;
  gclid: string | null;
  landingPath: string | null;
  referrer: string | null;
  /** ISO timestamp of when this touch happened. */
  at: string;
}

export interface AttributionRecord {
  visitorId: string | null;
  sessionId: string | null;
  /** The campaign that first brought them here. */
  first: AttributionTouch | null;
  /** The campaign in play most recently. */
  last: AttributionTouch | null;
}

/** Collapse whitespace, strip control characters, cap length. Click ids and
 *  campaign names are attacker-influenceable (anyone can craft a URL), so
 *  nothing reaches the database at arbitrary length or with control bytes. */
// Written as explicit \u escapes, not a literal character range: the range form
// is invisible in a diff and easily corrupted in transit, and this function is
// what stands between a crafted URL and the database.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function normalizeValue(raw: unknown, maxLength = MAX_VALUE_LENGTH): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

/** Only same-origin paths are stored as the landing path — a full URL from
 *  another host would be someone else's page, not ours. */
function normalizePath(raw: unknown): string | null {
  const value = normalizeValue(raw, MAX_PATH_LENGTH);
  if (!value) return null;
  return value.startsWith("/") ? value : null;
}

function normalizeReferrer(raw: unknown): string | null {
  const value = normalizeValue(raw, MAX_REFERRER_LENGTH);
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

function readParam(params: URLSearchParams, key: string): string | null {
  return normalizeValue(params.get(key));
}

/**
 * Build a touch from a page view, or return null when the visit carries no
 * campaign evidence at all.
 *
 * Returning null for a bare referrer is deliberate and is the single most
 * important decision in this file. Someone arriving from tiktok.com with no
 * click id and no campaign tag might have seen an ad, or might have followed a
 * link a friend posted, or clicked the profile bio. Crediting that to an ad
 * would inflate paid performance with organic sales — precisely the failure
 * that makes an optimiser scale a campaign that isn't working. The referrer is
 * still recorded ALONGSIDE a real touch as context, and every page view keeps
 * its referrer in `website_analytics_events` regardless.
 */
export function parseAttributionTouch(input: {
  search: string;
  pathname?: string | null;
  referrer?: string | null;
  now: Date;
}): AttributionTouch | null {
  const params = new URLSearchParams(input.search ?? "");

  const touch: AttributionTouch = {
    utmSource: readParam(params, "utm_source"),
    utmMedium: readParam(params, "utm_medium"),
    utmCampaign: readParam(params, "utm_campaign"),
    utmContent: readParam(params, "utm_content"),
    utmTerm: readParam(params, "utm_term"),
    ttclid: readParam(params, "ttclid"),
    fbclid: readParam(params, "fbclid"),
    gclid: readParam(params, "gclid"),
    landingPath: normalizePath(input.pathname),
    referrer: normalizeReferrer(input.referrer),
    at: input.now.toISOString(),
  };

  return hasCampaignEvidence(touch) ? touch : null;
}

/** True when the visit carried something that genuinely identifies a campaign
 *  or a paid click. Landing path and referrer are context, never evidence. */
export function hasCampaignEvidence(touch: AttributionTouch | null | undefined): boolean {
  if (!touch) return false;
  return Boolean(
    touch.utmSource ||
      touch.utmMedium ||
      touch.utmCampaign ||
      touch.utmContent ||
      touch.utmTerm ||
      touch.ttclid ||
      touch.fbclid ||
      touch.gclid,
  );
}

/** True when a paid platform click id is present — the strongest evidence
 *  available, and what the ad platforms themselves match on. */
export function hasPaidClickId(touch: AttributionTouch | null | undefined): boolean {
  if (!touch) return false;
  return Boolean(touch.ttclid || touch.fbclid || touch.gclid);
}

export function isTouchExpired(touch: AttributionTouch | null | undefined, now: Date, windowDays = ATTRIBUTION_WINDOW_DAYS): boolean {
  if (!touch) return true;
  const at = Date.parse(touch.at);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > windowDays * 24 * 60 * 60 * 1000;
}

export function emptyAttributionRecord(): AttributionRecord {
  return { visitorId: null, sessionId: null, first: null, last: null };
}

/**
 * Fold a new touch into what we already knew.
 *
 * First touch is written once and then defended — it is the only field that
 * can answer "which campaign found this customer", and overwriting it on a
 * later visit would silently convert every returning customer into a
 * last-touch-only record. Last touch always advances.
 *
 * Expired touches are dropped rather than carried, so a click from four months
 * ago cannot claim a sale today.
 */
export function mergeAttribution(
  stored: AttributionRecord | null | undefined,
  incoming: AttributionTouch | null,
  options: { now: Date; visitorId?: string | null; sessionId?: string | null; windowDays?: number },
): AttributionRecord {
  const windowDays = options.windowDays ?? ATTRIBUTION_WINDOW_DAYS;
  const base = stored ?? emptyAttributionRecord();

  const first = isTouchExpired(base.first, options.now, windowDays) ? null : base.first;
  const last = isTouchExpired(base.last, options.now, windowDays) ? null : base.last;

  return {
    // Identity survives even when the campaign window lapses — it is how a
    // purchase joins back to its own browsing session, which is useful whether
    // or not an ad was involved.
    visitorId: normalizeValue(options.visitorId ?? base.visitorId, 128),
    sessionId: normalizeValue(options.sessionId ?? base.sessionId, 128),
    first: incoming ? (first ?? incoming) : first,
    last: incoming ?? last,
  };
}

/** Whether this record holds anything worth writing. An all-null record is not
 *  persisted at all: "no row" is how the schema says "we don't know", and it
 *  has to stay distinguishable from a row full of nulls. */
export function hasAnyAttribution(record: AttributionRecord | null | undefined): boolean {
  if (!record) return false;
  return Boolean(record.visitorId || record.sessionId || hasCampaignEvidence(record.first) || hasCampaignEvidence(record.last));
}

/**
 * Re-normalise a record that arrived from the browser.
 *
 * The client is not trusted: this payload is posted from a page anyone can
 * script. Every field is re-validated here, unknown keys are dropped, and a
 * touch that carries no campaign evidence is discarded rather than stored —
 * so a crafted request cannot invent an attributed sale.
 */
export function sanitizeAttributionRecord(raw: unknown, now: Date): AttributionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;

  const sanitizeTouch = (value: unknown): AttributionTouch | null => {
    if (!value || typeof value !== "object") return null;
    const t = value as Record<string, unknown>;
    const parsedAt = Date.parse(String(t.at ?? ""));
    const touch: AttributionTouch = {
      utmSource: normalizeValue(t.utmSource),
      utmMedium: normalizeValue(t.utmMedium),
      utmCampaign: normalizeValue(t.utmCampaign),
      utmContent: normalizeValue(t.utmContent),
      utmTerm: normalizeValue(t.utmTerm),
      ttclid: normalizeValue(t.ttclid),
      fbclid: normalizeValue(t.fbclid),
      gclid: normalizeValue(t.gclid),
      landingPath: normalizePath(t.landingPath),
      referrer: normalizeReferrer(t.referrer),
      // A missing or unparseable timestamp becomes "now" rather than being
      // rejected, but a FUTURE one is clamped — otherwise a crafted payload
      // could mint a touch that never expires.
      at: (Number.isFinite(parsedAt) ? new Date(Math.min(parsedAt, now.getTime())) : now).toISOString(),
    };
    if (!hasCampaignEvidence(touch)) return null;
    if (isTouchExpired(touch, now)) return null;
    return touch;
  };

  const record: AttributionRecord = {
    visitorId: normalizeValue(input.visitorId, 128),
    sessionId: normalizeValue(input.sessionId, 128),
    first: sanitizeTouch(input.first),
    last: sanitizeTouch(input.last),
  };

  return hasAnyAttribution(record) ? record : null;
}

/** Flatten to the `order_attribution` column layout. Kept beside the parser so
 *  the storage shape and the parsed shape can't drift apart. */
export function toOrderAttributionRow(orderId: string, record: AttributionRecord) {
  const { first, last } = record;
  return {
    order_id: orderId,
    visitor_id: record.visitorId,
    session_id: record.sessionId,

    first_touch_at: first?.at ?? null,
    first_utm_source: first?.utmSource ?? null,
    first_utm_medium: first?.utmMedium ?? null,
    first_utm_campaign: first?.utmCampaign ?? null,
    first_utm_content: first?.utmContent ?? null,
    first_utm_term: first?.utmTerm ?? null,
    first_ttclid: first?.ttclid ?? null,
    first_fbclid: first?.fbclid ?? null,
    first_gclid: first?.gclid ?? null,
    first_landing_path: first?.landingPath ?? null,
    first_referrer: first?.referrer ?? null,

    last_touch_at: last?.at ?? null,
    last_utm_source: last?.utmSource ?? null,
    last_utm_medium: last?.utmMedium ?? null,
    last_utm_campaign: last?.utmCampaign ?? null,
    last_utm_content: last?.utmContent ?? null,
    last_utm_term: last?.utmTerm ?? null,
    last_ttclid: last?.ttclid ?? null,
    last_fbclid: last?.fbclid ?? null,
    last_gclid: last?.gclid ?? null,
    last_landing_path: last?.landingPath ?? null,
    last_referrer: last?.referrer ?? null,
  };
}

/** The subset the purchase analytics event carries, so a `purchase` row in
 *  `website_analytics_events` can finally be grouped by campaign like every
 *  page_view already can. Last touch, matching how ad platforms report. */
export function toAnalyticsAttribution(record: AttributionRecord | null | undefined) {
  return {
    utm_source: record?.last?.utmSource ?? null,
    utm_medium: record?.last?.utmMedium ?? null,
    utm_campaign: record?.last?.utmCampaign ?? null,
    visitor_id: record?.visitorId ?? null,
  };
}
