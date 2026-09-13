/**
 * A coarse, human-readable browser label for the live-visitor dashboard.
 *
 * Deliberately shallow — five buckets, not a UA-parsing library. This is
 * shown next to "device: mobile/desktop" as a hint, not used for any
 * decision, so getting an obscure browser wrong costs nothing. The raw
 * user-agent string itself is never returned to the client — only this
 * coarse class — so the dashboard doesn't hand back a fingerprintable value
 * it doesn't need to.
 */
export function browserClassFromUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) {
    return "Other";
  }

  // Edge and Chrome UAs both contain "Safari/" for legacy-compatibility
  // reasons, so the more specific tokens (Edg/, then Chrome/) must be
  // checked before the generic "Safari" substring.
  if (/edg\//i.test(userAgent)) {
    return "Edge";
  }
  if (/chrome\/|crios\//i.test(userAgent)) {
    return "Chrome";
  }
  if (/firefox\/|fxios\//i.test(userAgent)) {
    return "Firefox";
  }
  if (/safari\//i.test(userAgent)) {
    return "Safari";
  }
  return "Other";
}
