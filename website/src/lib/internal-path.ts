// ---------------------------------------------------------------------------
// ONE ANSWER TO "MAY I SEND THE VISITOR HERE?"
//
// A `next` parameter rides in URLs anyone can hand-build: the referral link
// (/r/<code>?next=), the sign-in form, the signup and password-reset
// confirmation hops. Eight call sites each guarded it with
//
//     value.startsWith("/") && !value.startsWith("//")
//
// which reads as obviously correct and is not. The WHATWG URL parser treats a
// backslash as a slash for http(s), so `/\evil.example/steal` passes that
// predicate and `new URL("/\\evil.example/steal", origin)` resolves to
// https://evil.example/steal — an open redirect on the trusted brand domain,
// exactly the phishing primitive the guard exists to prevent.
//
// The test that actually answers the question is to RESOLVE the candidate
// against an origin and check the origin survived. Backslashes are refused
// outright as well, because the app router performs the same normalisation
// client-side and a path with a backslash in it has no legitimate use here.
//
// Kept free of imports so a client component can use it.
// ---------------------------------------------------------------------------

/** CR/LF would split a Location header; nothing in this range belongs in a path. */
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/;

/** Any origin works; it only has to be one an attacker cannot resolve INTO. */
const SENTINEL_ORIGIN = "https://vanta-internal-path.invalid";

/**
 * `value` if it is a same-origin absolute path, otherwise `fallback`.
 *
 * Accepts `/products`, `/account/orders?x=1#top`. Refuses protocol-relative
 * (`//host`), backslash tricks (`/\host`), absolute URLs, schemes, control
 * characters, and anything that is not a string.
 */
export function safeInternalPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (CONTROL_CHARACTERS.test(value) || value.includes("\\")) return fallback;
  try {
    if (new URL(value, SENTINEL_ORIGIN).origin !== SENTINEL_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return value;
}
