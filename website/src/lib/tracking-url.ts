/**
 * Canonical carrier tracking-URL builder.
 *
 * WHY THIS EXISTS: the 3PL's webhook payload carries its own `tracking_url`,
 * and that URL points at the 3PL's storefront — a different brand, with its own
 * logo, nav, cart and support address. Emailing it sent Vanta Labs customers to
 * a competitor-looking site to track a Vanta Labs order. Nothing customer-facing
 * may ever use the fulfilment provider's URL.
 *
 * We derive the link ourselves from the carrier and tracking number, which are
 * facts about the parcel rather than the 3PL's branding. Two near-identical
 * copies of this logic already existed (account-orders.ts and the admin order
 * route); they now share this one so a fix lands everywhere at once.
 */

interface CarrierMatcher {
  /** Substrings that identify the carrier in a free-text carrier name. */
  aliases: string[];
  url: (encodedTracking: string) => string;
}

const CARRIERS: CarrierMatcher[] = [
  { aliases: ["usps", "united states postal"], url: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}` },
  { aliases: ["ups"], url: (t) => `https://www.ups.com/track?tracknum=${t}` },
  { aliases: ["fedex", "fed ex"], url: (t) => `https://www.fedex.com/fedextrack/?trknbr=${t}` },
  { aliases: ["dhl"], url: (t) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}` },
  { aliases: ["ontrac"], url: (t) => `https://www.ontrac.com/tracking/?number=${t}` },
];

/**
 * A UPS tracking number is "1Z" + 16 alphanumerics. Distinctive enough to infer
 * the carrier when the 3PL omits it — which it does. No inference is attempted
 * for the other carriers: FedEx and USPS both use plain digit strings of
 * overlapping lengths, and a wrong guess sends the customer to a carrier site
 * that reports "not found".
 */
function inferCarrierFromTracking(tracking: string): CarrierMatcher | null {
  if (/^1Z[0-9A-Z]{16}$/i.test(tracking)) {
    return CARRIERS.find((c) => c.aliases.includes("ups")) ?? null;
  }
  return null;
}

/**
 * The carrier's own tracking page, or null when the carrier can't be
 * identified. Callers decide the fallback — for anything customer-facing that
 * must be a Vanta Labs URL, never the fulfilment provider's.
 */
export function buildCarrierTrackingUrl(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  const tracking = (trackingNumber ?? "").trim();
  if (!tracking) return null;

  const key = (carrier ?? "").trim().toLowerCase();
  const encoded = encodeURIComponent(tracking);

  const matched = key ? CARRIERS.find((c) => c.aliases.some((alias) => key.includes(alias))) : null;
  const resolved = matched ?? inferCarrierFromTracking(tracking);

  return resolved ? resolved.url(encoded) : null;
}
