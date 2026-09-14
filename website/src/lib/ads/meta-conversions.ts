import "server-only";
import { serverAdsReportingAllowed } from "@/lib/ads/ads-environment";

import { createHash } from "node:crypto";

import { buildAdvancedMatching } from "@/lib/ads/advanced-matching";
import type { MetaEvent } from "@/lib/ads/meta-events";
import { META_PIXEL_ID } from "@/lib/ads/meta-pixel-id";

/**
 * Meta Conversions API — the server-side leg.
 *
 * WHY IT EXISTS. The browser pixel alone loses a meaningful share of what it
 * should report: ad blockers, Safari and iOS tracking limits, a tab closed
 * before the request flushes, a purchase made on a different device from the
 * ad click. This reports the same events from the server, where none of that
 * applies. Both legs carry the same event_id, so Meta counts ONE event — that
 * is what the pixel's eventID work was groundwork for.
 *
 * THE ENDPOINT, from Meta's Conversions API reference:
 *
 *   POST https://graph.facebook.com/<version>/<pixel_id>/events
 *   { "data": [ { event_name, event_time, event_id, action_source,
 *                 event_source_url, user_data: {...}, custom_data: {...} } ],
 *     "access_token": "<token>", "test_event_code"?: "<code>" }
 *
 * The token travels in the JSON body rather than the query string, so it can
 * never land in a URL that a proxy, a log line or an error message keeps.
 *
 * IDENTITY, AND HOW IT IS HANDLED. Meta matches on hashed identifiers: `em`
 * and `ph` must be SHA-256 of the normalised value, and `external_id` may be.
 * They are produced here by the same advanced-matching module TikTok and Snap
 * already use, so the raw address never leaves the server and the same
 * customer hashes to the same bytes on every platform. Name and postal fields
 * are normalised the way Meta's reference specifies and hashed the same way.
 * Identity is sent on a paid order, as the privacy policy states; browser
 * funnel events carry only the pixel's own cookies, IP and user agent.
 *
 * `client_ip_address`, `client_user_agent`, `fbp` and `fbc` go raw, as Meta
 * requires: it matches them against values it observed itself, and a digest
 * would compare against nothing. `fbp` and `fbc` are the pixel's own
 * first-party cookies, which exist only after consent.
 */

const GRAPH_API_VERSION = "v21.0";
const CONVERSIONS_API_BASE = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 8000;

/** Meta rejects anything older than seven days. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MetaConversionUser = {
  /** Raw email. Hashed here; never leaves this module unhashed. */
  email?: string | null;
  /** Raw phone. Hashed here as E.164 digits. */
  phone?: string | null;
  externalId?: string | null;
  /** Raw full name, split and hashed here as Meta's fn / ln. */
  fullName?: string | null;
  /** Raw postal fields. Each normalised and hashed here as ct / st / zp / country. */
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The `_fbp` cookie the pixel sets. Raw, as Meta requires. */
  fbp?: string | null;
  /** The `_fbc` cookie, when the pixel recorded an ad click. Raw. */
  fbc?: string | null;
  /**
   * The `fbclid` query parameter, captured at landing and carried to the
   * order by the attribution layer. Used to build `fbc` when the cookie is
   * absent — Meta documents the `fb.1.<ms>.<fbclid>` construction for that.
   */
  fbclid?: string | null;
};

export type MetaSendOutcome = {
  delivered: boolean;
  httpStatus: number | null;
  /** Meta's own message, kept verbatim — this is what names a bad field. */
  apiMessage: string | null;
  transportError: string | null;
  /** Meta echoes how many events it accepted. Kept for the diagnostics line. */
  eventsReceived: number | null;
  durationMs: number;
};

export function metaCredentialStatus(env: NodeJS.ProcessEnv = process.env): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!env.META_CONVERSIONS_ACCESS_TOKEN?.trim()) missing.push("META_CONVERSIONS_ACCESS_TOKEN");
  if (!resolvePixelId()) missing.push("NEXT_PUBLIC_META_PIXEL_ID");
  return { configured: missing.length === 0, missing };
}

function resolvePixelId(): string | null {
  return META_PIXEL_ID.trim() || null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Meta's normalisation rules for the postal and name fields, applied before
 * hashing so our digest equals the one Meta computes from its own records:
 * lowercase, no punctuation or whitespace for names and city; two-letter
 * lowercase codes for state and country; the first five digits of a US zip.
 */
export function normalizeNameToken(value: string | null | undefined): string | null {
  const token = String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return token || null;
}

export function splitFullName(fullName: string | null | undefined): { first: string | null; last: string | null } {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: normalizeNameToken(parts[0]), last: null };
  return { first: normalizeNameToken(parts[0]), last: normalizeNameToken(parts[parts.length - 1]) };
}

export function normalizeRegionCode(value: string | null | undefined): string | null {
  const code = String(value ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return code.length === 2 ? code : null;
}

export function normalizeZip(value: string | null | undefined, country: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const isUs = !country || normalizeRegionCode(country) === "us";
  if (isUs) {
    const digits = raw.replace(/\D/g, "").slice(0, 5);
    return digits.length === 5 ? digits : null;
  }
  const compact = raw.replace(/\s+/g, "");
  return compact || null;
}

/**
 * `fbc` from a click id, in the form Meta documents.
 *
 * The cookie the pixel writes wins when present: it carries the timestamp of
 * the actual click. Built from the stored fbclid otherwise, stamped with the
 * time the click was recorded, which is the closest figure the server holds.
 */
export function buildFbc(input: { fbc?: string | null; fbclid?: string | null; clickedAt?: Date | null }): string | null {
  const cookie = String(input.fbc ?? "").trim();
  if (cookie) return cookie;
  const clickId = String(input.fbclid ?? "").trim();
  if (!clickId) return null;
  const at = input.clickedAt instanceof Date && !Number.isNaN(input.clickedAt.getTime()) ? input.clickedAt : new Date();
  return `fb.1.${at.getTime()}.${clickId}`;
}

/**
 * Build the request body.
 *
 * Exported and pure so the shape can be asserted without sending anything —
 * the whole risk here is a field Meta silently ignores, and a test that sent
 * a real request could not run in CI anyway.
 */
export function buildMetaConversionPayload(input: {
  event: MetaEvent;
  user: MetaConversionUser;
  occurredAt: Date;
  eventSourceUrl?: string | null;
  clickedAt?: Date | null;
  testEventCode?: string | null;
}): Record<string, unknown> {
  const { event, user } = input;

  const hashed = buildAdvancedMatching({ email: user.email, phone: user.phone, externalId: user.externalId });

  const userData: Record<string, unknown> = {};
  // Meta takes each hashed key as an array so several values can be offered.
  if (hashed?.email) userData.em = [hashed.email];
  if (hashed?.phone_number) userData.ph = [hashed.phone_number];
  if (hashed?.external_id) userData.external_id = [hashed.external_id];
  const name = splitFullName(user.fullName);
  if (name.first) userData.fn = [sha256(name.first)];
  if (name.last) userData.ln = [sha256(name.last)];
  const city = normalizeNameToken(user.city);
  if (city) userData.ct = [sha256(city)];
  const state = normalizeRegionCode(user.state);
  if (state) userData.st = [sha256(state)];
  const zip = normalizeZip(user.postalCode, user.country);
  if (zip) userData.zp = [sha256(zip)];
  const country = normalizeRegionCode(user.country);
  if (country) userData.country = [sha256(country)];
  if (user.ipAddress) userData.client_ip_address = String(user.ipAddress).trim();
  if (user.userAgent) userData.client_user_agent = String(user.userAgent);
  const fbp = String(user.fbp ?? "").trim();
  if (fbp) userData.fbp = fbp;
  const fbc = buildFbc({ fbc: user.fbc, fbclid: user.fbclid, clickedAt: input.clickedAt });
  if (fbc) userData.fbc = fbc;

  // The browser event's properties are already in Meta's custom_data shape:
  // content_ids, content_type, contents, value, currency, num_items. Sending
  // the identical object is what makes the two legs describe one event.
  const customData: Record<string, unknown> = { ...event.properties };

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: event.name,
        // Unix SECONDS, per the Conversions API reference. Milliseconds would
        // be rejected as a time in the far future.
        event_time: Math.floor(input.occurredAt.getTime() / 1000),
        // The same id the pixel sent. This is the deduplication key.
        event_id: event.eventId,
        action_source: "website",
        ...(input.eventSourceUrl ? { event_source_url: String(input.eventSourceUrl).slice(0, 1200) } : {}),
        user_data: userData,
        custom_data: customData,
      },
    ],
  };
  if (input.testEventCode?.trim()) body.test_event_code = input.testEventCode.trim();
  return body;
}

/**
 * Send one event.
 *
 * Never throws. A conversion report is telemetry: it must not be able to fail
 * the request that a customer is waiting on, and the caller already treats
 * this as best-effort. Everything needed to diagnose a rejection comes back in
 * the outcome instead — including Meta's own message, which names a field it
 * did not accept.
 */
export async function sendMetaConversion(input: {
  event: MetaEvent;
  user: MetaConversionUser;
  occurredAt?: Date;
  eventSourceUrl?: string | null;
  clickedAt?: Date | null;
  testEventCode?: string | null;
  timeoutMs?: number;
}): Promise<MetaSendOutcome> {
  const started = Date.now();
  const base: MetaSendOutcome = {
    delivered: false, httpStatus: null, apiMessage: null, transportError: null, eventsReceived: null, durationMs: 0,
  };
  const done = (patch: Partial<MetaSendOutcome>): MetaSendOutcome => ({
    ...base, ...patch, durationMs: Date.now() - started,
  });

  // K-16. Refuse before the token is read. META_PIXEL_ID falls back to the live
  // production pixel, so a preview deployment, a local run or a CI job carrying
  // a token would post real conversions into the production ad account. Deny by
  // default; see src/lib/ads/ads-environment.ts.
  const environment = serverAdsReportingAllowed();
  if (!environment.allowed) return done({ transportError: `ads reporting disabled: ${environment.reason}` });

  const token = process.env.META_CONVERSIONS_ACCESS_TOKEN?.trim();
  if (!token) return done({ transportError: "META_CONVERSIONS_ACCESS_TOKEN is not set" });

  const pixelId = resolvePixelId();
  if (!pixelId) return done({ transportError: "no Meta pixel id configured" });

  const occurredAt = input.occurredAt ?? new Date();
  if (Date.now() - occurredAt.getTime() > MAX_EVENT_AGE_MS) {
    return done({ transportError: "event is older than Meta's seven-day window" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const payload = buildMetaConversionPayload({
      event: input.event,
      user: input.user,
      occurredAt,
      eventSourceUrl: input.eventSourceUrl,
      clickedAt: input.clickedAt,
      testEventCode: input.testEventCode ?? process.env.META_CONVERSIONS_TEST_EVENT_CODE ?? null,
    });
    const response = await fetch(`${CONVERSIONS_API_BASE}/${GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The only place the token appears. In the body, never the URL; never
      // logged, never returned.
      body: JSON.stringify({ ...payload, access_token: token }),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text().catch(() => "");
    let eventsReceived: number | null = null;
    let apiMessage: string | null = null;
    try {
      const parsed = JSON.parse(text) as { events_received?: number; error?: { message?: string } };
      if (typeof parsed.events_received === "number") eventsReceived = parsed.events_received;
      if (parsed.error?.message) apiMessage = String(parsed.error.message).slice(0, 300);
    } catch {
      apiMessage = text ? text.slice(0, 300) : null;
    }
    return done({
      delivered: response.ok && (eventsReceived ?? 1) > 0,
      httpStatus: response.status,
      apiMessage,
      eventsReceived,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return done({ transportError: message.includes("abort") ? "timed out" : message });
  } finally {
    clearTimeout(timer);
  }
}

/** One line for a log or an admin panel. Never includes the token. */
export function describeMetaResult(outcome: MetaSendOutcome): string {
  if (outcome.delivered) return `meta: delivered in ${outcome.durationMs}ms`;
  if (outcome.transportError) return `meta: ${outcome.transportError}`;
  return `meta: HTTP ${outcome.httpStatus ?? "?"}${outcome.apiMessage ? ` — ${outcome.apiMessage}` : ""}`;
}
