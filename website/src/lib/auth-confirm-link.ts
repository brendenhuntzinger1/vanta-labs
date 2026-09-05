import { getSiteUrl } from "@/lib/env";
import { safeInternalPath } from "@/lib/internal-path";

// ---------------------------------------------------------------------------
// KEEP THE LINK ON OUR OWN DOMAIN.
//
// `generateLink` hands back an action_link pointing at
// https://<project>.supabase.co/auth/v1/verify?... — a domain with no visible
// relationship to vantalabsresearch.com, which is what the message is FROM.
//
// A link whose domain does not match the sender's is one of the oldest and
// strongest phishing signals there is, and it survived the branding fix: the
// 2026-08-29 confirmation was moved onto our own template, our own provider and
// our own From address, and its single button still pointed at supabase.co.
// Gmail had already filed the previous version as spam and stripped its links.
// Leaving the mismatch in place would have left that reason standing.
//
// So the email points at /auth/confirm on OUR host, and that route rebuilds the
// GoTrue verify URL and redirects. Three things follow, all of them wanted:
//
//   * the recipient sees, hovers and lands on the domain that sent the mail;
//   * a filter reading the message sees the same;
//   * GoTrue still does the verifying — no auth logic is reimplemented here,
//     which is the part that must not be got clever with.
//
// The token in this URL is the same single-use token the email already carried;
// routing it through one more hop on our own host neither weakens nor extends
// it. It must never be logged, which is why the route below reads it and
// redirects without recording it.
// ---------------------------------------------------------------------------

/** Link types GoTrue can hand us that this hop knows how to forward. */
const FORWARDABLE = new Set(["signup", "magiclink", "invite", "recovery", "email_change"]);

/**
 * The verify-endpoint type for a generateLink type.
 *
 * generateLink is asked for `email_change_new` (the link that goes to the
 * address being adopted) or `email_change_current`, and its response echoes
 * that request in `verification_type`. GoTrue's /verify endpoint knows neither
 * name — it verifies both tokens under `type=email_change`. Passed through
 * unmapped, the type was not FORWARDABLE, so every change-of-address email fell
 * back to the raw supabase.co action_link: the off-domain button this module
 * exists to remove, on the one auth email that had not lost it.
 */
export function normalizeLinkType(type: string | null | undefined): string {
  const value = String(type ?? "").trim().toLowerCase();
  if (value === "email_change_new" || value === "email_change_current") return "email_change";
  return value;
}

export interface BrandedConfirmLinkInput {
  /** `properties.hashed_token` from generateLink. */
  hashedToken?: string | null;
  /** `properties.verification_type`, or the type passed to generateLink. */
  type?: string | null;
  /** Where the customer should land once GoTrue has verified them. */
  next: string;
  /** The raw action_link, used verbatim if this hop cannot be built. */
  fallbackActionLink: string;
}

/**
 * The URL to put in the email.
 *
 * Falls back to the raw Supabase action_link whenever the hop cannot be built —
 * an ugly link that works beats a tidy one that does not, and this is the only
 * way a customer gets into their account.
 */
export function brandedConfirmUrl(input: BrandedConfirmLinkInput): string {
  const token = String(input.hashedToken ?? "").trim();
  const type = normalizeLinkType(input.type);

  if (!token || !FORWARDABLE.has(type)) {
    return input.fallbackActionLink;
  }

  const site = getSiteUrl().replace(/\/+$/, "");
  const next = safeInternalPath(input.next, "/account");

  const params = new URLSearchParams({ token, type, next });
  return `${site}/auth/confirm?${params.toString()}`;
}

/**
 * The GoTrue URL this hop forwards to. Exported so the route and its tests
 * agree on one construction.
 */
export function gotrueVerifyUrl(input: { supabaseUrl: string; token: string; type: string; redirectTo: string }): string {
  const base = input.supabaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    token: input.token,
    type: input.type,
    redirect_to: input.redirectTo,
  });
  return `${base}/auth/v1/verify?${params.toString()}`;
}

export { FORWARDABLE as FORWARDABLE_LINK_TYPES };
