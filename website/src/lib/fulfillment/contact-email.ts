/**
 * Pure helpers for the address we hand the 3PL in place of the buyer's real
 * email. Kept free of `server-only` so they are directly unit-testable — the
 * fulfilment provider and relay-domain modules both import from here.
 *
 * WHY THIS EXISTS: the 3PL runs its own notification system. Given a customer's
 * email it sends that customer ITS OWN branded order confirmation — different
 * company name, different logo, and its own wholesale line items (a Vanta Labs
 * order arrived at the buyer's inbox as "EVO Labs Research", showing the item as
 * a $0.00 FREE GIFT). The buyer ends up with two conflicting confirmations for
 * one purchase, from a company they have never heard of, disclosing our
 * supplier.
 *
 * A 3PL needs a shipping address and a pick list. It does not need a channel to
 * our customers. We send a Vanta-controlled per-order alias instead: it
 * satisfies APIs that require a syntactically valid email, routes anything the
 * 3PL sends back to US rather than the buyer, and tags which order triggered it.
 */

/** Lowercase, strip a leading "@" and a "www." prefix. */
export function normalizeDomain(value: string): string {
  return value.trim().replace(/^@/, "").replace(/^www\./i, "").toLowerCase();
}

/**
 * The per-order alias, e.g. `orders+VL-E8F4D52F@vantalabsresearch.com`.
 *
 * Returns "" when no domain is configured. The caller treats that as "send no
 * contact address at all" — the one thing that must never happen is falling
 * back to the buyer's own inbox.
 */
export function fulfillmentContactEmail(orderNumber: string, domain: string): string {
  const safeOrder = (orderNumber || "unknown").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "unknown";
  const safeDomain = normalizeDomain(domain || "");
  if (!safeDomain) return "";
  return `orders+${safeOrder}@${safeDomain}`;
}

/** Handles both "orders@example.com" and "Vanta Labs <orders@example.com>". */
export function domainFromEmailAddress(from: string | null | undefined): string {
  const raw = (from ?? "").trim();
  if (!raw) return "";
  const angled = raw.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : raw).trim();
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  const domain = address.slice(at + 1).trim();
  return domain ? normalizeDomain(domain) : "";
}
