/**
 * THE CLIENT HALF OF THE CONSENT GATE — one declaration, not eight.
 *
 * The server half already had a single source of truth
 * (`cookie-consent-server.ts`, CONSENT_COOKIE_NAME). The client half did not:
 * the storage key was redeclared in eight files, the event name in six, and a
 * byte-identical `hasAccepted()` was copy-pasted into all four pixel/analytics
 * components that co-mount on every page (layout.tsx renders ConsentedAnalytics,
 * TikTokPixel, SnapPixel and RedditPixel together).
 *
 * There was no live bug — every copy was identical and the listeners matched
 * the dispatchers. The exposure was drift on a PRIVACY CONTROL. Renaming the
 * event, changing the key, or adding a third consent state required a correct
 * edit in eight unrelated files with nothing to enforce it; missing one pixel
 * file would leave that tracker firing without consent, or ignoring a
 * withdrawal, and the existing source-string test would still pass because it
 * only pinned the Snap copy.
 *
 * Everything that reads or announces browser consent must come through here.
 */

// Must stay equal to CONSENT_COOKIE_NAME in cookie-consent-server.ts: the
// banner writes both, and the server gate reads the cookie of the same name.
export const CONSENT_STORAGE_KEY = "vl_cookie_consent";

/** Dispatched by the banner (and the ads tracking-health helper) on any change. */
export const CONSENT_EVENT = "vanta:cookie-consent";

/**
 * Has the visitor actively accepted?
 *
 * Absence of a recorded "yes" is a NO — someone who has not answered the banner
 * yet, or whose storage is blocked (private mode, some in-app browsers), is
 * treated exactly like someone who declined. Same rule as the server half.
 */
export function hasAcceptedConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY) === "accepted";
  } catch {
    return false;
  }
}

/** Announce a consent change to every gate mounted on the page. */
export function announceConsentChange(): void {
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

/**
 * Subscribe to consent changes. Returns an unsubscribe function.
 *
 * `storage` is listened to alongside the custom event so a choice made in
 * ANOTHER TAB is honoured here too — a withdrawal that only reached the tab it
 * was made in is not a withdrawal.
 */
export function subscribeToConsent(onChange: () => void): () => void {
  window.addEventListener(CONSENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
