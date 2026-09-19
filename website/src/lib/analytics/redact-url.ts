/**
 * Take the credentials out of a URL before it is written to the event log.
 *
 * WHY THIS EXISTS, measured rather than imagined. The first-party tracker sends
 * `window.location.href` with every page view, and the win-back wheel is
 * reached at `/spin?t=<signed spin token>`. So three live spin tokens — one of
 * them a real customer's — were sitting verbatim in
 * `website_analytics_events.page_url` in production, two of them against
 * prizes that were still unredeemed.
 *
 * THAT TOKEN IS A BEARER CREDENTIAL. Presenting it to /api/spin on a device
 * holding no offer cookie re-arms THAT device (src/app/api/spin/route.ts) and
 * rotates the winner's own copy out, so possession of the link is possession
 * of the prize. spin-token.ts says as much in its own header: the link is
 * "worth a prize to whoever holds it".
 *
 * Two things already kept it off the open internet and both still hold:
 * `Referrer-Policy: strict-origin-when-cross-origin` (middleware.ts) sends
 * only the origin to third parties, and the analytics table is admin-read
 * under RLS. Neither is a reason to store the secret. An event log is read by
 * people, exported, screenshotted and kept long after the thing it describes;
 * a credential does not belong in one.
 *
 * REDACTED BY NAME, NOT BY SHAPE. Guessing at "things that look like secrets"
 * would eventually eat a product slug or a campaign id, and the parameters
 * that carry credentials in this store are a short, known list. Anything not
 * named here is left exactly as it was, so the analytics stay usable: `c` is a
 * campaign id, `l` a link index, and every `utm_*` survives untouched.
 */

/**
 * Query parameters that carry a credential or a recipient's address.
 *
 * - `t`     the spin link's signed token (/spin?t=…)
 * - `token` the general-purpose name, used by unsubscribe and claim links
 * - `k`     a keyed link's key
 * - `s`     the signature on a tracked email click
 * - `e`     the recipient address on a tracked email click
 * - `email` the same, spelled out
 * - `sig`, `signature`, `key`  names not in use today, redacted so that adding
 *   one later cannot reintroduce this by default
 */
const SECRET_PARAMS = new Set([
  "t", "token", "k", "s", "e", "email", "sig", "signature", "key",
  // Observed carrying a person's details rather than a credential: the admin
  // orders screen writes `?search=<a customer's address>` and the partner form
  // `?name=<a full name>`, both of which then sit in the event log. Neither is
  // worth an analytics row.
  "search", "name",
]);

/**
 * Parameters whose value is ITSELF a URL, and are therefore recursed into
 * rather than blanked.
 *
 * The access wall sends a signed-out visitor to `/account/login?next=%2Fspin
 * %3Ft%3D<token>`, so the spin token arrives url-encoded INSIDE another
 * parameter, where a name-based rule never sees it. Blanking `next` outright
 * would work and would also throw away the most useful fact in the row — where
 * the visitor was trying to go — so the value is redacted as a URL in its own
 * right and put back.
 */
const NESTED_URL_PARAMS = new Set(["next", "redirect", "redirectto", "returnto", "return", "continue", "url"]);

const REDACTED = "REDACTED";

/**
 * The same URL with every secret parameter's VALUE replaced.
 *
 * The parameter itself is kept: that a page view carried a spin token is worth
 * knowing — it is how an emailed visit is told from a storefront one — and
 * only the value is dangerous.
 *
 * Anything that is not a parseable absolute URL is returned unchanged except
 * for a bare-query fallback, because this runs over whatever a client sent and
 * must never throw a page view away.
 */
export function redactUrlSecrets(raw: string | null | undefined): string {
  const value = String(raw ?? "");
  if (!value) return value;
  // Cheap reject: no query string, nothing to redact, and no parse to pay for.
  if (!value.includes("?") && !value.includes("&")) return value;

  try {
    const url = new URL(value);
    let touched = false;
    for (const name of [...url.searchParams.keys()]) {
      const key = name.toLowerCase();
      if (SECRET_PARAMS.has(key)) {
        url.searchParams.set(name, REDACTED);
        touched = true;
        continue;
      }
      if (!NESTED_URL_PARAMS.has(key)) continue;
      const inner = url.searchParams.get(name) ?? "";
      const cleaned = redactUrlSecrets(inner);
      if (cleaned !== inner) {
        url.searchParams.set(name, cleaned);
        touched = true;
      }
    }
    return touched ? url.toString() : value;
  } catch {
    // A relative path, or something that is not a URL at all. The parameters
    // are still worth taking out, so the query is rewritten textually.
    return value.replace(
      /([?&])([A-Za-z_][\w.-]*)=([^&#]*)/g,
      (whole, sep: string, name: string, raw: string) => {
        const key = name.toLowerCase();
        if (SECRET_PARAMS.has(key)) return `${sep}${name}=${REDACTED}`;
        if (!NESTED_URL_PARAMS.has(key)) return whole;
        let decoded: string;
        try { decoded = decodeURIComponent(raw); } catch { return whole; }
        const cleaned = redactUrlSecrets(decoded);
        return cleaned === decoded ? whole : `${sep}${name}=${encodeURIComponent(cleaned)}`;
      },
    );
  }
}
