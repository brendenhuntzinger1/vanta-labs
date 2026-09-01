/**
 * Personalisation variables for affiliate campaigns.
 *
 * PURE, AND DELIBERATELY WITHOUT A DATABASE. The rules here decide what a real
 * affiliate reads in a message about their own money, so they have to be
 * assertable without standing up Postgres — which is why the merge CONTEXT is
 * passed in rather than looked up. Where that context comes from, and why it is
 * snapshotted at queue time rather than resolved per batch, is
 * lib/email/affiliate-audience.ts and the affiliate-email-system.sql comment.
 *
 * THIS MODULE DOES NOT ESCAPE, ON PURPOSE. Substitution happens BEFORE
 * `campaignTemplate`, which runs the whole body through `escapeHtml`. Escaping
 * here as well would double-encode, and an affiliate called "Ben & Co" would be
 * greeted as "Ben &amp; Co". The ordering is the safety property: a merge value
 * cannot introduce markup, because it is escaped by the same pass that escapes
 * everything else the owner typed.
 */

export type AffiliateMergeContext = {
  firstName: string | null;
  referralCode: string;
  referralLink: string;
  commissionPercent: number;
  dashboardLink: string;
};

/**
 * What the composer offers as clickable chips, and the only tokens that resolve.
 *
 * Kept as one list because a token advertised in the UI but unhandled by the
 * renderer reaches a real affiliate as literal "{{...}}" text. The test suite
 * walks this array and renders each entry, so the two cannot drift.
 */
export const AFFILIATE_MERGE_FIELDS = [
  { token: "first_name", label: "First name", hint: "Falls back to \"there\" when we have no name on file." },
  { token: "referral_code", label: "Referral code", hint: "Their referral code, e.g. JORDAN10." },
  { token: "referral_link", label: "Referral link", hint: "Their tracked link — sharing it credits them automatically." },
  { token: "commission_percent", label: "Commission %", hint: "Their current rate, without trailing zeros." },
  { token: "affiliate_dashboard_link", label: "Affiliate dashboard", hint: "Links straight into their own dashboard." },
] as const;

/**
 * Older spellings that keep working.
 *
 * These resolve exactly like their canonical twin and are deliberately NOT
 * offered in the composer, so there is one name per idea on screen and no way
 * for a saved draft written against an earlier spelling to start rendering
 * literal "{{...}}" text at an affiliate.
 */
const MERGE_ALIASES: Record<string, AffiliateMergeToken> = {
  affiliate_code: "referral_code",
  dashboard_link: "affiliate_dashboard_link",
};

export type AffiliateMergeToken = (typeof AFFILIATE_MERGE_FIELDS)[number]["token"];

/**
 * "Hey there," rather than "Hey ,".
 *
 * Pre-added affiliates and older applications can have no first name at all, so
 * this is a routine case, not an edge one.
 */
export const MISSING_FIRST_NAME_FALLBACK = "there";

/** Matches `{{ token }}` in any case, with or without inner spacing. */
const TOKEN_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

const KNOWN_TOKENS = new Set<string>([
  ...AFFILIATE_MERGE_FIELDS.map((field) => field.token),
  ...Object.keys(MERGE_ALIASES),
]);

/**
 * A rate, not a database column.
 *
 * `commission_percent` is numeric(5,2), so Supabase hands back 15.00 and
 * "you earn 15.00%" reads like a bug to the person being paid it. A corrupt
 * value renders 0 rather than NaN — the same direction referral-qualification.ts
 * takes with a corrupt minimum: degrade to something harmless and sayable.
 */
export function formatCommissionPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // Two decimal places is the column's precision; trailing zeros are noise.
  return String(Number(value.toFixed(2)));
}

function firstNameOrFallback(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return MISSING_FIRST_NAME_FALLBACK;
  // A greeting takes one name. Applications routinely carry a full name in the
  // first-name field, and "Hey Jordan Alvarez," reads like a form letter.
  return trimmed.split(/\s+/)[0];
}

function resolveToken(token: string, context: AffiliateMergeContext): string | null {
  const lowered = token.toLowerCase();
  const canonical = (MERGE_ALIASES[lowered] ?? lowered) as AffiliateMergeToken;
  switch (canonical) {
    case "first_name":
      return firstNameOrFallback(context.firstName);
    case "referral_code":
      return String(context.referralCode ?? "");
    case "referral_link":
      return String(context.referralLink ?? "");
    case "commission_percent":
      return formatCommissionPercent(Number(context.commissionPercent));
    case "affiliate_dashboard_link":
      return String(context.dashboardLink ?? "");
    default:
      return null;
  }
}

/**
 * Substitute every known variable. SINGLE PASS, and that is a rule not an
 * implementation detail: `String.replace` with a function never re-scans what it
 * has just written, so an affiliate whose stored first name is the literal text
 * "{{referral_link}}" gets that text and not a second expansion.
 *
 * An unknown token is left exactly as typed. Deleting it would silently remove
 * words from a message the owner wrote; leaving it visible is recoverable, and
 * `validateMergeFields` is what stops it reaching anyone in the first place.
 */
export function renderAffiliateMergeFields(text: string, context: AffiliateMergeContext): string {
  return String(text ?? "").replace(TOKEN_PATTERN, (match, token: string) => {
    const resolved = resolveToken(token, context);
    return resolved === null ? match : resolved;
  });
}

/** Every unrecognised variable in the given fields, in the order they appear, deduped. */
export function findUnknownMergeFields(...fields: Array<string | null | undefined>): string[] {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    for (const match of String(field ?? "").matchAll(TOKEN_PATTERN)) {
      const token = match[1].toLowerCase();
      if (KNOWN_TOKENS.has(token) || seen.has(token)) continue;
      seen.add(token);
      unknown.push(token);
    }
  }
  return unknown;
}

/**
 * The compose-time gate.
 *
 * This is the only place a mistyped variable can still be fixed for free. Once a
 * campaign is queued, "{{firstname}}" is in a message that cannot be recalled,
 * so the composer refuses to save rather than warning.
 */
export function validateMergeFields(...fields: Array<string | null | undefined>): { ok: true } | { ok: false; error: string } {
  const unknown = findUnknownMergeFields(...fields);
  if (unknown.length === 0) return { ok: true };
  const named = unknown.map((token) => `{{${token}}}`).join(", ");
  const available = AFFILIATE_MERGE_FIELDS.map((field) => `{{${field.token}}}`).join(", ");
  return {
    ok: false,
    error: `Unknown personalisation ${unknown.length === 1 ? "variable" : "variables"}: ${named}. Available: ${available}.`,
  };
}

/**
 * The stand-in context behind Preview and Test Send.
 *
 * Obviously a sample — the code says SAMPLE — because a preview that looks like
 * real affiliate data invites the owner to believe a specific person's rate has
 * been checked. The links are real site URLs so a test send is clickable and the
 * button can be verified end to end.
 */
export function buildSampleMergeContext(siteUrl: string): AffiliateMergeContext {
  const origin = String(siteUrl ?? "").replace(/\/$/, "");
  return {
    firstName: "Jordan",
    referralCode: "SAMPLE10",
    referralLink: `${origin}/r/SAMPLE10`,
    commissionPercent: 15,
    dashboardLink: `${origin}/account/ambassador`,
  };
}
