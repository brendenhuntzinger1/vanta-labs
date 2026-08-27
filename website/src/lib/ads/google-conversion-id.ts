/**
 * The Google Ads conversion id and purchase label, in one place.
 *
 * Both the browser pixel and the server-side Enhanced Conversions leg need
 * them. Two hard-coded copies would be two things to update and one to forget,
 * and the failure would be quiet in the worst way: the tag loading for one
 * conversion action while conversions report to another, with neither path
 * erroring. single-data-source.test.ts asserts the literal appears once.
 *
 * Kept free of any import so a "use client" component and a `server-only`
 * module can both take it without dragging the other's dependencies along.
 *
 * UNLIKE THE OTHER THREE CHANNELS, THERE IS NO PRODUCTION FALLBACK VALUE. The
 * Google Ads account does not exist yet. An empty string is not an oversight —
 * it is what keeps the pixel inert: GooglePixel renders nothing when this does
 * not match the expected shape, so merging this work cannot start reporting to
 * an account nobody has verified.
 */
export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID ?? "";

export const GOOGLE_PURCHASE_LABEL = process.env.NEXT_PUBLIC_GOOGLE_PURCHASE_LABEL ?? "";

/**
 * The NUMERIC conversion action id, for the Google Ads REST API.
 *
 * Deliberately NOT the same value as GOOGLE_PURCHASE_LABEL. That label is the
 * opaque gtag string used in `send_to: 'AW-123/AbC-D_efG'` on the browser leg.
 * The REST API addresses the same conversion action by its numeric resource id
 * (`customers/<cid>/conversionActions/<numeric id>`). Sending the gtag label
 * there produces a resource name Google cannot resolve, and the failure is a
 * rejected upload rather than anything visible in the browser.
 */
export const GOOGLE_PURCHASE_CONVERSION_ACTION_ID =
  process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID ?? "";

/**
 * A conversion id we are willing to load a third-party script for.
 *
 * `G-` prefixed ids are GA4 measurement ids. They are superficially similar,
 * they are commonly pasted here by mistake, and gtag accepts one without
 * complaint while reporting no conversions at all — so the shape is checked
 * rather than assumed non-empty.
 */
export function isConfiguredGoogleAdsId(value: string): boolean {
  return /^AW-\d+$/.test(value);
}
