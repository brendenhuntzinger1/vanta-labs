import { getSiteUrl } from "@/lib/env";

/**
 * UTM tagging for the links that leave in email.
 *
 * WHY THIS EXISTS. Every click already lands on a click-tracked redirect, and
 * the in-house attribution that redirect feeds is the number this business
 * actually trusts — it is net of refunds and it refuses to credit one order to
 * two channels (see automation-stats.ts). But GA4 files an untagged arrival
 * from a mail client under `direct`, so the analytics dashboard credited email
 * with nothing, and there was no way to reconcile the two. Tagging the
 * destination fixes the disagreement without touching the attribution the
 * business runs on.
 *
 * WHERE IT BELONGS. On the way OUT of the click route, applied to an
 * already-resolved same-origin destination — never baked into the link in the
 * email. The link in the email carries only a campaign id and a signature; a
 * `utm_*` on it would be a query parameter an attacker could edit, and the
 * redirect deliberately reads its destination from stored state instead.
 *
 * This module is pure and takes no database. It is deliberately NOT
 * `server-only`: nothing here touches a secret, and keeping it importable
 * either way means the admin preview can show the operator the exact URL a
 * recipient will land on.
 */

/** The medium value per sending family. Written once so a typo cannot split a channel in two. */
export const UTM_MEDIUM = {
  campaign: "campaign",
  automation: "automation",
  cartRecovery: "cart_recovery",
} as const;

/** Every email link this system emits is `utm_source=email`. */
export const UTM_SOURCE_EMAIL = "email";

export type UtmParams = {
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
};

function clean(value: string | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Append UTM parameters to an already-resolved destination.
 *
 * THE OPERATOR'S OWN TAGGING WINS. A stored `cta_path` that already carries a
 * `utm_campaign` was tagged deliberately — usually to line an email up with a
 * paid campaign running under that name. Overwriting it would silently split
 * one campaign's reporting across two names, so an existing key is left exactly
 * as it is and only the missing ones are filled in.
 *
 * OFF-SITE URLS ARE LEFT ALONE. Destinations reaching this function are already
 * resolved to this origin by safeCampaignDestination / safeAutomationDestination,
 * so this is defence in depth rather than the primary control — but tagging is
 * not the place to rely on that: appending a campaign id to a third-party URL
 * would leak an internal identifier into somebody else's analytics.
 *
 * An unparseable destination is returned untouched rather than thrown on, for
 * the same reason destinationForVisitor swallows its parse failure: a tracking
 * route must always redirect somewhere.
 */
export function withUtm(destination: string, params: UtmParams, siteOrigin: string = safeOrigin()): string {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return destination;
  }

  if (!siteOrigin || url.origin !== siteOrigin) return destination;

  const pairs: Array<[string, string]> = [
    ["utm_source", clean(params.source)],
    ["utm_medium", clean(params.medium)],
    ["utm_campaign", clean(params.campaign)],
    ["utm_content", clean(params.content)],
    ["utm_term", clean(params.term)],
  ];

  for (const [key, value] of pairs) {
    // A blank value writes nothing at all — `utm_campaign=` is worse than
    // absent, because it reads as a real (empty) campaign in a report.
    if (!value) continue;
    if (url.searchParams.has(key)) continue;
    url.searchParams.set(key, value);
  }

  return url.toString();
}

/**
 * The site origin, or "" when it cannot be determined.
 *
 * getSiteUrl() throws in production when the variable is missing. Tagging must
 * never be the thing that breaks a redirect, so a missing origin degrades to
 * "no tagging" rather than to an exception.
 */
function safeOrigin(): string {
  try {
    return new URL(getSiteUrl()).origin;
  } catch {
    return "";
  }
}

/** Tag a broadcast campaign's destination with the campaign's own id. */
export function utmForCampaign(destination: string, campaignId: string, content?: string): string {
  return withUtm(destination, {
    source: UTM_SOURCE_EMAIL,
    medium: UTM_MEDIUM.campaign,
    campaign: campaignId,
    content,
  });
}

/** Tag an automation's destination with its stable automation key. */
export function utmForAutomation(destination: string, automationKey: string, content?: string): string {
  return withUtm(destination, {
    source: UTM_SOURCE_EMAIL,
    medium: UTM_MEDIUM.automation,
    campaign: automationKey,
    content,
  });
}

/**
 * Tag a cart-recovery destination.
 *
 * The stage rides in `utm_content` rather than `utm_campaign` so the whole
 * sequence rolls up as one campaign in a report while staying separable —
 * which is the question actually worth asking of it ("is the last email worth
 * sending?").
 *
 * The value is the `stage` column the sweep already writes (`t30m` | `t12h` |
 * `t24h` | `t72h`), passed straight through rather than renumbered, so a row in
 * the database and a row in GA4 carry the same name. A null stage — the read
 * failed, and that read is deliberately non-fatal — still tags the channel:
 * knowing the click was cart recovery is worth more than knowing nothing.
 */
export function utmForCartRecovery(destination: string, stage: string | null | undefined): string {
  return withUtm(destination, {
    source: UTM_SOURCE_EMAIL,
    medium: UTM_MEDIUM.cartRecovery,
    campaign: UTM_MEDIUM.cartRecovery,
    content: clean(stage ?? undefined),
  });
}
