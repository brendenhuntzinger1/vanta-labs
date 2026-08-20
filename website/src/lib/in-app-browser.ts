/**
 * Is this page running inside an app's embedded browser rather than a real one?
 *
 * TikTok, Instagram, Facebook, Snapchat and the rest open links in a WebView
 * they control. Those WebViews are not Safari or Chrome: they keep their own
 * toolbars over the viewport, they hand video playback to the system player on
 * their own terms, and they give the page no browser UI of its own.
 *
 * Two things depend on knowing:
 *
 *   * the hero shows a still vial instead of a clip, because five rounds of
 *     work could not make inline playback reliable there and a fullscreen
 *     player is far worse than a still product shot;
 *   * the site offers its own back control, because these WebViews often show
 *     no usable one and a visitor can otherwise get stuck.
 *
 * Sniffing a user agent is a blunt instrument and normally the wrong answer.
 * It is the right one here: there is no feature query for "this browser will
 * take your video away", and the cost of a false positive is a still hero
 * rather than an animated one — a downgrade nobody will notice, versus a
 * fullscreen takeover that has cost this store days.
 */
const IN_APP_SIGNATURES = [
  // TikTok ships several markers depending on build and region.
  "tiktok",
  "musical_ly",
  "bytedance",
  "bytelocale",
  // Meta
  "instagram",
  "fbav",
  "fban",
  "fb_iab",
  "fbios",
  // Others that embed a WebView the same way
  "snapchat",
  "pinterest",
  "line/",
  "micromessenger", // WeChat
  "twitter",
  "linkedinapp",
];

export function isInAppBrowser(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return IN_APP_SIGNATURES.some((sig) => ua.includes(sig));
}

/** Client-side convenience; false during server rendering. */
export function detectInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return isInAppBrowser(navigator.userAgent);
}
