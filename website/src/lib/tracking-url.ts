/**
 * Canonical carrier resolution — the ONLY source of carrier links and carrier
 * names shown to a customer.
 *
 * WHY THIS EXISTS: the 3PL's webhook payload carries its own `tracking_url`,
 * and that URL points at the 3PL's storefront — a different brand, with its own
 * logo, nav, cart and support address. Emailing it sent Vanta Labs customers to
 * a supplier-branded site to track a Vanta Labs order.
 *
 * The same hazard applies to the `carrier` FIELD, which is free text the 3PL
 * controls. It was printed verbatim on the orders list, the order detail page
 * and the shipping email, so a payload naming the supplier put that name in
 * front of the customer. Nothing here ever echoes the input: a carrier is
 * either recognised as one of the real shipping carriers below — in which case
 * that carrier's own canonical name is returned — or it resolves to null and
 * the caller shows a neutral label.
 *
 * Links are derived from carrier + tracking number, which are facts about the
 * parcel rather than the 3PL's branding. Two near-identical copies of this
 * logic already existed (account-orders.ts and the admin order route); they
 * share this one so a fix lands everywhere at once.
 */

export type CarrierId = "usps" | "ups" | "fedex" | "dhl" | "ontrac";

interface CarrierMatcher {
  id: CarrierId;
  /** Canonical customer-facing name. Never the 3PL's input string. */
  name: string;
  /** Tokens that identify the carrier in a free-text carrier name. */
  aliases: string[];
  url: (encodedTracking: string) => string;
}

const CARRIERS: CarrierMatcher[] = [
  {
    id: "usps",
    name: "USPS",
    aliases: ["usps", "united states postal"],
    url: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
  },
  { id: "ups", name: "UPS", aliases: ["ups"], url: (t) => `https://www.ups.com/track?tracknum=${t}` },
  {
    id: "fedex",
    name: "FedEx",
    aliases: ["fedex", "fed ex"],
    url: (t) => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  },
  {
    id: "dhl",
    name: "DHL",
    aliases: ["dhl"],
    url: (t) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`,
  },
  { id: "ontrac", name: "OnTrac", aliases: ["ontrac"], url: (t) => `https://www.ontrac.com/tracking/?number=${t}` },
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
    return CARRIERS.find((c) => c.id === "ups") ?? null;
  }
  return null;
}

/**
 * Match a free-text carrier name against the allow-list.
 *
 * Word-boundary matched, not substring-matched: a plain `includes("ups")` also
 * fires on any name that merely CONTAINS those letters, so a courier called
 * something like "Groupon Logistics" resolved to UPS and sent the customer to a
 * UPS page reporting "not found". Alias characters are literal, so the aliases
 * need no regex escaping.
 */
function matchCarrierName(carrier: string): CarrierMatcher | null {
  const key = carrier.trim().toLowerCase();
  if (!key) return null;
  return (
    CARRIERS.find((c) =>
      c.aliases.some((alias) => new RegExp(`(^|[^a-z0-9])${alias}([^a-z0-9]|$)`).test(key)),
    ) ?? null
  );
}

export interface ResolvedCarrier {
  id: CarrierId;
  /** Canonical carrier name, safe to show a customer. */
  name: string;
  /** The carrier's own tracking page. */
  trackingUrl: string;
}

/**
 * The carrier behind a parcel, or null when it can't be identified from the
 * allow-list. Null means "say nothing" — never "pass the 3PL's text through".
 */
export function resolveCarrier(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): ResolvedCarrier | null {
  const tracking = (trackingNumber ?? "").trim();
  if (!tracking) return null;

  const matched = matchCarrierName(carrier ?? "") ?? inferCarrierFromTracking(tracking);
  if (!matched) return null;

  return { id: matched.id, name: matched.name, trackingUrl: matched.url(encodeURIComponent(tracking)) };
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
  return resolveCarrier(carrier, trackingNumber)?.trackingUrl ?? null;
}

/**
 * The carrier name to SHOW a customer — always one of the canonical names
 * above, never the 3PL's free text. Null when unrecognised, so the caller falls
 * back to a neutral label rather than naming whoever the payload named.
 */
export function carrierDisplayName(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  return resolveCarrier(carrier, trackingNumber)?.name ?? null;
}
