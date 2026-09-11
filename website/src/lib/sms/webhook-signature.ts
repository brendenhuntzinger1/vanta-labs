import crypto from "crypto";

// ---------------------------------------------------------------------------
// Twilio request signature validation.
//
// Twilio signs a webhook differently from every other provider this codebase
// talks to, and the difference matters. There is no HMAC over the raw body.
// Twilio builds a string by concatenating the full request URL with each POST
// parameter's key and value, in KEY-SORTED order, then HMAC-SHA1s that with the
// account's auth token and base64-encodes it:
//
//     signature = base64(hmacSha1(authToken, url + k1 + v1 + k2 + v2 + ...))
//
// So the thing being authenticated is the URL plus the parsed parameters, which
// means the URL has to be exactly the one Twilio called — scheme, host, port,
// path and query string included. Behind a proxy that is NOT what
// `request.url` reports, which is the single most common reason a correct
// implementation of this rejects every real request. `signedUrlFor` below is
// where that is dealt with.
//
// PURE, AND SEPARATE FROM THE ROUTE, so every one of these cases can be tested
// without constructing a Next request: a valid signature, a tampered parameter,
// a tampered URL, a reordered body, a missing header, and an unconfigured
// token. The route is then three lines that cannot get it wrong on their own.
// ---------------------------------------------------------------------------

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: SignatureFailure };

export type SignatureFailure =
  /** No auth token configured. NOT a rejection of the caller — the server
   *  cannot verify anyone, so it must answer 503 and let Twilio retry. */
  | "not_configured"
  /** No X-Twilio-Signature header at all. */
  | "missing_signature"
  /** The header was present and did not match. */
  | "mismatch";

/**
 * The canonical string Twilio signed.
 *
 * Exported for the tests, which sign it themselves rather than pasting a
 * fixture signature — a fixture would pass even if this function and the
 * verifier drifted together in the same wrong direction.
 */
export function twilioSignatureBase(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let base = url;
  for (const key of keys) {
    base += key + params[key];
  }
  return base;
}

export function signTwilioRequest(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  return crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(twilioSignatureBase(url, params), "utf8"))
    .digest("base64");
}

/**
 * Verify a Twilio webhook.
 *
 * CONSTANT-TIME COMPARISON, matching the posture of the payment and Shippo
 * webhooks. `timingSafeEqual` throws on a length mismatch, so the lengths are
 * checked first and a wrong length is simply a mismatch.
 */
export function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null | undefined;
}): SignatureCheck {
  if (!input.authToken) return { valid: false, reason: "not_configured" };
  const provided = String(input.signature ?? "");
  if (!provided) return { valid: false, reason: "missing_signature" };

  const expected = signTwilioRequest(input.authToken, input.url, input.params);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return { valid: false, reason: "mismatch" };
  return crypto.timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "mismatch" };
}

/**
 * Rebuild the URL Twilio actually called.
 *
 * WHY NOT `request.url`. On Vercel the function sees the internal URL, not the
 * public one Twilio dialled: the scheme can be http, and the host can be an
 * internal hostname. Signing over that produces a base string Twilio never
 * signed, so every legitimate request fails and the failure looks exactly like
 * an attack.
 *
 * The configured callback URL is therefore authoritative for scheme, host and
 * path, and only the query string is taken from the request — Twilio includes
 * it in the signature, and it is the one part that can legitimately vary
 * between the configured URL and the call (we put no secrets in it).
 *
 * A configured URL that already carries a query string keeps it; the request's
 * query is appended only when the configured one has none, so an operator who
 * configured `...?x=1` is not silently overridden.
 */
export function signedUrlFor(configuredUrl: string, requestUrl: string): string {
  const configured = configuredUrl.trim();
  if (!configured) return requestUrl;
  if (configured.includes("?")) return configured;

  let query = "";
  try {
    query = new URL(requestUrl).search;
  } catch {
    query = "";
  }
  return query ? `${configured}${query}` : configured;
}

/**
 * Twilio posts `application/x-www-form-urlencoded`. Parsed into the flat
 * string map the signature is computed over.
 *
 * A REPEATED KEY TAKES THE LAST VALUE, which is what `URLSearchParams.get`
 * does and therefore what Twilio's own libraries do. It is stated here because
 * the alternative — joining repeats — would produce a different base string and
 * a mismatch on a payload that is otherwise perfectly valid.
 */
export function parseFormParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    params[key] = value;
  }
  return params;
}
