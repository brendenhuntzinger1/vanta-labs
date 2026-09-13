/**
 * Coarse, server-resolved geo for a request — country and city only.
 *
 * Deliberately does NOT touch the request's IP address at all. Vercel's edge
 * network already resolves geo and hands it over as headers, so there is
 * nothing to look up and nothing to store: the raw address never needs to be
 * read for this to work, which is the simplest possible way to honor "do not
 * store raw IP long-term" for this feature — it is never captured in the
 * first place, not captured-then-discarded.
 *
 * Returns nulls (never throws) when the headers are absent — local dev and
 * any non-Vercel host — matching this codebase's fail-soft convention for
 * optional signals.
 */
export function resolveCoarseGeoFromHeaders(headers: Headers): { country: string | null; city: string | null } {
  const country = headers.get("x-vercel-ip-country")?.trim() || null;

  const rawCity = headers.get("x-vercel-ip-city");
  let city: string | null = null;
  if (rawCity) {
    try {
      const decoded = decodeURIComponent(rawCity).trim();
      city = decoded || null;
    } catch {
      city = null;
    }
  }

  return { country, city };
}
