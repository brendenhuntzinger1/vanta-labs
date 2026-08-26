/**
 * ONE client-IP resolver, for every caller that makes a security decision with
 * it.
 *
 * There were three. `admin-auth.ts` had the careful one; three public POST
 * endpoints (contact, wholesale, back-in-stock) each had their own copy that
 * read the LEFTMOST `x-forwarded-for` token first, and the leftmost token is
 * the one a client can prepend. The admin resolver's own comment already said
 * so. Both behaviours could not be right, so the careful one moved here and the
 * copies were deleted.
 *
 * Kept free of `server-only` and of any database import on purpose: it is
 * header parsing, nothing else, and anything that needs a client IP should be
 * able to reach it without pulling in the admin session layer.
 */

function normalizeIpAddress(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }
  return raw.split(",")[0]?.trim() || null;
}

/**
 * The client IP, preferring headers the hosting proxy sets itself.
 *
 * `x-vercel-forwarded-for` and `x-real-ip` are overwritten at the edge with the
 * true client address, so a client cannot forge them. `x-forwarded-for` is a
 * last resort — a client can PREPEND spoofed entries to it, so its leftmost
 * token is attacker-controlled and must never be the primary key for a lockout
 * or a rate limit.
 *
 * Falling back to it anyway is deliberate: on a host that sets neither trusted
 * header (local dev, a self-hosted proxy), a forgeable key still separates
 * ordinary traffic, whereas returning null collapses every visitor into one
 * shared bucket — which is its own denial of service.
 */
export function getRequestIpAddress(request: Request): string | null {
  const trusted = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-real-ip");
  if (trusted && trusted.trim()) {
    return normalizeIpAddress(trusted);
  }
  return normalizeIpAddress(request.headers.get("x-forwarded-for") ?? null);
}

export function getRequestUserAgent(request: Request): string | null {
  return request.headers.get("user-agent") ?? null;
}

/**
 * A rate-limit bucket key for a public endpoint.
 *
 * `unknown` is the last resort and is genuinely shared, so it must be reached
 * only when the request carries no address information at all — not, as three
 * hand-rolled copies of this did, whenever one particular header is absent.
 */
export function rateLimitKeyForRequest(prefix: string, request: Request): string {
  return `${prefix}:${getRequestIpAddress(request) ?? "unknown"}`;
}
