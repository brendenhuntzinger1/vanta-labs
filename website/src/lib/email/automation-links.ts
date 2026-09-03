import "server-only";

import crypto from "crypto";
import { getSiteUrl } from "@/lib/env";
import { resolveSitePath } from "@/lib/email/cta-path";

/**
 * Click- and open-tracked links for the retention automations.
 *
 * The deliberate twin of campaign-links.ts, and separate from it on purpose.
 * Automations are not campaigns: they have no queue, no recipient rows and no
 * UUID — an automation's identity is a text key, and a single SEND's identity
 * is that key plus a reference (an address, an order id, or an
 * `${email}:${lastOrderAt}` win-back episode). Bending the campaign scheme
 * around that produced three silent failure modes; see the header of
 * sql/email-automation-tracking.sql for what they were.
 *
 * WHAT IS SHARED IS THE PART THAT CARRIES CORRECTNESS. Same HMAC construction,
 * same truncation, same timing-safe comparison, and the same rule that the
 * destination is read from the database on the way out rather than taken from
 * the URL. An open redirect on a domain customers trust because it arrived in
 * our email is worth real money to a phisher, and that is as true of an
 * automation link as of a campaign one.
 */

/** Seven days, matching the campaign attribution window exactly. */
export { ATTRIBUTION_WINDOW_DAYS, ATTRIBUTION_WINDOW_MS } from "@/lib/email/campaign-links";
import { ATTRIBUTION_WINDOW_MS, isWithinAttributionWindow } from "@/lib/email/campaign-links";

/**
 * A DIFFERENT cookie from `vl_campaign`, not a shared one carrying a prefixed
 * value.
 *
 * Two reasons, and the second is the one that matters. First, an order can
 * legitimately follow both a campaign click and an automation click, and
 * collapsing them into one slot would silently drop whichever came second.
 * Second, and structurally: attributeOrderToCampaign reads `vl_campaign` and
 * looks the value up in email_campaigns. Writing an automation key into that
 * cookie makes every automation click a campaign click that resolves to
 * `unknown_campaign` — no error, no attribution, and a reader of the code with
 * no reason to suspect it.
 */
export const AUTOMATION_COOKIE = "vl_automation";

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign automation links (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

/**
 * Signature binding one recipient to one SEND of one automation.
 *
 * NOTE THE `automation:` PREFIX. It is not decoration. Without it this signs
 * `${key}:${email}`, which is the same shape campaign-links.ts signs with the
 * same secret — so a token minted for a campaign whose id happened to collide
 * with an automation key would verify here, and vice versa. Namespacing the
 * payload makes the two token spaces provably disjoint whatever the ids look
 * like.
 *
 * The reference is inside the signature for the same reason the link index is
 * inside the campaign one: it decides which row the click is recorded against,
 * so it must not be editable. It is also what stops a link being eternal — a
 * customer won back a second time gets a new reference and therefore a new
 * link, instead of one signature that verifies forever.
 */
export function signAutomationLink(automationKey: string, email: string, referenceId: string): string {
  return crypto
    .createHmac("sha256", signingSecret())
    .update(`automation:${automationKey}:${email.trim().toLowerCase()}:${referenceId}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyAutomationLink(
  automationKey: string,
  email: string,
  referenceId: string,
  token: string,
): boolean {
  try {
    const expected = Buffer.from(signAutomationLink(automationKey, email, referenceId));
    const provided = Buffer.from(token);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/** The click-tracked CTA URL that goes in an automation email. */
export function buildAutomationClickUrl(
  automationKey: string,
  email: string,
  referenceId: string,
  offerToken?: string,
): string {
  const params = new URLSearchParams({
    k: automationKey,
    e: email.trim().toLowerCase(),
    r: referenceId,
    t: signAutomationLink(automationKey, email, referenceId),
  });
  // THE OFFER TOKEN RIDES ALONG, AND IT IS NOT A DESTINATION.
  //
  // The rule this route lives by is that nothing in the query string can
  // change where somebody lands — the destination is read from the automation
  // row. That rule is intact: `o` names no path and no host. It is an opaque
  // bearer secret that the click route hands to the landing page, and the only
  // thing that can interpret it is the customer_offers lookup, server-side, at
  // checkout.
  //
  // It is deliberately NOT inside the HMAC. The signature binds the click to a
  // recipient and a send; the token binds an offer to an address, and it is
  // verified by being looked up rather than by being signed. Signing it twice
  // would add a second thing to keep in step and no security.
  if (offerToken) params.set("o", offerToken);
  return `${getSiteUrl().replace(/\/$/, "")}/api/email/automation-click?${params.toString()}`;
}

/** The open-tracking pixel URL. Same signature, same scheme. */
export function buildAutomationOpenUrl(automationKey: string, email: string, referenceId: string): string {
  const params = new URLSearchParams({
    k: automationKey,
    e: email.trim().toLowerCase(),
    r: referenceId,
    t: signAutomationLink(automationKey, email, referenceId),
  });
  return `${getSiteUrl().replace(/\/$/, "")}/api/email/automation-open?${params.toString()}`;
}

/**
 * Normalise a stored automation CTA path into a safe, same-origin destination.
 *
 * Identical guarantee to safeCampaignDestination, and identically the last line
 * of defence: the admin API validates on the way IN, this runs on the way OUT,
 * so a row written by hand or before those checks existed still cannot send
 * anyone off-site.
 */
export function safeAutomationDestination(ctaPath: string | null | undefined): string {
  return resolveSitePath(String(ctaPath ?? "").trim(), getSiteUrl());
}

/** Encode the automation attribution cookie value. */
export function encodeAutomationCookie(automationKey: string, clickedAtMs: number): string {
  return `${automationKey}.${clickedAtMs}`;
}

/**
 * Decode it, returning null when absent, malformed, or outside the window.
 *
 * Split on the LAST dot, so a key containing one is still parsed correctly.
 * Expiry is re-checked here as well as by the cookie's Max-Age, because a
 * cookie lifetime is a request the client is free to ignore, and attribution
 * that can be extended by editing a cookie is not attribution.
 */
export function decodeAutomationCookie(
  value: string | null | undefined,
  now: number = Date.now(),
): { automationKey: string; clickedAtMs: number } | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const automationKey = value.slice(0, separator);
  const clickedAtMs = Number(value.slice(separator + 1));
  if (!automationKey || !Number.isFinite(clickedAtMs)) return null;
  if (!isWithinAttributionWindow(clickedAtMs, now)) return null;
  return { automationKey, clickedAtMs };
}

/**
 * Read the automation cookie off a plain `Request`.
 *
 * The checkout route handler takes a `Request`, not a `NextRequest`, so it has
 * no `.cookies` accessor — same constraint readCampaignCookie was written for.
 */
export function readAutomationCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== AUTOMATION_COOKIE) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export const AUTOMATION_COOKIE_MAX_AGE_SECONDS = Math.floor(ATTRIBUTION_WINDOW_MS / 1000);
