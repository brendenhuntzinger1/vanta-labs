import "server-only";

import { createHash } from "node:crypto";
import { hashRedditEmail, hashRedditExternalId } from "@/lib/ads/reddit-matching";
import type { RedditEvent } from "@/lib/ads/reddit-events";
import { REDDIT_PIXEL_ID } from "@/lib/ads/reddit-pixel-id";

/**
 * Reddit Conversions API — the server-side leg.
 *
 * WHY IT EXISTS. The browser pixel is the only path today, and a meaningful
 * share of it never arrives: ad blockers, tracking-protection defaults, a tab
 * closed before the request flushes. This reports the same purchase from the
 * server, where none of that applies. Both legs carry the same conversion_id,
 * so Reddit counts ONE conversion — that is what the pixel's conversionId work
 * was groundwork for.
 *
 * THE ENDPOINT IS KEYED ON THE PIXEL, NOT THE AD ACCOUNT, and it is v3. Both
 * details come from the cURL sample in this account's own Events Manager, which
 * beats every third-party write-up of the v2 shape:
 *
 *   POST https://ads-api.reddit.com/api/v3/pixels/<pixel_id>/conversion_events
 *   Authorization: Bearer <token>
 *   { "data": { "events": [ { event_at, action_source, type: { tracking_type } } ] } }
 *
 * ATTRIBUTION SIGNAL. Reddit drops an event that carries no way to identify the
 * person: it needs a click id, an email, or IP + user agent. A paid order gives
 * us the email, hashed here with Reddit's own canonicalisation, so the raw
 * address never leaves the server — the same rule the pixel follows.
 */

const CONVERSIONS_API_BASE = "https://ads-api.reddit.com/api/v3/pixels";
const DEFAULT_TIMEOUT_MS = 8000;

/** Reddit rejects anything older than seven days. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type RedditConversionUser = {
  email?: string | null;
  externalId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Reddit's click id (`rdt_cid`), when an ad click can be traced to the order. */
  clickId?: string | null;
};

export type RedditSendOutcome = {
  delivered: boolean;
  httpStatus: number | null;
  /** Reddit's own message, kept verbatim — this is what names a bad field. */
  apiMessage: string | null;
  transportError: string | null;
  durationMs: number;
};

export function redditCredentialStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN?.trim()) missing.push("REDDIT_CONVERSIONS_ACCESS_TOKEN");
  if (!resolvePixelId()) missing.push("NEXT_PUBLIC_REDDIT_PIXEL_ID");
  return { configured: missing.length === 0, missing };
}

function resolvePixelId(): string | null {
  return REDDIT_PIXEL_ID.trim() || null;
}

/**
 * Build the request body.
 *
 * Exported and pure so the shape can be asserted without sending anything —
 * the whole risk here is a field name Reddit silently ignores, and a test that
 * sent a real request could not run in CI anyway.
 */
export function buildRedditConversionPayload(input: {
  event: RedditEvent;
  user: RedditConversionUser;
  occurredAt: Date;
}): Record<string, unknown> {
  const { event, user } = input;

  const hashedEmail = hashRedditEmail(user.email);
  const hashedExternalId = hashRedditExternalId(user.externalId);

  const userPayload: Record<string, unknown> = {};
  if (hashedEmail) userPayload.email = hashedEmail;
  if (hashedExternalId) userPayload.external_id = hashedExternalId;
  // Hashed for the same reason the address is. If Reddit turns out to want the
  // raw value here, the cost is a weaker match on this one signal — never a
  // rejected event, because the email above already satisfies the requirement.
  if (user.ipAddress) userPayload.ip_address = sha256(String(user.ipAddress).trim().toLowerCase());
  if (user.userAgent) userPayload.user_agent = String(user.userAgent);

  const metadata: Record<string, unknown> = { currency: event.properties.currency };
  if (typeof event.properties.value === "number") metadata.value_decimal = event.properties.value;
  if (typeof event.properties.itemCount === "number") metadata.item_count = event.properties.itemCount;
  if (event.properties.conversionId) metadata.conversion_id = event.properties.conversionId;
  if (event.properties.products?.length) {
    metadata.products = event.properties.products.map((item) => ({
      id: item.id,
      ...(item.name ? { name: item.name } : {}),
      ...(item.category ? { category: item.category } : {}),
    }));
  }

  return {
    data: {
      events: [
        {
          // Milliseconds, per the console sample. Seconds would land in 1970 and
          // be silently dropped as older than seven days.
          event_at: input.occurredAt.getTime(),
          action_source: "website",
          type: { tracking_type: event.name },
          ...(user.clickId ? { click_id: String(user.clickId) } : {}),
          ...(Object.keys(userPayload).length > 0 ? { user: userPayload } : {}),
          event_metadata: metadata,
        },
      ],
    },
  };
}

/**
 * Send one conversion.
 *
 * Never throws. A conversion report is telemetry: it must not be able to fail
 * the request that a customer is waiting on, and the caller already treats this
 * as best-effort. Everything needed to diagnose a rejection comes back in the
 * outcome instead — including Reddit's own message, which is what names a field
 * it did not recognise.
 */
export async function sendRedditConversion(input: {
  event: RedditEvent;
  user: RedditConversionUser;
  occurredAt?: Date;
  timeoutMs?: number;
}): Promise<RedditSendOutcome> {
  const started = Date.now();
  const base: RedditSendOutcome = {
    delivered: false, httpStatus: null, apiMessage: null, transportError: null, durationMs: 0,
  };
  const done = (patch: Partial<RedditSendOutcome>): RedditSendOutcome => ({
    ...base, ...patch, durationMs: Date.now() - started,
  });

  const token = process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN?.trim();
  if (!token) return done({ transportError: "REDDIT_CONVERSIONS_ACCESS_TOKEN is not set" });

  const pixelId = resolvePixelId();
  if (!pixelId) return done({ transportError: "no Reddit pixel id configured" });

  const occurredAt = input.occurredAt ?? new Date();
  if (Date.now() - occurredAt.getTime() > MAX_EVENT_AGE_MS) {
    // Reddit would reject it anyway; saying so plainly beats a 400 nobody reads.
    return done({ transportError: "event is older than Reddit's seven-day window" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${CONVERSIONS_API_BASE}/${encodeURIComponent(pixelId)}/conversion_events`, {
      method: "POST",
      headers: {
        // The only place the token appears. Never logged, never returned.
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildRedditConversionPayload({ event: input.event, user: input.user, occurredAt })),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text().catch(() => "");
    return done({
      // A 2xx is the only success signal Reddit gives here. The body is kept
      // regardless: on a rejection it names the field, which is the single most
      // useful thing to have when the payload shape is the risk.
      delivered: response.ok,
      httpStatus: response.status,
      apiMessage: text ? text.slice(0, 300) : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return done({ transportError: message.includes("abort") ? "timed out" : message });
  } finally {
    clearTimeout(timer);
  }
}

/** One line for a log or an admin panel. Never includes the token. */
export function describeRedditResult(outcome: RedditSendOutcome): string {
  if (outcome.delivered) return `reddit: delivered in ${outcome.durationMs}ms`;
  if (outcome.transportError) return `reddit: ${outcome.transportError}`;
  return `reddit: HTTP ${outcome.httpStatus ?? "?"}${outcome.apiMessage ? ` — ${outcome.apiMessage}` : ""}`;
}
