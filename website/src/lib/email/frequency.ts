import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * FREQUENCY CONTROL FOR MARKETING MAIL.
 *
 * Several flows can want the same person on the same day: a cart reminder at
 * hour one, the welcome offer on day three, a win-back the morning after a
 * campaign, a restock alert whenever stock lands. Each is correct on its own;
 * together they are three different discounts in one inbox and a spam report
 * waiting to happen.
 *
 * THE RULE, stated once: no address receives more than one marketing email
 * inside MARKETING_QUIET_MS, whoever is sending. It is enforced by
 * marketing_send_claim in the database (sql/marketing-frequency-guard.sql),
 * which takes a lock on the address, checks email_send_log for a marketing
 * send inside the window, and either writes the send-log row itself
 * ("claimed") or refuses ("deferred") and says when the blocking send was.
 * Every marketing sender goes through sendMarketingEmail, which makes that
 * claim before it sends — so the guard is one place, and two senders racing
 * for one inbox in the same instant serialise on the lock instead of both
 * reading "nobody mailed recently".
 *
 * WHAT NEVER WAITS. Transactional mail — receipts, shipping, delivery, auth,
 * account and billing notices — does not go through sendMarketingEmail, does
 * not write marketing rows to email_send_log (auth writes under the auth:
 * prefix, which the guard ignores), and is never gated here.
 *
 * WHAT A DEFERRAL MEANS. Not "dropped". Each sender has a retry that fits it:
 *
 *   AUTOMATIONS     skip the recipient this sweep; eligibility is recomputed
 *                   next sweep (every 30 minutes), so the message arrives a day
 *                   later rather than never. Counted in the sweep result.
 *   CAMPAIGNS       the recipient row goes back to pending with deferred_until
 *                   set; the batch claim ignores it until then.
 *   CART RECOVERY   nothing is reserved or minted; the next sweep tries the
 *                   stage again while its window is open. A cart's own earlier
 *                   reminders do not defer its later ones (one conversation).
 *   EVENT MAIL      (back-in-stock, coupon announcements, membership welcome /
 *                   win-back / birthday) has no sweep of its own, so the
 *                   rendered message is parked in marketing_send_queue and
 *                   delivered by the cron sweep once its not_before passes —
 *                   through the same claim, so it can be deferred again.
 *
 * Priority inside the automation sweep is unchanged: post-purchase,
 * replenishment, welcome, win-back — so when two automations become due
 * together the one closest to money goes first and the other waits.
 */

/** How long an address stays quiet after ANY marketing message. */
export const MARKETING_QUIET_MS = 24 * 60 * 60 * 1000;

/** The automations' name for the same window, kept for existing callers. */
export const AUTOMATION_QUIET_MS = MARKETING_QUIET_MS;

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
 * The sequence family a campaign type belongs to, when its own earlier steps
 * should not defer its later ones. Cart recovery is the only one: the
 * 30-minute, 12-hour and 24-hour reminders for ONE cart are one conversation,
 * paced by the stages' own windows. Everything else yields to everything.
 */
export function quietFamilyFor(campaignType: string): string | null {
  return campaignType.startsWith("cart_recovery_") ? "cart_recovery_" : null;
}

export type MarketingClaim =
  | { outcome: "claimed"; logId: string }
  | { outcome: "deferred"; lastMarketingAt: number; retryAt: number }
  | { outcome: "duplicate" }
  | { outcome: "refused" }
  | { outcome: "unavailable"; error: string };

/**
 * Claim the right to send one marketing email to an address, atomically.
 *
 * "claimed" means the email_send_log row now exists at status 'sending' and the
 * caller must close it (sendMarketingEmail does). "deferred" means a marketing
 * send inside the window stands in the way; retryAt is when the window opens.
 * "duplicate" means the send-once index for this campaign type already holds
 * the reference. "unavailable" means the database could not answer — an
 * un-migrated schema or a transport failure — and the caller decides what the
 * safe direction is (sendMarketingEmail falls back to logging after the send,
 * exactly as before the guard existed, and says so in the log).
 */
export async function claimMarketingSend(input: {
  email: string;
  campaignType: string;
  referenceId?: string | null;
  templateKey?: string | null;
  quietMs?: number;
}): Promise<MarketingClaim> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const campaignType = String(input.campaignType ?? "").trim();
  if (!email || !campaignType) return { outcome: "refused" };
  const quietMs = input.quietMs ?? MARKETING_QUIET_MS;
  try {
    const { data, error } = await supabaseAdmin.rpc("marketing_send_claim", {
      p_email: email,
      p_campaign_type: campaignType,
      p_reference_id: input.referenceId ?? null,
      p_template_key: input.templateKey ?? campaignType,
      p_quiet_seconds: Math.max(0, Math.round(quietMs / 1000)),
      p_exempt_family: quietFamilyFor(campaignType),
    });
    if (error) return { outcome: "unavailable", error: String(error.message ?? error) };
    const row = (Array.isArray(data) ? data[0] : data) as
      | { outcome?: string; log_id?: string | null; last_marketing_at?: string | null }
      | null
      | undefined;
    switch (row?.outcome) {
      case "claimed":
        return row.log_id ? { outcome: "claimed", logId: String(row.log_id) } : { outcome: "unavailable", error: "claim returned no row id" };
      case "deferred": {
        const last = row.last_marketing_at ? new Date(row.last_marketing_at).getTime() : Date.now();
        return { outcome: "deferred", lastMarketingAt: last, retryAt: last + quietMs };
      }
      case "duplicate":
        return { outcome: "duplicate" };
      case "refused":
        return { outcome: "refused" };
      default:
        return { outcome: "unavailable", error: `unexpected claim outcome ${String(row?.outcome)}` };
    }
  } catch (error) {
    return { outcome: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The most recent marketing send per address, looking back `lookbackMs`.
 *
 * Used by the automation sweep as a cheap PRE-FILTER so it does not attempt a
 * claim for every dormant customer every thirty minutes. The database claim is
 * still the authority — this snapshot cannot see what a sibling cron job sent
 * a second ago, and the claim can.
 *
 * Bounded by time rather than by row count, and keyed by lower-cased email.
 * A failed send is not pressure on anyone's inbox and is excluded.
 */
/** A 'sending' claim older than this is a crash, not a send — mirrors the RPC. */
export const STRANDED_CLAIM_MS = 15 * 60 * 1000;

export async function loadLastMarketingSendAt(input: {
  now: number;
  lookbackMs?: number;
}): Promise<Map<string, number>> {
  const lookback = input.lookbackMs ?? MARKETING_QUIET_MS;
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
      // The same rule as marketing_send_claim: a claim still at 'sending'
      // after fifteen minutes was stranded by a crash, not delivered, and must
      // not hold an inbox shut for a day.
      if (String(row.status ?? "") === "sending" && at < input.now - STRANDED_CLAIM_MS) continue;
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
  return input.now - input.lastMarketingSentAt < (input.quietMs ?? MARKETING_QUIET_MS);
}

/**
 * Park a deferred, fully rendered marketing message for the cron sweep.
 *
 * Lives here rather than in marketing-queue.ts so the sender does not import
 * the module that imports the sender. Delivery is marketing-queue.ts's job.
 */
export async function enqueueDeferredMarketingEmail(input: {
  rendered: { to: string; subject: string; html: string; text: string };
  campaignType: string;
  referenceId?: string | null;
  templateKey: string;
  notBefore: number;
}): Promise<boolean> {
  try {
    const recipient = input.rendered.to.trim().toLowerCase();
    // ONE QUEUED COPY PER (message, recipient). A deferral writes no send-log
    // row, so the senders' own dedup cannot see a parked message; an operator
    // who clicks Send twice inside the window must not park it twice.
    let existing = supabaseAdmin
      .from("marketing_send_queue")
      .select("id")
      .eq("recipient_email", recipient)
      .eq("campaign_type", input.campaignType)
      .eq("status", "queued")
      .limit(1);
    existing = input.referenceId ? existing.eq("reference_id", input.referenceId) : existing.is("reference_id", null);
    const { data: already, error: readError } = await existing;
    if (!readError && (already ?? []).length > 0) return true;
    const { error } = await supabaseAdmin.from("marketing_send_queue").insert({
      recipient_email: recipient,
      campaign_type: input.campaignType,
      reference_id: input.referenceId ?? null,
      template_key: input.templateKey,
      subject: input.rendered.subject,
      html: input.rendered.html,
      text_body: input.rendered.text,
      not_before: new Date(input.notBefore).toISOString(),
    });
    if (error) {
      console.error("[marketing-queue] unable to queue a deferred send", input.campaignType, error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[marketing-queue] queue unavailable", input.campaignType, error);
    return false;
  }
}
