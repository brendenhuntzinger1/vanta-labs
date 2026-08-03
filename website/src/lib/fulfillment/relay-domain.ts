import "server-only";

import { getEmailRuntimeConfig } from "@/lib/email/settings";
import { domainFromEmailAddress, normalizeDomain } from "@/lib/fulfillment/contact-email";

export { domainFromEmailAddress } from "@/lib/fulfillment/contact-email";

/**
 * The Vanta-controlled domain used to build the per-order contact address we
 * hand the 3PL in place of the buyer's real email.
 *
 * Resolution order, most authoritative first:
 *   1. FULFILLMENT_CONTACT_DOMAIN — an explicit override, for when replies
 *      should land somewhere other than the sending domain.
 *   2. The domain of the configured outbound `from` address. If we send mail as
 *      orders@vantalabsresearch.com then orders+VL-1234@vantalabsresearch.com
 *      is deliverable to us by construction, and plus-addressing is supported by
 *      every major provider.
 *   3. The site host, minus a leading "www.".
 *
 * Returns "" when nothing resolves. The caller treats that as "send no contact
 * address at all" — the one thing that must never happen is falling back to the
 * buyer's own inbox.
 */
export async function getFulfillmentRelayDomain(): Promise<string> {
  const explicit = (process.env.FULFILLMENT_CONTACT_DOMAIN ?? "").trim();
  if (explicit) return normalizeDomain(explicit);

  try {
    const config = await getEmailRuntimeConfig();
    const fromDomain = domainFromEmailAddress(config.from);
    if (fromDomain) return fromDomain;
  } catch {
    // Email settings unavailable — fall through to the site host.
  }

  return domainFromSiteUrl();
}

function domainFromSiteUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (!configured) return "";
  try {
    return normalizeDomain(new URL(configured).hostname);
  } catch {
    return "";
  }
}
