/**
 * The Meta (Facebook) Pixel id, in one place.
 *
 * Not a secret: it ships to every browser in the loader URL and in the
 * noscript image, and it names the ad account's data source, not any
 * credential. Overridable by env so a staging deployment can be pointed at a
 * different data source without a code change — the same split every other
 * pixel here uses. The fallback is the live Vanta Labs pixel, issued by Meta
 * Events Manager.
 *
 * Shared between the browser pixel and any future Conversions API leg so the
 * two can never name different data sources.
 */
export const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "1368613292095373";
