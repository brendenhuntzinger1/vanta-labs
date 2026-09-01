import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { getSiteUrl } from "@/lib/env";
import { commissionOrderCounts, type TierQualifyingRow } from "@/lib/ambassador-commission";
import {
  isActiveAffiliate,
  normalizeAudienceEmail as normalizeEmail,
  selectAffiliateRecipients,
  type AffiliateDirectoryEntry,
  type AffiliateFilter,
  type AffiliateRecipient,
  type AffiliateRow,
} from "@/lib/email/affiliate-audience-shared";

/**
 * The database half of the affiliate audience: read the affiliate list and the
 * suppression list, then apply the rules in affiliate-audience-shared.ts.
 *
 * Re-exports the shared half so existing importers of this module are unchanged.
 */
export * from "@/lib/email/affiliate-audience-shared";

const MAX_AFFILIATE_ROWS = 100_000;
const AUDIENCE_TRUNCATED =
  "Could not read the whole affiliate list, so this send was refused rather than sent to an incomplete or unfiltered list.";

/**
 * How many commission-earning sales each affiliate has, by ambassador id.
 *
 * THE RULE IS NOT RESTATED HERE. `commissionOrderCounts` is the same predicate
 * the commission engine uses to decide which referred orders are real, so a
 * refunded, reversed, fraud-flagged or zero-commission order is excluded from
 * this count exactly as it is excluded from an affiliate's tier. A second copy
 * of that rule would eventually congratulate someone whose only sale was
 * refunded.
 */
async function loadQualifyingSalesByAffiliate(): Promise<Map<string, number>> {
  const { rows } = await readAllRowsBounded<TierQualifyingRow & { ambassador_id: string | null }>(
    (from, to) => supabaseAdmin
      .from("referral_orders")
      .select("ambassador_id, created_at, payment_status, ineligible_reason, commission_amount, fraud_flag")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<TierQualifyingRow & { ambassador_id: string | null }> | null; error: unknown }>,
    { maxRows: MAX_AFFILIATE_ROWS, label: "affiliate qualifying sales read" },
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = String(row.ambassador_id ?? "");
    if (!id) continue;
    if (!commissionOrderCounts(row)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export async function resolveAffiliateAudience(input: {
  filter: AffiliateFilter;
  ambassadorIds?: string[] | null;
  siteUrl?: string;
}): Promise<AffiliateRecipient[]> {
  const { rows, truncated } = await readAllRowsBounded<AffiliateRow>(
    (from, to) => supabaseAdmin
      .from("ambassadors")
      .select("id, email, first_name, referral_code, commission_percent, status, disabled_at")
      // A stable key: paging without one can repeat or skip rows, and a skipped
      // row here is an affiliate who never receives the campaign.
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: AffiliateRow[] | null; error: unknown }>,
    { maxRows: MAX_AFFILIATE_ROWS, label: "affiliate audience read" },
  );
  if (truncated) throw new Error(AUDIENCE_TRUNCATED);

  const { rows: suppressedRows, truncated: suppressionTruncated } = await readAllRowsBounded<{ email: string }>(
    (from, to) => supabaseAdmin
      .from("email_suppressions")
      .select("email")
      .order("email", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{ email: string }> | null; error: unknown }>,
    { maxRows: MAX_AFFILIATE_ROWS, label: "suppression list read" },
  );
  if (suppressionTruncated) throw new Error(AUDIENCE_TRUNCATED);

  // Only the sales-based groups pay for this read.
  const needsSales = input.filter === "no_sales" || input.filter === "has_sales";
  const qualifyingSales = needsSales ? await loadQualifyingSalesByAffiliate() : undefined;

  return selectAffiliateRecipients({
    rows,
    suppressed: new Set(suppressedRows.map((row) => normalizeEmail(row.email))),
    filter: input.filter,
    ambassadorIds: input.ambassadorIds ?? [],
    siteUrl: input.siteUrl ?? getSiteUrl(),
    qualifyingSales,
  });
}

/**
 * The affiliate directory behind the recipient picker.
 *
 * Returns only what the picker needs to show a name, an address and a code —
 * never the whole ambassador row, which carries payout details the email screen
 * has no business handling.
 */
export async function listAffiliateDirectory(siteUrl?: string): Promise<AffiliateDirectoryEntry[]> {
  void siteUrl;
  const { rows } = await readAllRowsBounded<AffiliateRow & { last_name: string | null }>(
    (from, to) => supabaseAdmin
      .from("ambassadors")
      .select("id, email, first_name, last_name, referral_code, commission_percent, status, disabled_at")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<AffiliateRow & { last_name: string | null }> | null; error: unknown }>,
    { maxRows: MAX_AFFILIATE_ROWS, label: "affiliate directory read" },
  );

  const { rows: suppressedRows } = await readAllRowsBounded<{ email: string }>(
    (from, to) => supabaseAdmin
      .from("email_suppressions")
      .select("email")
      .order("email", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{ email: string }> | null; error: unknown }>,
    { maxRows: MAX_AFFILIATE_ROWS, label: "suppression list read" },
  );
  const suppressed = new Set(suppressedRows.map((row) => normalizeEmail(row.email)));

  const seen = new Set<string>();
  const entries: AffiliateDirectoryEntry[] = [];
  for (const row of rows) {
    if (!isActiveAffiliate(row)) continue;
    const email = normalizeEmail(row.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = [row.first_name, row.last_name].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
    entries.push({
      id: String(row.id),
      // Shown in the picker; the address is the fallback label so a row is never
      // an anonymous checkbox.
      name: name || email,
      email,
      referralCode: String(row.referral_code ?? ""),
      commissionPercent: Number(row.commission_percent ?? 0),
      // Shown greyed out with a reason, rather than hidden: an owner looking for
      // someone specific needs to know why they cannot be mailed.
      suppressed: suppressed.has(email),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
