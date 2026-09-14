/**
 * The two first-party cookies Meta's pixel writes, read off a request.
 *
 * `_fbp` identifies the browser; `_fbc` is written when the visitor arrived
 * through an ad click. Forwarded only to Meta — they are its identifiers, not
 * ours. Pure, so it can be asserted without a request object.
 */
export function readPixelCookies(cookieHeader: string | null | undefined): { fbp: string | null; fbc: string | null } {
  const out = { fbp: null as string | null, fbc: null as string | null };
  for (const part of String(cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!value || value.length > 260) continue;
    if (name === "_fbp") out.fbp = value;
    else if (name === "_fbc") out.fbc = value;
  }
  return out;
}
