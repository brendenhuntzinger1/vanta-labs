import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { campaignTemplate } from "@/lib/email/templates";
import { getEmailRuntimeConfig, marketingBlockedReason } from "@/lib/email/settings";
import { resolveAudience, isCampaignSegment, type CampaignSegment } from "@/lib/email/audience";
import { buildCampaignClickUrl, buildCampaignOpenUrl } from "@/lib/email/campaign-links";

/**
 * Queueing and sending campaigns.
 *
 * THE WHOLE DESIGN IS SHAPED BY ONE CONSTRAINT: the cron sweep has a hard
 * 60-second ceiling, shared with ten other jobs. A serial loop over the audience
 * — which is what the coupon broadcast this replaces does — gets killed partway
 * through a list of any size, with no record of how far it got. The next run
 * then either starts again from the top (duplicate mail to real customers) or
 * never finishes at all.
 *
 * So sending is a QUEUE, not a loop:
 *   1. queueCampaign resolves the audience once and writes a row per recipient;
 *   2. each sweep claims a small batch, sends it, and stops when its time is up;
 *   3. the next sweep picks up exactly where the last one stopped.
 *
 * "Where it stopped" is just `status = 'pending'`, and the unique constraint on
 * (campaign_id, email) means re-queuing can never produce a second row for the
 * same person. Both properties are what make an interrupted send safe.
 */

/** How long one sweep may spend sending, leaving room for the other cron jobs. */
export const CAMPAIGN_SWEEP_BUDGET_MS = 20_000;
/** Rows claimed per round. Small enough that a killed run strands very little. */
export const CAMPAIGN_BATCH_SIZE = 25;
/** A row claimed but never resolved is returned to the queue after this. */
export const CLAIM_RECLAIM_AFTER_MS = 10 * 60 * 1000;
/** Give up on a recipient after this many failed attempts. */
export const MAX_ATTEMPTS = 3;

export type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  preview_text: string | null;
  headline: string;
  body: string;
  promo_code: string | null;
  cta_label: string;
  cta_path: string;
  segment: string;
  segment_param: string | null;
  status: string;
  scheduled_at: string | null;
};

export type QueueResult = {
  queued: number;
  alreadyQueued: number;
  status: string;
};

/**
 * Resolve the audience and materialise it as work.
 *
 * The audience is resolved ONCE, here, and never re-derived mid-send. If it
 * were recomputed per batch, a customer who ordered halfway through a win-back
 * campaign would silently leave the segment and either receive the message
 * twice or not at all, depending on batch timing — a bug that would only ever
 * show up on large lists, in production.
 */
export async function queueCampaign(campaignId: string): Promise<QueueResult> {
  const { data: campaign, error } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, segment, segment_param, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.status === "sending" || campaign.status === "sent") {
    // Re-queuing a live or finished campaign is almost always a double-click,
    // not an intention.
    return { queued: 0, alreadyQueued: 0, status: String(campaign.status) };
  }

  const segment = isCampaignSegment(campaign.segment) ? (campaign.segment as CampaignSegment) : "all";
  const emails = await resolveAudience({ segment, segmentParam: campaign.segment_param });

  // Upsert with ignoreDuplicates: the unique index is the idempotency
  // guarantee, so a partially-queued campaign can simply be queued again.
  let queued = 0;
  const CHUNK = 500;
  for (let index = 0; index < emails.length; index += CHUNK) {
    const chunk = emails.slice(index, index + CHUNK).map((email) => ({
      campaign_id: campaignId,
      email,
      status: "pending",
    }));
    const { data, error: insertError } = await supabaseAdmin
      .from("email_campaign_recipients")
      .upsert(chunk, { onConflict: "campaign_id,email", ignoreDuplicates: true })
      .select("id");
    if (insertError) throw insertError;
    queued += (data ?? []).length;
  }

  await supabaseAdmin
    .from("email_campaigns")
    .update({
      status: "sending",
      started_at: new Date().toISOString(),
      recipient_count: emails.length,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);

  return { queued, alreadyQueued: emails.length - queued, status: "sending" };
}

/**
 * Return rows stranded mid-claim by a killed run.
 *
 * Without this, every batch a serverless timeout interrupts would leave its
 * claimed rows unsendable forever, and the campaign would stall a few short of
 * complete with no visible error.
 */
async function reclaimStaleClaims(campaignId: string, now: number): Promise<number> {
  const cutoff = new Date(now - CLAIM_RECLAIM_AFTER_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "pending", claimed_at: null })
    .eq("campaign_id", campaignId)
    .eq("status", "claiming")
    .lt("claimed_at", cutoff)
    .lt("attempts", MAX_ATTEMPTS)
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}

/**
 * Atomically take up to `limit` pending rows.
 *
 * The conditional update IS the lock. Two workers running at once both try to
 * move the same rows out of 'pending'; only one update matches each row, and
 * each worker sends only the rows its own update returned. Selecting first and
 * updating after would let both workers read the same rows and send twice.
 */
async function claimBatch(campaignId: string, limit: number, now: number): Promise<Array<{ id: string; email: string; attempts: number }>> {
  const { data: candidates, error: selectError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .limit(limit);
  if (selectError) throw selectError;
  const ids = (candidates ?? []).map((row) => String(row.id));
  if (ids.length === 0) return [];

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "claiming", claimed_at: new Date(now).toISOString() })
    .in("id", ids)
    // The guard that makes this a claim rather than a read: a row another
    // worker already took is no longer 'pending' and will not be returned.
    .eq("status", "pending")
    .select("id, email, attempts");
  if (claimError) throw claimError;

  return (claimed ?? []).map((row) => ({
    id: String(row.id),
    email: String(row.email),
    attempts: Number(row.attempts ?? 0),
  }));
}

export type BatchResult = {
  sent: number;
  suppressed: number;
  failed: number;
  remaining: number;
  finished: boolean;
};

/**
 * Send for one campaign until the batch is done or the time budget runs out.
 *
 * Recipients are sent SERIALLY on purpose. Fanning out concurrently would be
 * faster and would also be the fastest way to trip a provider's rate limit
 * mid-campaign, which converts a slow send into a partly-failed one.
 */
export async function sendCampaignBatch(input: {
  campaignId: string;
  budgetMs?: number;
  batchSize?: number;
  now?: number;
}): Promise<BatchResult> {
  const started = Date.now();
  const budget = input.budgetMs ?? CAMPAIGN_SWEEP_BUDGET_MS;
  const now = input.now ?? started;

  const config = await getEmailRuntimeConfig();
  const blocked = marketingBlockedReason(config);
  if (blocked) {
    // Not a failure of the campaign — nothing is consumed, nothing is marked.
    // The admin sees the reason and the queue waits.
    throw new Error(blocked);
  }

  const { data: campaignData, error: campaignError } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, name, subject, preview_text, headline, body, promo_code, cta_label, cta_path, segment, segment_param, status, scheduled_at")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (campaignError) throw campaignError;
  if (!campaignData) throw new Error("Campaign not found");
  const campaign = campaignData as CampaignRow;

  await reclaimStaleClaims(campaign.id, now);

  let sent = 0;
  let suppressed = 0;
  let failed = 0;

  while (Date.now() - started < budget) {
    const batch = await claimBatch(campaign.id, input.batchSize ?? CAMPAIGN_BATCH_SIZE, Date.now());
    if (batch.length === 0) break;

    for (const recipient of batch) {
      if (Date.now() - started >= budget) {
        // Out of time with rows still claimed. Hand them straight back rather
        // than letting the reaper wait ten minutes to do it.
        await supabaseAdmin
          .from("email_campaign_recipients")
          .update({ status: "pending", claimed_at: null })
          .eq("id", recipient.id)
          .eq("status", "claiming");
        continue;
      }

      const template = campaignTemplate({
        subject: campaign.subject,
        previewText: campaign.preview_text,
        headline: campaign.headline,
        body: campaign.body,
        promoCode: campaign.promo_code,
        ctaLabel: campaign.cta_label,
        ctaUrl: buildCampaignClickUrl(campaign.id, recipient.email),
        postalAddress: config.marketingPostalAddress,
      });

      const result = await sendMarketingEmail({
        to: recipient.email,
        campaignType: "campaign",
        referenceId: campaign.id,
        templateKey: "campaign",
        openTrackingPixelUrl: buildCampaignOpenUrl(campaign.id, recipient.email),
        ...template,
      });

      const attempts = recipient.attempts + 1;
      if (result.success) {
        sent++;
        await supabaseAdmin
          .from("email_campaign_recipients")
          .update({ status: "sent", sent_at: new Date().toISOString(), attempts, error: null })
          .eq("id", recipient.id);
      } else if (result.suppressed) {
        suppressed++;
        await supabaseAdmin
          .from("email_campaign_recipients")
          .update({ status: "suppressed", attempts, error: result.error ?? null })
          .eq("id", recipient.id);
      } else {
        failed++;
        // Back to pending while attempts remain: a provider hiccup on one
        // address shouldn't cost that person the campaign.
        const exhausted = attempts >= MAX_ATTEMPTS;
        await supabaseAdmin
          .from("email_campaign_recipients")
          .update({
            status: exhausted ? "failed" : "pending",
            claimed_at: null,
            attempts,
            error: (result.error ?? "send failed").slice(0, 300),
          })
          .eq("id", recipient.id);
      }
    }
  }

  const { count: remainingCount } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .in("status", ["pending", "claiming"]);

  const remaining = remainingCount ?? 0;
  const finished = remaining === 0;

  if (finished) {
    await supabaseAdmin
      .from("email_campaigns")
      .update({ status: "sent", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("status", "sending");
  }

  return { sent, suppressed, failed, remaining, finished };
}

export type CampaignSweepResult = {
  campaignsStarted: number;
  campaignsAdvanced: number;
  sent: number;
  failed: number;
  errors: string[];
};

/**
 * The cron entry point: start anything due, then advance anything in flight.
 *
 * Errors are collected rather than thrown. One malformed campaign must not stop
 * the other jobs in the sweep, and a campaign that can't send needs to surface
 * as a message in the admin, not as a rejected promise nobody reads.
 */
export async function runCampaignSweep(input?: { now?: number; budgetMs?: number }): Promise<CampaignSweepResult> {
  const now = input?.now ?? Date.now();
  const budget = input?.budgetMs ?? CAMPAIGN_SWEEP_BUDGET_MS;
  const started = Date.now();
  const errors: string[] = [];
  let campaignsStarted = 0;
  let campaignsAdvanced = 0;
  let sent = 0;
  let failed = 0;

  const { data: due } = await supabaseAdmin
    .from("email_campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_at", new Date(now).toISOString());

  for (const row of due ?? []) {
    try {
      await queueCampaign(String(row.id));
      campaignsStarted++;
    } catch (error) {
      errors.push(`queue ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { data: sending } = await supabaseAdmin
    .from("email_campaigns")
    .select("id")
    .eq("status", "sending")
    .order("started_at", { ascending: true });

  for (const row of sending ?? []) {
    const elapsed = Date.now() - started;
    if (elapsed >= budget) break;
    try {
      const result = await sendCampaignBatch({
        campaignId: String(row.id),
        budgetMs: budget - elapsed,
      });
      campaignsAdvanced++;
      sent += result.sent;
      failed += result.failed;
    } catch (error) {
      errors.push(`send ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { campaignsStarted, campaignsAdvanced, sent, failed, errors };
}
