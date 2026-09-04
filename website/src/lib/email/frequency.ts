import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * FREQUENCY CONTROL FOR MARKETING MAIL.
 *
 * Several flows can want the same person on the same day: a cart reminder at
 * hour one, the welcome offer on day three, a win-back the morning after a
 * campaign. Each is correct on its own; together they are three different
 * discounts in one inbox and a spam report waiting to happen.
 *
 * The rule is small and stated once here:
 *
 *   TRANSACTIONAL   never gated. A receipt is not marketing.
 *   CART RECOVERY   never deferred by other marketing — it is the highest
 *                   commercial intent this store sees — but a NEW sequence
 *                   waits seven days after the last one to the same address
 *                   (cart-recovery.ts).
 *   AUTOMATIONS     skip a recipient THIS SWEEP when any marketing message
 *                   reached them inside AUTOMATION_QUIET_MS. Skipped, not
 *                   consumed: eligibility is recomputed next sweep, so the
 *                   message arrives a day later rather than never.
 *   CAMPAIGNS       a deliberate operator action; not deferred. Automations
 *                   yield to them for the quiet period afterwards.
 *
 * Priority inside a sweep: post-purchase, replenishment, welcome, win-back —
 * in that order, so when two automations become due together the one closest
 * to money goes first and the other waits.
 */

/** How long an automation stays quiet after ANY marketing message to an address. */
export const AUTOMATION_QUIET_MS = 24 * 60 * 60 * 1000;

/**
 * Send-log rows that count as marketing pressure on an inbox.
 *
 * Auth mail (`auth:*`) is transactional and excluded. Everything else in
 * email_send_log — campaigns, automations, cart recovery, birthday, coupon
 * announcements, membership marketing — went through sendMarketingEmail and
 * counts.
 */
function isMarketingCampaignType(campaignType: string): boolean {
  return !campaignType.startsWith("auth:");
}

/**
 * The most recent marketing send per address, looking back `lookbackMs`.
 *
 * Bounded by time rather than by row count, and keyed by lower-cased email.
 * A failed send is not pressure on anyone's inbox and is excluded.
 */
export async function loadLastMarketingSendAt(input: {
  now: number;
  lookbackMs?: number;
}): Promise<Map<string, number>> {
  const lookback = input.lookbackMs ?? AUTOMATION_QUIET_MS;
  const since = new Date(input.now - lookback).toISOString();
  const last = new Map<string, number>();
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .select("recipient_email, campaign_type, sent_at, status")
      .gte("sent_at", since)
      .neq("status", "failed")
      .order("sent_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (!isMarketingCampaignType(String(row.campaign_type ?? ""))) continue;
      const email = String(row.recipient_email ?? "").trim().toLowerCase();
      const at = new Date(String(row.sent_at)).getTime();
      if (!email || !Number.isFinite(at)) continue;
      const existing = last.get(email);
      if (existing === undefined || at > existing) last.set(email, at);
    }
    if (rows.length < PAGE) break;
  }

  return last;
}

/** Pure: is this address inside its quiet period? */
export function isInQuietPeriod(input: {
  lastMarketingSentAt: number | undefined;
  now: number;
  quietMs?: number;
}): boolean {
  if (input.lastMarketingSentAt === undefined) return false;
  return input.now - input.lastMarketingSentAt < (input.quietMs ?? AUTOMATION_QUIET_MS);
}
