/**
 * Customer-facing error sanitiser.
 *
 * Vanta Labs must be the only brand a customer ever sees. Raw error messages
 * break that in ways that are easy to miss, because the leak only appears when
 * something goes wrong:
 *
 *   • A fetch failure against the payment processor puts its hostname in
 *     `err.message` ("getaddrinfo ENOTFOUND veyragate.com").
 *   • A processor SDK throws messages that name itself.
 *   • A Postgres error names tables and columns ("null value in column
 *     customer_email of relation orders").
 *
 * Routes that echo `error instanceof Error ? error.message : fallback` hand all
 * of that straight to the shopper. This decides whether a message is safe to
 * show, and falls back to Vanta Labs' own words when it is not.
 *
 * Deliberately a DENY-list of what leaks plus a shape check, not an allow-list:
 * an allow-list of safe phrasings would silently swallow the genuinely useful
 * validation messages ("Invalid email address", "This item is out of stock")
 * that help a shopper fix their own problem.
 */

/**
 * Vendor, supplier and infrastructure names that must never reach a customer.
 * Lower-case; matched as substrings against a lower-cased message.
 */
const VENDOR_TOKENS = [
  "veyra",
  "veyragate",
  "basis theory",
  "basistheory",
  "basis_theory",
  "evo labs",
  "evolabs",
  "evo-labs",
  "arcline",
  "supabase",
  "postgres",
  "postgrest",
  "vercel",
  "resend",
  "sendgrid",
  "smtp",
  "3pl",
  "fulfillment provider",
  "fulfilment provider",
];

/**
 * Shapes that indicate a technical error rather than something a shopper can
 * act on — stack frames, DNS/socket failures, URLs, SQL, and internal ids.
 */
const TECHNICAL_PATTERNS: RegExp[] = [
  /https?:\/\//i,           // any URL
  /\b[a-z0-9-]+\.(com|net|io|co|dev|org)\b/i, // bare hostnames
  /\bE[A-Z]{4,}\b/,          // ECONNREFUSED, ENOTFOUND, ETIMEDOUT
  /getaddrinfo|socket hang up|fetch failed|network error/i,
  /\bat\s+\w+\s*\(/,         // stack frame
  /\b(select|insert|update|delete)\b.*\bfrom\b/i, // SQL
  /relation "|column "|constraint "/i,            // Postgres detail
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID
  /\b(api[_-]?key|secret|token|bearer)\b/i,       // credential words
];

/** True when this message is safe to show a customer verbatim. */
export function isCustomerSafeMessage(message: string): boolean {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return false;
  // An overlong message is a stack trace or a provider dump, not a sentence
  // written for a shopper.
  if (trimmed.length > 200) return false;

  const lowered = trimmed.toLowerCase();
  if (VENDOR_TOKENS.some((token) => lowered.includes(token))) return false;
  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;

  return true;
}

/**
 * The message to show a customer for this error.
 *
 * Returns the error's own text when it was clearly written for a shopper
 * (validation messages, out-of-stock, "Checkout isn't open yet…"), and the
 * supplied fallback whenever it names a vendor or looks technical.
 *
 * ALWAYS log the original server-side — this is about what the shopper sees,
 * never about losing the diagnostic.
 */
export function customerSafeMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return isCustomerSafeMessage(raw) ? raw : fallback;
}
