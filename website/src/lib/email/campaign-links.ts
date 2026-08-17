import "server-only";

import crypto from "crypto";
import { getSiteUrl } from "@/lib/env";
import { resolveSitePath } from "@/lib/email/cta-path";

/**
 * Click-tracked campaign links, and the attribution cookie they set.
 *
 * THE DESTINATION IS NEVER TAKEN FROM THE URL. A tracking redirect that accepts
 * its target as a query parameter is an open redirect, and an open redirect on
 * a domain customers have been trained to click in email is worth real money to
 * a phisher. Here the redirect carries only a campaign id; the destination is
 * read from that campaign's stored `cta_path`, which the API layer already
 * constrains to a site-relative path. There is no input an attacker can supply
 * that changes where someone lands.
 *
 * The recipient's address IS in the link, because attribution needs to know who
 * clicked — so it is signed. Without the HMAC anyone could enumerate the list by
 * editing a link and have the click recorded against an address that never
 * received the campaign, which would quietly corrupt every campaign metric.
 */

const CAMPAIGN_COOKIE = "vl_campaign";

/**
 * Seven days, matching the industry-standard click-attribution window.
 *
 * The number is a judgement call, not a fact, so it is named and stated rather
 * than buried: a click that leads to an order eight days later is not credited.
 * Widening it inflates campaign revenue by absorbing orders the campaign didn't
 * cause; narrowing it under-reports genuinely slow buyers.
 */
export const ATTRIBUTION_WINDOW_DAYS = 7;
export const ATTRIBUTION_WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export { CAMPAIGN_COOKIE };

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign campaign links (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

/** Signature binding a recipient to a campaign. Truncated to keep links short. */
export function signCampaignRecipient(campaignId: string, email: string): string {
  return crypto
    .createHmac("sha256", signingSecret())
    .update(`${campaignId}:${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyCampaignRecipient(campaignId: string, email: string, token: string): boolean {
  try {
    const expected = Buffer.from(signCampaignRecipient(campaignId, email));
    const provided = Buffer.from(token);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/** The click-tracked CTA URL that goes in the email. */
export function buildCampaignClickUrl(campaignId: string, email: string): string {
  const params = new URLSearchParams({
    c: campaignId,
    e: email.trim().toLowerCase(),
    t: signCampaignRecipient(campaignId, email),
  });
  return `${getSiteUrl()}/api/email/click?${params.toString()}`;
}

/** The open-tracking pixel URL. Same signature scheme. */
export function buildCampaignOpenUrl(campaignId: string, email: string): string {
  const params = new URLSearchParams({
    c: campaignId,
    e: email.trim().toLowerCase(),
    t: signCampaignRecipient(campaignId, email),
  });
  return `${getSiteUrl()}/api/email/open?${params.toString()}`;
}

/**
 * Normalise a stored CTA path into a safe, same-origin destination.
 *
 * Rejects anything that could leave this site. `//evil.com` is the case worth
 * naming: it is protocol-relative, so a browser treats it as an absolute URL to
 * another host even though it passes a naive "starts with /" check.
 */
export function safeCampaignDestination(ctaPath: string | null | undefined): string {
  // The last line of defence, and the one that actually protects customers:
  // the API layers validate on the way in, but this runs on the way out, so a
  // row written before those checks existed — or by hand — still cannot send
  // anyone off-site. Resolution-based, not prefix-based; see cta-path.ts.
  return resolveSitePath(String(ctaPath ?? "").trim(), getSiteUrl());
}

/**
 * Read the attribution cookie off a plain `Request`.
 *
 * The checkout route handler takes a `Request`, not a `NextRequest`, so it has
 * no `.cookies` accessor. Parsing the header here beats widening that handler's
 * signature for one optional read — and beats `cookies()` from next/headers,
 * which would make this module unusable from anywhere outside a request scope.
 */
export function readCampaignCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CAMPAIGN_COOKIE) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

/** True while a stamped click is still inside the attribution window. */
export function isWithinAttributionWindow(clickedAtMs: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(clickedAtMs)) return false;
  const age = now - clickedAtMs;
  return age >= 0 && age <= ATTRIBUTION_WINDOW_MS;
}

/** Encode the attribution cookie value. */
export function encodeAttributionCookie(campaignId: string, clickedAtMs: number): string {
  return `${campaignId}.${clickedAtMs}`;
}

/**
 * Decode the attribution cookie, returning null when it is absent, malformed,
 * or outside the window.
 *
 * Expiry is enforced HERE as well as by the cookie's Max-Age, because a cookie
 * lifetime is a request from the server that the client is free to ignore, and
 * attribution that can be extended by editing a cookie is not attribution.
 */
export function decodeAttributionCookie(
  value: string | null | undefined,
  now: number = Date.now(),
): { campaignId: string; clickedAtMs: number } | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const campaignId = value.slice(0, separator);
  const clickedAtMs = Number(value.slice(separator + 1));
  if (!campaignId || !Number.isFinite(clickedAtMs)) return null;
  if (!isWithinAttributionWindow(clickedAtMs, now)) return null;
  return { campaignId, clickedAtMs };
}
