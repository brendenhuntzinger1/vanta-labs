/**
 * The Reddit pixel id, in one place.
 *
 * Both the browser pixel and the server-side Conversions API need it, and the
 * Conversions endpoint is keyed on it (`/api/v3/pixels/<id>/conversion_events`).
 * Two hard-coded copies would be two things to update and one to forget, and
 * the failure would be quiet in the worst way: the SDK loading for one pixel
 * while conversions report to another, with neither path erroring.
 *
 * Kept free of any import so a "use client" component and a `server-only`
 * module can both take it without dragging the other's dependencies along.
 */
export const REDDIT_PIXEL_ID = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID ?? "a2_jipuxv3ugrju";
