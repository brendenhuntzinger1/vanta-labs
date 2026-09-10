/**
 * WHICH ADDRESSES ARE OURS, AND THEREFORE NOT CUSTOMER BEHAVIOUR.
 *
 * WHY THIS EXISTS. Measured on 2026-09-10, the owner's two addresses were 11
 * of 40 abandoned carts (25%), 24 of 99 recovery sends (20%) and SIX OF TEN
 * reported recoveries (60%). Nothing excluded them from any figure, so every
 * rate on the cart-recovery dashboard was contaminated — and contaminated in
 * the flattering direction, because the owner completes the carts they open
 * while testing: 54.5% "recovery" for internal carts against 13.8% for real
 * customers. A funnel cannot be tuned against a number that is three-fifths
 * its own staff.
 *
 * WHAT THIS IS NOT. It is not a suppression list and it must never become one.
 * An internal address still receives every message it qualifies for — that is
 * the whole point of being able to test the real system. This decides only
 * what REPORTING counts, and it is applied at the read side, so no send path
 * consults it and no customer can be excluded from mail by editing this
 * config.
 *
 * OVER-EXCLUSION IS THE DANGEROUS DIRECTION. Excluding a real customer hides
 * genuine behaviour and makes the funnel lie in the other direction, which is
 * harder to notice than the problem it fixes. So every rule below is exact:
 * an unparseable address is external, and a domain that merely ENDS WITH the
 * site domain (notvantalabsresearch.com) is a different company.
 */

/** The provider's delivery simulators. Not people, and they are the only
 *  "bounce" and "complaint" the account has ever recorded — counting them as
 *  sender-health signals misreports the one number deliverability turns on. */
const SIMULATOR_DOMAINS = ["resend.dev"];

/** Harness addresses. `.test` is reserved by RFC 2606 and can never be real. */
const TEST_TLDS = [".test", ".invalid", ".example"];

export interface InternalAddressConfig {
  /** The store's own domain, e.g. "vantalabsresearch.com". Subdomains count. */
  siteDomain?: string | null;
  /** Explicitly listed addresses, already lowercased. */
  extra?: readonly string[];
}

/**
 * Read a configured list.
 *
 * Accepts commas, semicolons and newlines, because that is how a list actually
 * arrives when someone pastes one into an environment variable.
 */
export function parseInternalAddressList(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/[,;\n\r]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1);
  return domain.includes(".") ? domain : null;
}

/** Exact host, or a subdomain of it — never a mere suffix match. */
function isSameOrSubdomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

/**
 * Is this address ours rather than a customer's?
 *
 * Answers false for anything it cannot parse — see the header on why
 * over-exclusion is the worse failure.
 */
export function isInternalAddress(
  email: string | null | undefined,
  config: InternalAddressConfig = {},
): boolean {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) return false;

  const domain = domainOf(normalized);
  if (!domain) return false;

  if ((config.extra ?? []).includes(normalized)) return true;

  const siteDomain = String(config.siteDomain ?? "").trim().toLowerCase();
  if (siteDomain && isSameOrSubdomain(domain, siteDomain)) return true;

  if (SIMULATOR_DOMAINS.some((simulator) => isSameOrSubdomain(domain, simulator))) return true;
  if (TEST_TLDS.some((tld) => domain.endsWith(tld))) return true;

  return false;
}

/**
 * The config this deployment is running with.
 *
 * `ANALYTICS_EXCLUDED_EMAILS` holds the addresses that are ours but live on a
 * public domain — the owner's personal mailbox is the case that matters, and
 * it cannot be inferred from anything.
 */
export function internalAddressConfig(): InternalAddressConfig {
  let siteDomain: string | null = null;
  try {
    siteDomain = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "").hostname.replace(/^www\./, "") || null;
  } catch {
    siteDomain = null;
  }
  return {
    siteDomain,
    extra: parseInternalAddressList(process.env.ANALYTICS_EXCLUDED_EMAILS),
  };
}

/** The common case: is this address ours, under this deployment's config? */
export function isInternalAddressHere(email: string | null | undefined): boolean {
  return isInternalAddress(email, internalAddressConfig());
}
