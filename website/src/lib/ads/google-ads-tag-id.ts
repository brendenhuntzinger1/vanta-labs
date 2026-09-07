/**
 * The Google Ads tag id, in one place.
 *
 * Mirrors reddit-pixel-id.ts, and for the same reason: a conversion tag is one
 * identifier that more than one module will need — the browser tag today, and
 * a server-side Enhanced Conversions leg if one is ever added — and two
 * hard-coded copies would be two things to update and one to forget. The
 * failure would be quiet in the worst way: the tag loading for one account
 * while conversions report to another, with neither path erroring.
 *
 * Kept free of any import so a "use client" component and a `server-only`
 * module can both take it without dragging the other's dependencies along.
 *
 * NOT A SECRET. It ships to every visitor in the tag URL and names the ad
 * account's data source; it authorises nothing. Set NEXT_PUBLIC_GOOGLE_ADS_ID
 * only to point a non-production deployment at a different Google Ads account.
 * It is NOT a way to switch reporting on outside production — that decision
 * belongs to ads-environment.ts and deliberately has no override.
 */
export const GOOGLE_ADS_TAG_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID ?? "AW-18412722313";
