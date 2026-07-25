// ============================================================================
// Referral-code validation & normalization — the single, shared rule engine for
// custom ambassador codes. Pure + fully testable; the server layer adds the DB
// uniqueness check on top. Used by: the ambassador self-serve editor, the admin
// force-change/reserve tools, and application preferred-code handling.
// ============================================================================

export interface ReferralCodeRules {
  minLength: number;
  maxLength: number;
}

export const DEFAULT_REFERRAL_CODE_RULES: ReferralCodeRules = { minLength: 4, maxLength: 20 };

// Normalize consistently everywhere: decompose Unicode look-alikes to their
// ASCII base, strip combining marks, drop ALL whitespace (defeats whitespace
// tricks), uppercase (case-insensitive), then keep ONLY [A-Z0-9_-]. Anything a
// URL/route could choke on is removed here, so the stored value is always safe.
export function normalizeReferralCode(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

// Collapse separators so look-alikes collide for duplicate detection:
// "VIP-1", "VIP_1", and "VIP1" all share the fingerprint "VIP1". The DB
// uniqueness check compares fingerprints so two ambassadors can't hold codes
// that only differ by a hyphen/underscore.
export function referralCodeFingerprint(raw: string | null | undefined): string {
  return normalizeReferralCode(raw).replace(/[-_]/g, "");
}

// Reserved: app routes, staff/brand terms, and money/security words. Compared
// both against the whole normalized code AND its separator-stripped fingerprint
// (so "A-D-M-I-N" can't sneak past).
export const RESERVED_REFERRAL_CODES = new Set<string>([
  // protected app routes
  "ADMIN", "ADMINISTRATOR", "ACCOUNT", "API", "AMBASSADOR", "AMBASSADORS",
  "CART", "CHECKOUT", "COA", "COALIBRARY", "CONTACT", "LEGAL", "LOGIN", "LOGOUT",
  "MAINTENANCE", "MEMBERSHIP", "ORDER", "ORDERS", "ORDERCONFIRMATION", "PARTNER",
  "PARTNERS", "PAY", "PRODUCT", "PRODUCTS", "R", "RESEARCH", "VAULT",
  // auth / signup
  "SIGNIN", "SIGNUP", "REGISTER", "PASSWORD", "RESET", "VERIFY",
  // staff / roles / brand
  "STAFF", "MANAGER", "OWNER", "ROOT", "SYSTEM", "SUPERADMIN", "SECURITY",
  "SUPPORT", "HELP", "TEAM", "VANTA", "VANTALABS", "VANTALAB",
  // money / program terms
  "AFFILIATE", "COMMISSION", "COMMISSIONS", "PAYOUT", "PAYOUTS", "REFUND",
  "REFUNDS", "DISCOUNT", "COUPON", "PROMO", "PROMOTION", "FREE", "REFERRAL",
  "REFERRALS", "CODE",
  // infra / reserved technical
  "WWW", "MAIL", "EMAIL", "FTP", "TEST", "MOCK", "STAGING", "PROD", "PRODUCTION",
  "NULL", "UNDEFINED", "NONE", "TOKEN", "SECRET", "WEBHOOK",
]);

// Minimal but real profanity screen (substring match on the letters-only form).
const PROFANITY_SUBSTRINGS = [
  "FUCK", "SHIT", "BITCH", "CUNT", "ASSHOLE", "NIGGER", "NIGGA", "FAGGOT", "FAG",
  "DICK", "PUSSY", "SLUT", "WHORE", "RETARD", "NAZI", "RAPE", "COCK", "BASTARD",
  "CUM", "JIZZ", "TWAT", "WANK",
];

export type ReferralCodeRejectReason =
  | "empty" | "too_short" | "too_long" | "invalid_chars"
  | "edge_separator" | "repeated_separator" | "reserved" | "profanity";

export interface ReferralCodeFormatResult {
  ok: boolean;
  code: string;                    // normalized, canonical value to store
  fingerprint: string;             // look-alike key for uniqueness checks
  reason?: ReferralCodeRejectReason;
  error?: string;                  // human-readable, safe to show the ambassador
}

function reject(code: string, reason: ReferralCodeRejectReason, error: string): ReferralCodeFormatResult {
  return { ok: false, code, fingerprint: referralCodeFingerprint(code), reason, error };
}

// Format/content validation (everything except DB uniqueness, which the server
// does). Returns the normalized code to store plus a clear reason on rejection.
export function validateReferralCodeFormat(
  raw: string | null | undefined,
  rules: ReferralCodeRules = DEFAULT_REFERRAL_CODE_RULES,
): ReferralCodeFormatResult {
  const original = (raw ?? "").trim();
  const code = normalizeReferralCode(raw);

  if (!code) {
    return reject(code, "empty", "Enter a code using letters, numbers, hyphens, or underscores.");
  }
  // If normalization had to strip characters the user typed, tell them rather
  // than silently changing their code.
  if (original.toUpperCase().replace(/\s+/g, "") !== code) {
    return reject(code, "invalid_chars", "Only letters, numbers, hyphens (-) and underscores (_) are allowed.");
  }
  if (/^[-_]|[-_]$/.test(code)) {
    return reject(code, "edge_separator", "Code can't start or end with a hyphen or underscore.");
  }
  if (/[-_]{2,}/.test(code)) {
    return reject(code, "repeated_separator", "Code can't have two hyphens/underscores in a row.");
  }
  // Reserved / profanity BEFORE length, so a short reserved word (e.g. "API")
  // is rejected as reserved rather than merely "too short".
  const fingerprint = referralCodeFingerprint(code);
  if (RESERVED_REFERRAL_CODES.has(code) || RESERVED_REFERRAL_CODES.has(fingerprint)) {
    return reject(code, "reserved", "That code is reserved. Please choose another.");
  }
  const letters = code.replace(/[^A-Z]/g, "");
  if (PROFANITY_SUBSTRINGS.some((word) => letters.includes(word))) {
    return reject(code, "profanity", "That code isn't allowed. Please choose another.");
  }
  if (code.length < rules.minLength) {
    return reject(code, "too_short", `Code must be at least ${rules.minLength} characters.`);
  }
  if (code.length > rules.maxLength) {
    return reject(code, "too_long", `Code can be at most ${rules.maxLength} characters.`);
  }
  return { ok: true, code, fingerprint };
}
