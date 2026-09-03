import type { AffiliateMergeContext } from "@/lib/email/affiliate-merge";
import { isNonMailableAddress } from "@/lib/email/non-mailable";

/**
 * Who an affiliate campaign goes to — the CLIENT-SAFE half.
 *
 * Split out of affiliate-audience.ts because the composer needs the audience
 * choices (AFFILIATE_FILTERS) to render its radio buttons, and importing a value
 * from a `server-only` module into a client component fails the build. Nothing
 * here touches the database; the reads live next door.
 *
 * THE AUDIENCE IS THE AFFILIATE PROGRAMME, NOT THE CUSTOMER MARKETING LIST.
 * `lib/email/audience.ts` resolves consent from customer_preferences and
 * marketing_subscribers, because a customer's address is not permission to
 * market to them. Affiliates are a different relationship: they signed up to a
 * programme whose entire purpose is being sent things to promote, and requiring
 * them ALSO to appear in the customer marketing store would shrink "send to all
 * affiliates" to whichever affiliates happened to tick a checkout box — silently,
 * with no sign of why the count was small. That is the owner's recorded decision
 * (docs/superpowers/specs/2026-09-01-affiliate-email-system-design.md).
 *
 * WHAT IS NOT RELAXED IS SUPPRESSION. email_suppressions holds unsubscribes,
 * bounces and spam complaints, and it is subtracted here as well as being
 * enforced per send by sendMarketingEmail. The duplication is deliberate, and
 * for the same reason the customer audience duplicates it: the per-send check is
 * the guarantee, but subtracting up front is what makes the recipient count the
 * owner sees BEFORE pressing Send the truth rather than an overestimate that
 * quietly shrinks.
 */

/**
 * Statuses that mean "this person is in the programme right now".
 *
 * `approved` is what the code writes and what ambassador-status.ts gates the
 * personal discount on. `active` is accepted as a synonym in the same defensive
 * spirit as PAID_ORDER_STATUSES in ledger.ts — status is free text with no CHECK
 * constraint, so a surface that only ever matched one spelling would silently
 * drop real affiliates.
 */
export const ACTIVE_AFFILIATE_STATUSES = ["approved", "active"] as const;

export type AffiliateRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  referral_code: string | null;
  commission_percent: number | null;
  status: string | null;
  disabled_at: string | null;
};

export type AffiliateRecipient = {
  ambassadorId: string;
  email: string;
  mergeContext: AffiliateMergeContext;
};

export type AffiliateFilter = "all_active" | "selected" | "no_sales" | "has_sales";

/**
 * The audience choices offered in the composer, described once.
 *
 * Two of these exist because the owner named the use cases: encouraging
 * affiliates who have not sold yet, and congratulating the ones who have. They
 * are the only derived groups here on purpose — every additional group is
 * another way for a send to reach a set the owner did not picture.
 */
export const AFFILIATE_FILTERS: Array<{ value: AffiliateFilter; label: string; hint: string }> = [
  { value: "all_active", label: "All active affiliates", hint: "Everyone approved and not disabled." },
  { value: "selected", label: "Choose affiliates", hint: "Hand-pick who receives this." },
  { value: "no_sales", label: "No qualifying sales yet", hint: "Approved, but no sale that earned commission." },
  { value: "has_sales", label: "Has qualifying sales", hint: "At least one sale that earned commission." },
];

export function isAffiliateFilter(value: unknown): value is AffiliateFilter {
  return AFFILIATE_FILTERS.some((filter) => filter.value === value);
}

/**
 * Is this affiliate currently in the programme?
 *
 * `disabled_at` is checked as well as status because switching someone off is an
 * ACT with its own timestamp, and status can lag behind it. An affiliate the
 * owner removed must not receive the next flash-sale blast on the strength of a
 * stale status column.
 */
export function isActiveAffiliate(row: { status: string | null | undefined; disabled_at: string | null | undefined }): boolean {
  if (row.disabled_at) return false;
  const status = String(row.status ?? "").trim().toLowerCase();
  return (ACTIVE_AFFILIATE_STATUSES as readonly string[]).includes(status);
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The pure selection rule, exported so it can be tested without a database.
 *
 * Every filter is applied ON TOP of "is an active affiliate" — hand-picking
 * someone does not override the programme status, and it does not override
 * suppression either. Choosing an address explicitly is not consent given on
 * that person's behalf.
 */
export function selectAffiliateRecipients(input: {
  rows: AffiliateRow[];
  suppressed: Set<string>;
  filter: AffiliateFilter;
  ambassadorIds: string[];
  siteUrl: string;
  /**
   * Ambassador id -> count of sales that earned commission. Only consulted by
   * the no_sales / has_sales groups; absent for every other filter so those do
   * not pay for a read they never use.
   */
  qualifyingSales?: Map<string, number>;
}): AffiliateRecipient[] {
  const origin = String(input.siteUrl ?? "").replace(/\/$/, "");
  // "selected" with an empty list means NOBODY. Falling back to everyone would
  // turn a half-finished pick into an unrecallable send to the whole programme.
  const picked = new Set(input.ambassadorIds.map((id) => String(id)));
  const suppressed = new Set(Array.from(input.suppressed, normalizeEmail));

  const recipients: AffiliateRecipient[] = [];
  // One message per person: `partners` and `ambassadors` are twinned identities
  // and someone pre-added by the owner can later apply, so two rows sharing an
  // address is ordinary rather than exceptional. The first row wins.
  const seen = new Set<string>();

  for (const row of input.rows) {
    if (!isActiveAffiliate(row)) continue;
    if (input.filter === "selected" && !picked.has(String(row.id))) continue;

    if (input.filter === "no_sales" || input.filter === "has_sales") {
      const sales = input.qualifyingSales?.get(String(row.id)) ?? 0;
      const wantsSales = input.filter === "has_sales";
      if (wantsSales !== sales > 0) continue;
    }

    const email = normalizeEmail(row.email);
    if (!email) continue;
    if (suppressed.has(email)) continue;
    // Same rule as the customer audience: a sink or reserved-domain address
    // cannot be a real affiliate, and mailing one damages the sending domain.
    if (isNonMailableAddress(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);

    const code = String(row.referral_code ?? "").trim();
    recipients.push({
      ambassadorId: String(row.id),
      email,
      mergeContext: {
        firstName: row.first_name ? String(row.first_name) : null,
        referralCode: code,
        referralLink: `${origin}/r/${code}`,
        dashboardLink: `${origin}/account/ambassador`,
        commissionPercent: Number(row.commission_percent ?? 0),
      },
    });
  }

  return recipients;
}

/**
 * Read the affiliate list and the suppression list, then apply the rule above.
 *
 * Both reads are bounded and a truncated read is FATAL, matching audience.ts. A
 * short affiliate read means affiliates silently miss a campaign; a short
 * suppression read means someone who asked us to stop receives one. The second
 * is not ours to absorb, so neither is guessed at.
 */

/** Everything the recipient picker shows about one affiliate. */
export type AffiliateDirectoryEntry = {
  id: string;
  name: string;
  email: string;
  referralCode: string;
  commissionPercent: number;
  suppressed: boolean;
};

/** Shared with the server half, which needs the same normalisation. */
export function normalizeAudienceEmail(value: unknown): string {
  return normalizeEmail(value);
}
