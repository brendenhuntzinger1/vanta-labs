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

/**
 * The conversion label for the Purchase action, which together with the tag id
 * above forms the `send_to` a conversion is reported against:
 * `AW-<account>/<label>`.
 *
 * It lives here, beside the id, because the two are only meaningful as a pair.
 * A label belongs to ONE conversion action in ONE account, so pointing
 * NEXT_PUBLIC_GOOGLE_ADS_ID at a different account without changing this would
 * report every sale against an action that account does not have — and Google
 * answers an unrecognised send_to by silently recording nothing, which looks
 * exactly like having no sales.
 *
 * NOT A SECRET, for the same reason the id is not: it ships in the conversion
 * call to every purchaser and authorises nothing. It is issued by the Google
 * Ads console when the conversion action is created and cannot be invented —
 * which is why wiring the purchase conversion had to wait for it.
 */
export const GOOGLE_ADS_PURCHASE_LABEL =
  process.env.NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL ?? "ERwECOzToPscEImx78tE";
