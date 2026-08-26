import "server-only";
import { serverAdsReportingAllowed } from "@/lib/ads/ads-environment";

import { createHash } from "node:crypto";

/**
 * TikTok Events API — server-to-server conversion reporting.
 *
 * This is a different system from `tiktok-client.ts`. That one is Ads
 * Management (create campaigns, publish ads) and is still simulated. This one
 * reports conversions that already happened, and it is real.
 *
 * Why it exists alongside the browser pixel: the pixel is blocked by ad
 * blockers, curtailed by ITP, and lost entirely when a browser closes before
 * the beacon flushes. The server has none of those problems, and for the one
 * event that represents money that difference matters. Both send the same
 * event with the same `event_id`, and TikTok keeps the first arrival and
 * discards duplicates of the same (event_source_id, event, event_id) within 48
 * hours — so sending twice is the design, not a bug.
 *
 * Secret handling: the access token is read from the environment at call time,
 * sent only in a request header, and never returned, logged, or included in
 * any diagnostic. `describeResult` exists specifically so failures can be
 * inspected without anything sensitive travelling with them.
 */

export const EVENTS_API_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
export const PIXEL_ID = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID ?? "D9SAES3C77U40SOI9D70";

/**
 * Unix seconds.
 *
 * Sources disagree here — some integration docs describe an ISO-8601 string,
 * the v1.3 business API describes an epoch. Rather than pick one and hope, the
 * diagnostic route sends a test event and surfaces TikTok's own response: a
 * malformed timestamp comes back as a specific error, at which point this
 * constant flips and nothing else changes.
 */
export const EVENT_TIME_FORMAT: "unix_seconds" | "iso8601" = "unix_seconds";

export function eventTime(date: Date): number | string {
  return EVENT_TIME_FORMAT === "unix_seconds" ? Math.floor(date.getTime() / 1000) : date.toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type ServerUserContext = {
  /** Raw email. Hashed here; never leaves this module unhashed. */
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  /** TikTok click id, captured at landing and carried to the order. */
  ttclid?: string | null;
  /** The _ttp first-party cookie the pixel sets. Improves match quality. */
  ttp?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type ServerEventProperties = {
  contents?: { content_id: string; content_type: "product"; content_name?: string; quantity?: number; price?: number }[];
  currency?: string;
  value?: number;
  /** Ties the conversion to a real order. Also what makes dedup auditable. */
  order_id?: string;
};

export type ServerEvent = {
  event: "ViewContent" | "AddToCart" | "InitiateCheckout" | "Purchase" | "PlaceAnOrder";
  eventId: string;
  occurredAt: Date;
  user: ServerUserContext;
  properties: ServerEventProperties;
  pageUrl?: string | null;
  referrer?: string | null;
};

/**
 * Build the request body.
 *
 * Pure and exported so the exact shape can be asserted in tests without a
 * network call, and so a field-name mistake shows up as a failing test rather
 * than a silent zero-conversion week.
 *
 * Identifiers are hashed and empty ones omitted entirely: a digest of the empty
 * string is a value every user without that field would share, which actively
 * degrades match quality rather than leaving it neutral.
 */
export function buildEventsApiPayload(events: ServerEvent[], options: { testEventCode?: string | null } = {}) {
  return {
    event_source: "web",
    event_source_id: PIXEL_ID,
    // Present only when testing. TikTok routes anything carrying this to Test
    // Events instead of production reporting.
    ...(options.testEventCode ? { test_event_code: options.testEventCode } : {}),
    data: events.map((e) => {
      const user: Record<string, string> = {};
      const email = String(e.user.email ?? "").trim().toLowerCase();
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) user.email = sha256(email);
      const phone = String(e.user.phone ?? "").replace(/\D/g, "");
      if (phone.length >= 8 && phone.length <= 15) user.phone = sha256(phone);
      const externalId = String(e.user.externalId ?? "").trim();
      if (externalId) user.external_id = sha256(externalId.toLowerCase());
      // Click ids and IPs are NOT hashed — TikTok expects them raw.
      if (e.user.ttclid?.trim()) user.ttclid = e.user.ttclid.trim();
      if (e.user.ttp?.trim()) user.ttp = e.user.ttp.trim();
      if (e.user.ip?.trim()) user.ip = e.user.ip.trim();
      if (e.user.userAgent?.trim()) user.user_agent = e.user.userAgent.trim();

      return {
        event: e.event,
        event_time: eventTime(e.occurredAt),
        event_id: e.eventId,
        user,
        properties: e.properties,
        ...(e.pageUrl || e.referrer
          ? { page: { ...(e.pageUrl ? { url: e.pageUrl } : {}), ...(e.referrer ? { referrer: e.referrer } : {}) } }
          : {}),
      };
    }),
  };
}

export type SendOutcome = {
  /** True only when TikTok returned its success code. Never assumed. */
  delivered: boolean;
  /** TikTok's own code. 0 is success; anything else is their error number. */
  tiktokCode: number | null;
  tiktokMessage: string | null;
  /** TikTok's request id, which their support asks for. */
  requestId: string | null;
  httpStatus: number | null;
  /** Set when we never reached them at all. */
  transportError: string | null;
  /** How many events were in the batch. */
  eventCount: number;
  durationMs: number;
};

export type Credentials = { configured: boolean; missing: string[] };

/** Whether we can even attempt a call. Never reveals the token itself. */
export function credentialStatus(env: NodeJS.ProcessEnv = process.env): Credentials {
  const missing: string[] = [];
  if (!env.TIKTOK_EVENTS_API_ACCESS_TOKEN?.trim()) missing.push("TIKTOK_EVENTS_API_ACCESS_TOKEN");
  if (!PIXEL_ID) missing.push("NEXT_PUBLIC_TIKTOK_PIXEL_ID");
  return { configured: missing.length === 0, missing };
}

/**
 * Send a batch.
 *
 * Never throws. A conversion report failing must not surface to a customer or
 * break a page — the worst acceptable outcome is an unreported conversion, and
 * the outcome object carries enough to diagnose that later.
 *
 * A non-2xx or a non-zero TikTok code is NOT treated as delivered. TikTok
 * returns HTTP 200 with an error code in the body for many failures, so
 * checking only the status would report success on a rejected payload — which
 * is precisely the bug that makes people believe tracking works when it does
 * not.
 */
export async function sendServerEvents(
  events: ServerEvent[],
  options: { testEventCode?: string | null; timeoutMs?: number } = {},
): Promise<SendOutcome> {
  const started = Date.now();
  const base: SendOutcome = {
    delivered: false, tiktokCode: null, tiktokMessage: null, requestId: null,
    httpStatus: null, transportError: null, eventCount: events.length, durationMs: 0,
  };

  // K-16. Refuse before the token is even read. PIXEL_ID falls back to the live
  // production pixel, so a preview deployment, a local run or a CI job that
  // happens to carry a token would post real Purchase conversions — carrying real
  // order values — into the production ad account. Deny by default; see
  // src/lib/ads/ads-environment.ts.
  const environment = serverAdsReportingAllowed();
  if (!environment.allowed) {
    return { ...base, transportError: `ads reporting disabled: ${environment.reason}`, durationMs: Date.now() - started };
  }

  const token = process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN?.trim();
  if (!token) {
    return { ...base, transportError: "TIKTOK_EVENTS_API_ACCESS_TOKEN is not set", durationMs: Date.now() - started };
  }
  if (events.length === 0) {
    return { ...base, transportError: "no events to send", durationMs: Date.now() - started };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const response = await fetch(EVENTS_API_URL, {
      method: "POST",
      headers: {
        // The only place the token appears. Never logged, never returned.
        "Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildEventsApiPayload(events, { testEventCode: options.testEventCode })),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: { code?: number; message?: string; request_id?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return {
        ...base,
        httpStatus: response.status,
        transportError: `response was not JSON (${text.slice(0, 200)})`,
        durationMs: Date.now() - started,
      };
    }

    return {
      ...base,
      delivered: response.ok && parsed.code === 0,
      tiktokCode: typeof parsed.code === "number" ? parsed.code : null,
      tiktokMessage: parsed.message ?? null,
      requestId: parsed.request_id ?? null,
      httpStatus: response.status,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      transportError: controller.signal.aborted ? "timed out" : message,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A one-line diagnostic safe to log or show an admin.
 *
 * Deliberately built from a fixed set of fields rather than by serialising the
 * outcome, so a future field carrying something sensitive cannot leak into a
 * log by accident.
 */
export function describeResult(outcome: SendOutcome): string {
  if (outcome.transportError) {
    return `TikTok Events API: NOT SENT — ${outcome.transportError} (${outcome.durationMs}ms)`;
  }
  if (outcome.delivered) {
    return `TikTok Events API: delivered ${outcome.eventCount} event(s), code 0, request ${outcome.requestId ?? "?"} (${outcome.durationMs}ms)`;
  }
  return (
    `TikTok Events API: REJECTED — HTTP ${outcome.httpStatus ?? "?"}, code ${outcome.tiktokCode ?? "?"}, ` +
    `"${outcome.tiktokMessage ?? "no message"}", request ${outcome.requestId ?? "?"} (${outcome.durationMs}ms)`
  );
}

/**
 * Guard against a secret ever reaching a log or a response.
 *
 * Belt and braces: nothing above puts the token in an outcome, and this makes
 * a future mistake fail a test rather than ship.
 */
export function assertNoSecret(text: string, env: NodeJS.ProcessEnv = process.env): void {
  const token = env.TIKTOK_EVENTS_API_ACCESS_TOKEN?.trim();
  if (token && token.length >= 8 && text.includes(token)) {
    throw new Error("refusing to emit text containing the Events API access token");
  }
}
