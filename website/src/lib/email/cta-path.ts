/**
 * The one place that decides whether a campaign's button link is safe.
 *
 * WHY IT IS ITS OWN MODULE. This rule is enforced at three layers — the
 * composer API, the automations API, and the click redirect itself — and three
 * hand-written copies of a security check is how two of them end up subtly
 * different. Kept free of imports so a pure validator and a `server-only`
 * module can both use it.
 *
 * WHY "STARTS WITH A SLASH" IS NOT ENOUGH. The first version of this check was
 * `startsWith("/") && !startsWith("//")`, which reads as obviously correct and
 * is not. Browsers and the URL parser treat a backslash as a forward slash when
 * resolving authority, so `/\evil.com` resolves to `https://evil.com/` exactly
 * as `//evil.com` does — it passes the string test and leaves the site anyway.
 * An open redirect on a domain customers were taught to trust because it
 * arrived in our email is worth real money to a phisher, so this now decides by
 * RESOLVING the path against the site origin and comparing origins, rather than
 * by pattern-matching prefixes. Resolution is what the browser will actually
 * do; a prefix test is a guess about it.
 */

/** Paths that must never be sent, whatever they resolve to. */
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/;

/**
 * True when `path` is a site-relative path that cannot leave `siteOrigin`.
 *
 * `siteOrigin` is passed in rather than read from env so this stays pure and
 * testable, and so a misconfigured env cannot silently widen the check.
 */
export function isSafeSitePath(path: string | null | undefined, siteOrigin: string): boolean {
  const raw = String(path ?? "");
  if (!raw.startsWith("/")) return false;
  // CR/LF would split a Location header; anything else in this range has no
  // business in a URL a human typed into an admin form.
  if (CONTROL_CHARACTERS.test(raw)) return false;

  let base: URL;
  try {
    base = new URL(siteOrigin);
  } catch {
    return false;
  }

  try {
    const resolved = new URL(raw, base);
    // The whole test. `/\evil.com`, `//evil.com`, `/\/evil.com` and every other
    // authority trick fail here because they resolve to a different origin.
    return resolved.origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * Normalise a stored path into an absolute, same-origin URL, falling back to
 * the catalog when it is anything else.
 *
 * Returns a URL rather than a boolean because the redirect needs somewhere to
 * send people even when the stored value is unusable — a customer who clicks a
 * link in an email should land on the shop, not on an error.
 */
export function resolveSitePath(path: string | null | undefined, siteOrigin: string, fallback = "/products"): string {
  const origin = siteOrigin.replace(/\/$/, "");
  if (!isSafeSitePath(path, siteOrigin)) return `${origin}${fallback}`;
  return `${origin}${String(path)}`;
}

/**
 * Turn whatever an operator typed into a storable site path.
 *
 * WHY THIS EXISTS. The admin used to accept only a bare path, and rejected
 * anything else with "The button link must be a path on this site, like
 * /products." That is correct about what gets STORED and unhelpful about what
 * gets TYPED: the natural thing to do is copy the address out of the browser,
 * which yields `https://www.vantalabsresearch.com/products` — the exact same
 * destination, refused. So this accepts both spellings of a same-origin
 * destination and normalises them to one stored form.
 *
 * IT DOES NOT WIDEN WHAT IS ALLOWED. An off-site URL still comes back null and
 * is still refused by the caller. The security property is unchanged and is
 * still decided by resolution against the site origin rather than by matching
 * prefixes — `//evil.com`, `/\evil.com` and every other authority trick resolve
 * to a different origin and fail here exactly as they always did.
 *
 * RETURNS:
 *   ""      the operator cleared the field. A deliberate "no button", not an
 *           error — the caller stores the blank and the email renders without
 *           one.
 *   string  a normalised site-relative path, always starting with "/".
 *   null    off-site, malformed, or otherwise unusable. The caller refuses it.
 */
export function normalizeSitePathInput(value: string | null | undefined, siteOrigin: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (CONTROL_CHARACTERS.test(raw)) return null;

  let base: URL;
  try {
    base = new URL(siteOrigin);
  } catch {
    return null;
  }

  // An absolute URL is accepted only when it lands on this origin, and it is
  // stored as the path it resolves to — so the stored value stays in the one
  // shape every reader of cta_path already expects.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.origin !== base.origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  return isSafeSitePath(raw, siteOrigin) ? raw : null;
}
