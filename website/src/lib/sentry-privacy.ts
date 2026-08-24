/**
 * What Vanta Labs is allowed to send to Sentry.
 *
 * Sentry exists here to explain SOFTWARE DEFECTS — route, error type, stack,
 * release, environment. It must never become a second copy of the customer
 * database. A crash report is worth having; a crash report carrying somebody's
 * address is a liability that outlives the bug it describes.
 *
 * So this module is deny-by-default in both directions:
 *
 *   1. Whole sections of the event that exist to carry request data (headers,
 *      cookies, bodies, query strings, user identity) are DELETED outright
 *      rather than filtered. Filtering assumes you can enumerate every key a
 *      payload might carry; deleting does not.
 *
 *   2. What survives is then swept for PII-shaped text, because a customer's
 *      email can arrive inside an error MESSAGE — "duplicate key value violates
 *      unique constraint ... (a.buyer@example.com)" — where no key-based rule
 *      would ever look.
 *
 * Shared by the browser, Node and Edge runtimes so the three cannot drift.
 */

/** Header names that are credentials or session material. Never transmitted. */
const FORBIDDEN_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-webhook-signature",
  "x-payment-signature",
  "x-shippo-signature",
  "apikey",
  "x-api-key",
  "x-supabase-auth",
  "x-vercel-id",
];

/**
 * Query/body keys that carry customer identity or money. Used for URL scrubbing
 * and as a last line of defence on any structured context that gets attached.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "email",
  "name",
  "phone",
  "address",
  "street",
  "postal",
  "zipcode",
  "card",
  "cvc",
  "cvv",
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "dsn",
  "recipient",
  "customer",
  "buyer",
];

/**
 * Short keys that would over-match as substrings ("cs" is inside "docs",
 * "zip" inside "gzip"), so they are compared whole.
 */
const SENSITIVE_KEYS_EXACT = ["zip", "city", "state", "cs", "to", "from", "user"];

/**
 * Substring matching, not equality.
 *
 * Reproduced during development: `extra.shippingAddress` sailed through an
 * exact-match list containing "address", and a street address is the one piece
 * of PII no regex reliably recognises. Real payloads name things
 * shippingAddress, billingAddress, customerEmail, recipient_name — so the rule
 * has to be "contains", and the short keys that would over-match are compared
 * whole instead.
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS_EXACT.includes(lower)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

const REDACTED = "[redacted]";

/** Text patterns that identify a person regardless of which field they sit in. */
const PII_PATTERNS: Array<[RegExp, string]> = [
  // Email addresses.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  // Long digit runs — card numbers, and anything that looks like one.
  [/\b\d{13,19}\b/g, "[number]"],
  // North American phone numbers in their common written forms.
  [/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, "[phone]"],
  // US ZIP / ZIP+4.
  [/\b\d{5}(?:-\d{4})?\b/g, "[zip]"],
  // Bearer tokens and long opaque credentials that leaked into a message.
  [/\b(?:Bearer|Basic)\s+[\w.\-+/=]{8,}/gi, "[credential]"],
  [/\beyJ[\w.\-+/=]{20,}/g, "[jwt]"],
  [/\bsk_[A-Za-z0-9_]{8,}/g, "[secret-key]"],
];

/** Redact PII-shaped text anywhere in a string. */
export function scrubText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PII_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Strip identifying query parameters from a URL, keeping the path. */
export function scrubUrl(value: string): string {
  try {
    // Relative URLs need a base to parse; the base is discarded.
    const url = new URL(value, "https://redacted.invalid");
    let touched = false;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    const rebuilt = value.startsWith("http")
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`;
    return scrubText(touched ? rebuilt : value);
  } catch {
    return scrubText(value);
  }
}

/**
 * Recursively redact a structured value.
 *
 * Depth-limited because a Sentry event can carry cyclic or very deep objects
 * and this runs on every event in the request path.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrubValue(item, depth + 1);
  }
  return out;
}

/** The minimal shape this module needs; avoids importing Sentry types here. */
interface ScrubbableEvent {
  request?: {
    headers?: Record<string, string>;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    url?: string;
  };
  user?: unknown;
  message?: unknown;
  breadcrumbs?: unknown;
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  exception?: { values?: Array<{ value?: string }> };
}

/**
 * The last thing that runs before an event leaves the process.
 *
 * Order matters: delete the bulk carriers first, then sweep what remains. If
 * this throws, Sentry would send the UNSCRUBBED event, so the caller drops the
 * event on any error rather than risking that.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  // 1. Identity is never attached. We diagnose defects, not people.
  delete event.user;

  // 2. Request payloads: keep the path, discard everything that carries data.
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data; // request bodies — checkout carries an address
    delete event.request.query_string;

    if (event.request.url) {
      event.request.url = scrubUrl(event.request.url);
    }

    if (event.request.headers) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(event.request.headers)) {
        // Allow-list rather than deny-list: only headers that help diagnose.
        const lower = key.toLowerCase();
        if (FORBIDDEN_HEADERS.includes(lower)) continue;
        if (lower === "user-agent" || lower === "referer" || lower === "content-type") {
          headers[key] = scrubText(String(value));
        }
      }
      event.request.headers = headers;
    }
  }

  // 3. Free text can carry an address even when no field is named "address".
  if (typeof event.message === "string") {
    event.message = scrubText(event.message);
  }
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") value.value = scrubText(value.value);
  }

  // 4. Anything we attached ourselves.
  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as Record<string, unknown>;

  // 5. Breadcrumbs are the richest accidental source: fetch URLs and console
  //    lines both routinely contain an order id or an email.
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  }

  return event;
}

interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
  category?: string;
}

/** Scrub one breadcrumb. Returns null for crumbs not worth the risk. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  if (typeof crumb.message === "string") {
    crumb.message = scrubText(crumb.message);
  }
  if (crumb.data) {
    // URL fields are scrubbed AS URLS and then held out of the key-based pass.
    //
    // Reproduced end-to-end: `to` and `from` are in SENSITIVE_KEYS_EXACT (a
    // `to` can be an email address elsewhere), so scrubValue was overwriting
    // the carefully scrubbed navigation URL with "[redacted]" — destroying the
    // one thing the navigation breadcrumb exists to record. A breadcrumb
    // reading `navigation to [redacted]` cannot tell you that a hard load
    // landed on /checkout/pay, which is the exact bug this was added to catch.
    const URL_FIELDS = ["url", "to", "from"] as const;
    const { ...rest } = crumb.data;
    const urls: Record<string, unknown> = {};
    for (const field of URL_FIELDS) {
      if (typeof rest[field] === "string") {
        urls[field] = scrubUrl(rest[field] as string);
        delete rest[field];
      }
    }
    crumb.data = { ...(scrubValue(rest) as Record<string, unknown>), ...urls };
  }
  return crumb;
}

/**
 * Release and environment, resolved the same way on server and client.
 *
 * The release is the commit SHA so "did this start after commit X?" is
 * answerable. NEXT_PUBLIC_BUILD_ID already carries the short SHA on the client
 * (next.config inlines it), which is why it is the client-side fallback.
 */
export function sentryRelease(): string | undefined {
  // NEXT_PUBLIC_SENTRY_RELEASE is inlined by next.config from the same SHA the
  // server reads, so client and server events land on ONE release rather than
  // two that differ only in length.
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_SENTRY_RELEASE ??
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_BUILD_ID ??
    undefined
  );
}

export function sentryEnvironment(): string {
  return (
    process.env.VERCEL_ENV ??
    process.env.NEXT_PUBLIC_VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development"
  );
}

/**
 * Whether Sentry should run at all.
 *
 * No DSN means no reporting — that is how local development and the test suite
 * stay silent without needing a separate code path.
 */
export function sentryDsn(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || process.env.SENTRY_DSN?.trim();
  return dsn ? dsn : undefined;
}
