import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { campaignTemplate } from "@/lib/email/templates";
import { getEmailRuntimeConfig, marketingBlockedReason } from "@/lib/email/settings";
import { resolveAudience, isCampaignSegment, type CampaignSegment } from "@/lib/email/audience";
import { buildCampaignClickUrl, buildCampaignLinkClickUrl, buildCampaignOpenUrl } from "@/lib/email/campaign-links";
import { resolveAffiliateAudience, type AffiliateFilter } from "@/lib/email/affiliate-audience";
import { buildAffiliateCampaignEmail, normalizeLinkButtons } from "@/lib/email/affiliate-campaign-template";
import type { AffiliateMergeContext } from "@/lib/email/affiliate-merge";
import { getSiteUrl } from "@/lib/env";
import { claimMarketingSend } from "@/lib/email/frequency";
import { campaignOfferKey } from "@/lib/offers/campaign-gift";
import { resolveCampaignGift } from "@/lib/offers/campaign-gift-server";
import {
  describeGiftTerms,
  issueResolvedOffer,
  revokeUnredeemedOffer,
  type GiftConfig,
} from "@/lib/offers/customer-offers";

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

/**
 * Consecutive THROWN sends before the sweep gives up and waits for the next one.
 *
 * Two, because the two failures this has to tell apart look identical from one
 * data point. A single throw is usually about that recipient — a merge context
 * written before a schema change, a malformed link — and the rest of the batch
 * should still go out, which is the whole reason the throw is caught at all.
 * Two in a row is not about the recipient: it is Supabase refusing connections
 * or the provider down, and continuing would burn all three attempts for every
 * recipient in seconds and close the campaign permanently 'failed' over an
 * outage that clears in a minute.
 */
export const CONSECUTIVE_THROW_ABORT = 2;

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
  audience_kind?: string | null;
  affiliate_filter?: string | null;
  affiliate_ids?: string[] | null;
  link_buttons?: unknown;
  /**
   * The gift this campaign carries, if any. Exactly one may be set — a
   * catalogue key or an operator-built one — and the database CHECK
   * `email_campaigns_one_gift_source` is what makes that a fact rather than an
   * intention. Both null means no gift, which is every campaign sent before
   * 2026-09-08.
   */
  offer_key?: string | null;
  offer_custom?: unknown;
};

/** Statuses a campaign may be in when a send or a schedule is allowed to start. */
export const SENDABLE_STATUSES = ["draft", "scheduled", "paused"] as const;

export class CampaignAlreadyStartedError extends Error {
  readonly status: string;
  constructor(status: string) {
    super("This campaign is already sending or sent.");
    this.name = "CampaignAlreadyStartedError";
    this.status = status;
  }
}

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
    .select("id, segment, segment_param, status, audience_kind, affiliate_filter, affiliate_ids")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.status === "sending" || campaign.status === "sent") {
    // Re-queuing a live or finished campaign is almost always a double-click,
    // not an intention — so it is REFUSED rather than returning a zero result.
    //
    // It used to return `{ queued: 0, alreadyQueued: 0 }`, which the send route
    // reports to the operator as "Nobody currently matches this audience, so
    // nothing was sent." A second click therefore looked like a successful send
    // to an empty list, on a campaign that was in fact mailing the whole
    // programme at that moment. Nobody received a duplicate — the unique index
    // saw to that — but the owner was told the opposite of what was happening.
    throw new CampaignAlreadyStartedError(String(campaign.status));
  }

  // Captured BEFORE the claim below mutates the row. Reading it afterwards
  // would restore 'sending' onto a campaign the restore exists to rescue.
  const previousStatus = String(campaign.status ?? "draft");

  // THE CLAIM, AND WHY IT IS AN UPDATE RATHER THAN THE READ ABOVE.
  //
  // The status check above is read-then-write: two clicks 50ms apart both read
  // 'draft' and both proceed. The unique constraint on (campaign_id, email)
  // already means neither can produce a duplicate EMAIL — that guarantee is
  // untouched and remains the real protection. What it does not do is stop the
  // second click looking like it worked, or stop two workers resolving the same
  // audience at once.
  //
  // This conditional update is the same claim protocol the recipient rows use:
  // only one caller's update matches, and a caller whose update matched nothing
  // knows someone else got there first. It is deliberately placed BEFORE the
  // audience read, which is the slow part and therefore the window a second
  // click lands in.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("email_campaigns")
    .update({ status: "sending", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .in("status", SENDABLE_STATUSES as unknown as string[])
    .select("id");
  if (claimError) throw claimError;
  if ((claimed ?? []).length === 0) {
    // Somebody else claimed it between the read and here.
    const { data: current } = await supabaseAdmin
      .from("email_campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle();
    throw new CampaignAlreadyStartedError(String(current?.status ?? "sending"));
  }

  try {
    const rows = await resolveCampaignRecipients(campaign as CampaignRow);

    // Upsert with ignoreDuplicates: the unique index is the idempotency
    // guarantee, so a partially-queued campaign can simply be queued again.
    let queued = 0;
    const CHUNK = 500;
    for (let index = 0; index < rows.length; index += CHUNK) {
      const chunk = rows.slice(index, index + CHUNK);
      const { data, error: insertError } = await supabaseAdmin
        .from("email_campaign_recipients")
        .upsert(chunk, { onConflict: "campaign_id,email", ignoreDuplicates: true })
        .select("id");
      if (insertError) throw insertError;
      queued += (data ?? []).length;
    }

    await supabaseAdmin
      .from("email_campaigns")
      .update({ recipient_count: rows.length, updated_at: new Date().toISOString() })
      .eq("id", campaignId);

    return { queued, alreadyQueued: rows.length - queued, status: "sending" };
  } catch (queueError) {
    // HAND THE CAMPAIGN BACK. The claim above moved it to 'sending'; if
    // resolving the audience then failed — a truncated read, a suppression-list
    // outage — leaving it there would strand it as a send in progress that has
    // no recipients and will be marked 'sent' by the next sweep, with the owner
    // believing it went out. Restoring the previous status makes the failure
    // visible and the campaign retryable.
    await supabaseAdmin
      .from("email_campaigns")
      .update({ status: previousStatus, started_at: null, updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("status", "sending");
    throw queueError;
  }
}

/** One queue row per recipient, shaped by which audience the campaign addresses. */
type RecipientInsert = {
  campaign_id: string;
  email: string;
  status: string;
  ambassador_id?: string | null;
  merge_context?: AffiliateMergeContext | null;
};

/**
 * Resolve the audience for a campaign of either kind.
 *
 * The customer path is untouched: same `resolveAudience`, same segments, same
 * row shape (ambassador_id and merge_context are simply absent, which is what
 * every existing row already looks like).
 *
 * The affiliate path additionally snapshots each affiliate's merge values. See
 * affiliate-email-system.sql for why that is a snapshot rather than a lookup.
 */
async function resolveCampaignRecipients(campaign: CampaignRow): Promise<RecipientInsert[]> {
  const campaignId = String(campaign.id);

  if (String(campaign.audience_kind ?? "customer") === "affiliate") {
    const recipients = await resolveAffiliateAudience({
      filter: (campaign.affiliate_filter ?? "all_active") as AffiliateFilter,
      ambassadorIds: campaign.affiliate_ids ?? [],
    });
    return recipients.map((recipient) => ({
      campaign_id: campaignId,
      email: recipient.email,
      status: "pending",
      ambassador_id: recipient.ambassadorId,
      merge_context: recipient.mergeContext,
    }));
  }

  const segment = isCampaignSegment(campaign.segment) ? (campaign.segment as CampaignSegment) : "all";
  const emails = await resolveAudience({ segment, segmentParam: campaign.segment_param });
  return emails.map((email) => ({ campaign_id: campaignId, email, status: "pending" }));
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

  // EVERY stale claim is resolved, not just the retryable ones. This used to
  // reclaim only rows with attempts remaining, which left any row stranded at
  // max attempts sitting in 'claiming' forever. Nothing would ever move it, so
  // `remaining` could never reach zero, the campaign could never close out —
  // and because the sweep works oldest-campaign-first, that one stuck row would
  // spend every future sweep's budget and starve every campaign behind it.
  // A stalled queue is worse than a failed recipient.
  const { data: retryable, error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "pending", claimed_at: null })
    .eq("campaign_id", campaignId)
    .eq("status", "claiming")
    .lt("claimed_at", cutoff)
    .lt("attempts", MAX_ATTEMPTS)
    .select("id");
  if (error) return 0;

  // Out of attempts: give up on the recipient rather than on the campaign.
  await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "failed", claimed_at: null, error: "abandoned mid-send after repeated attempts" })
    .eq("campaign_id", campaignId)
    .eq("status", "claiming")
    .lt("claimed_at", cutoff)
    .gte("attempts", MAX_ATTEMPTS);

  return (retryable ?? []).length;
}

/**
 * Atomically take up to `limit` pending rows.
 *
 * The conditional update IS the lock. Two workers running at once both try to
 * move the same rows out of 'pending'; only one update matches each row, and
 * each worker sends only the rows its own update returned. Selecting first and
 * updating after would let both workers read the same rows and send twice.
 */
type ClaimedRecipient = { id: string; email: string; attempts: number; mergeContext: AffiliateMergeContext | null };

async function claimBatch(campaignId: string, limit: number, now: number): Promise<ClaimedRecipient[]> {
  const pending = () => supabaseAdmin
    .from("email_campaign_recipients")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "pending");
  // A recipient the frequency guard sent back waits until its window opens;
  // without this filter the loop below would re-claim it immediately.
  let { data: candidates, error: selectError } = await pending()
    .or(`deferred_until.is.null,deferred_until.lte.${new Date(now).toISOString()}`)
    .limit(limit);
  if (selectError && String((selectError as { code?: string }).code ?? "") === "42703") {
    // deferred_until has not been migrated here. The guard falls open on that
    // database, so its parking column must too — a campaign must not stall
    // on a filter for a column nothing on this database writes.
    ({ data: candidates, error: selectError } = await pending().limit(limit));
  }
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
    .select("id, email, attempts, merge_context");
  if (claimError) throw claimError;

  return (claimed ?? []).map((row) => ({
    id: String(row.id),
    email: String(row.email),
    attempts: Number(row.attempts ?? 0),
    // Present only for affiliate campaigns. Customer rows carry null, which is
    // what every row written before this column existed also reads as.
    mergeContext: ((row as { merge_context?: AffiliateMergeContext | null }).merge_context ?? null),
  }));
}

export type BatchResult = {
  sent: number;
  suppressed: number;
  failed: number;
  /** Held back by the marketing frequency guard; retried once each window opens. */
  deferred: number;
  remaining: number;
  finished: boolean;
  /**
   * The campaign's terminal status once the queue drained — 'sent' or 'failed'.
   * Null while work remains, because a campaign still sending has not reached a
   * verdict yet.
   */
  status: string | null;
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
    .select("id, name, subject, preview_text, headline, body, promo_code, cta_label, cta_path, segment, segment_param, status, scheduled_at, audience_kind, affiliate_filter, affiliate_ids, link_buttons, offer_key, offer_custom")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (campaignError) throw campaignError;
  if (!campaignData) throw new Error("Campaign not found");
  const campaign = campaignData as CampaignRow;

  // THE GIFT IS RESOLVED ONCE PER SWEEP, NOT ONCE PER RECIPIENT.
  //
  // It is the same answer for everybody in the batch and it costs a catalogue
  // read, so asking per recipient would multiply that read by the audience for
  // no new information.
  //
  // A campaign that SAYS it carries a gift and cannot deliver one does not
  // send. Throwing here is the same shape as the marketingBlockedReason check
  // above: nothing is consumed, no recipient is marked, the campaign stays
  // queued, and the admin sees why. The alternative — sending copy that
  // promises a free vial with a token that grants nothing — is the failure
  // that costs a customer rather than a sweep.
  const giftResolution = await resolveCampaignGift(campaign);
  if (giftResolution.error) throw new Error(giftResolution.error);
  const gift = giftResolution.gift ?? null;

  await reclaimStaleClaims(campaign.id, now);

  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  let deferred = 0;
  // Consecutive THROWN sends. Reset by any recipient that resolves normally —
  // delivered, suppressed or a returned failure. See CONSECUTIVE_THROW_ABORT.
  let consecutiveThrows = 0;
  let sweepAborted = false;

  /**
   * TAKE THE INBOX FIRST, MINT THE GIFT SECOND.
   *
   * ORDER IS THE WHOLE POINT. A gift's token has to be in the button and its
   * terms have to be in the body, so it must be minted BEFORE the message is
   * rendered. Mint first and every deferral leaves a live, spendable,
   * unannounced offer behind — and because a deferred recipient goes back to
   * pending, the next sweep mints another one. A campaign deferred for a week
   * would leave seven.
   *
   * So the frequency claim is taken here, explicitly, exactly as cart recovery
   * does it ("cart recovery does this so the claim precedes its coupon mint").
   * A deferral or a duplicate costs nothing because nothing has been minted
   * yet; only a granted claim proceeds to the mint, and sendMarketingEmail is
   * then handed that claim rather than taking a second one.
   *
   * Campaigns WITHOUT a gift keep the path they have always had — no explicit
   * claim, sendMarketingEmail takes its own. That is deliberate: this is the
   * highest-traffic marketing path in the app and the change should reach only
   * the campaigns that need it.
   */
  const takeGiftClaim = async (
    email: string,
    config: GiftConfig,
  ): Promise<
    | { outcome: "ready"; claimedLogId: string; token: string; terms: string }
    | { outcome: "blocked"; result: Awaited<ReturnType<typeof sendMarketingEmail>> }
  > => {
    const claim = await claimMarketingSend({
      email,
      campaignType: "campaign",
      referenceId: campaign.id,
      templateKey: "campaign",
    });

    if (claim.outcome === "deferred") {
      return {
        outcome: "blocked",
        result: {
          success: false,
          deferred: true,
          retryAt: claim.retryAt,
          error: "Deferred: this address received a marketing email inside the last 24 hours.",
        },
      };
    }
    if (claim.outcome === "duplicate") {
      return { outcome: "blocked", result: { success: false, duplicate: true, error: "Already sent: the send-once slot for this message is taken." } };
    }
    if (claim.outcome !== "claimed") {
      // "refused" or "unavailable". A gift-carrying campaign does NOT fall back
      // to the guard-less path the way an ordinary marketing send does: without
      // a claim there is nothing holding the inbox between the mint and the
      // wire, so a concurrent sweep could mint a second gift for the same
      // person. Failing this recipient costs one retry; the alternative costs a
      // duplicated gift.
      return { outcome: "blocked", result: { success: false, error: "Could not claim this send, so no gift was issued." } };
    }

    const issued = await issueResolvedOffer({
      offerKey: campaignOfferKey(campaign.id),
      config,
      email,
      referenceId: campaign.id,
    });

    if (!issued) {
      // THE CLAIM IS RELEASED, or it holds this address's inbox for fifteen
      // minutes and its send-once slot forever, for a message that never went.
      await supabaseAdmin.from("email_send_log").update({ status: "failed" }).eq("id", claim.logId);
      return { outcome: "blocked", result: { success: false, error: "Could not issue the gift this campaign promises, so nothing was sent." } };
    }

    return {
      outcome: "ready",
      claimedLogId: claim.logId,
      token: issued.token,
      // From the SAME config the mint wrote onto the row, so the sentence the
      // customer reads and the terms customer_offer_reserve enforces cannot
      // disagree.
      terms: describeGiftTerms(config, issued.expiresAt),
    };
  };

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

      // AFFILIATE CAMPAIGNS RENDER PER RECIPIENT; CUSTOMER CAMPAIGNS DO NOT.
      //
      // The customer branch below is byte-for-byte what it has always been —
      // same template call, same arguments, same tracking link. Personalisation
      // is an additional path taken only when the row carries a merge context,
      // which only affiliate queue rows do.
      const isAffiliate = String(campaign.audience_kind ?? "customer") === "affiliate" && recipient.mergeContext !== null;

      // ONE RECIPIENT CANNOT TAKE DOWN THE CAMPAIGN.
      //
      // Every other failure here is a RETURNED failure, and the branches below
      // handle those. A THROWN one is a different shape with a much worse
      // blast radius: sendMarketingEmail opens with a Supabase read of the
      // suppression list, and a transient error there REJECTS rather than
      // returning { success: false }. Uncaught, that unwinds this loop and
      // abandons every recipient still claimed in the batch — they sit in
      // `claiming` until reclaimStaleClaims releases them, so a scheduled
      // broadcast stops halfway with nothing on screen saying why.
      //
      // Rendering can throw too (a merge context written before a schema
      // change, a malformed link button), so the template build is inside the
      // same guard. A throw is treated as exactly what it is: this recipient's
      // attempt failed, and it is retried on the next sweep like any other.
      // THE GIFT IS SETTLED BEFORE ANYTHING IS RENDERED OR SENT.
      //
      // A GIFT ONLY RIDES A CUSTOMER CAMPAIGN. Affiliate broadcasts are
      // deliberately untouched: the affiliate programme is a separate system
      // with its own templates and its own commercial terms, and a customer
      // gift minted against an affiliate's address would be neither.
      //
      // `result` is set here only when the claim BLOCKED — deferred, duplicate,
      // or unclaimable — in which case nothing was minted, nothing is sent, and
      // the status branches below record exactly that.
      let result: Awaited<ReturnType<typeof sendMarketingEmail>> | null = null;
      let claimedLogId: string | null = null;
      let offerTerms: string | null = null;
      // Scoped out here so every failure branch below can withdraw a gift that
      // was minted for a message which then never left.
      let mintedToken: string | null = null;

      if (gift && !isAffiliate) {
        try {
          const attempt = await takeGiftClaim(recipient.email, gift);
          if (attempt.outcome === "blocked") {
            result = attempt.result;
          } else {
            claimedLogId = attempt.claimedLogId;
            mintedToken = attempt.token;
            offerTerms = attempt.terms;
          }
          consecutiveThrows = 0;
        } catch (error) {
          result = {
            success: false,
            error: error instanceof Error ? error.message : "the gift could not be issued",
          };
          consecutiveThrows += 1;
          sweepAborted = consecutiveThrows >= CONSECUTIVE_THROW_ABORT;
        }
      }

      if (result === null) try {
        const template = isAffiliate
          ? buildAffiliateCampaignEmail({
              subject: campaign.subject,
              previewText: campaign.preview_text,
              headline: campaign.headline,
              body: campaign.body,
              ctaLabel: campaign.cta_label,
              ctaPath: campaign.cta_path,
              linkButtons: normalizeLinkButtons(campaign.link_buttons),
              mergeContext: recipient.mergeContext as AffiliateMergeContext,
              siteUrl: getSiteUrl(),
              postalAddress: config.marketingPostalAddress,
              trackedUrlFor: (linkIndex) => buildCampaignLinkClickUrl(campaign.id, recipient.email, linkIndex),
            })
          : campaignTemplate({
              subject: campaign.subject,
              previewText: campaign.preview_text,
              headline: campaign.headline,
              body: campaign.body,
              promoCode: campaign.promo_code,
              ctaLabel: campaign.cta_label,
              // The gift's token rides the button when there is one, so the
              // click that brings the customer back is also the moment the
              // gift lands in their browser.
              ctaUrl: buildCampaignClickUrl(campaign.id, recipient.email, mintedToken),
              // The store's own statement of what the till will honour —
              // minimum, deadline, one per customer — rendered under whatever
              // the operator wrote. Copy that promises more than the checkout
              // applies is the failure this line exists to prevent.
              offerTerms,
              postalAddress: config.marketingPostalAddress,
            });

        // THE SAME MARKETING WRAPPER EITHER WAY. Suppression, the one-click
        // unsubscribe headers, the CAN-SPAM postal address and the marketing From
        // identity are not re-implemented for affiliates — an affiliate broadcast
        // is a commercial message and gets every protection a customer campaign
        // gets. campaignType distinguishes the two in email_send_log so the
        // histories stay separable.
        result = await sendMarketingEmail({
          to: recipient.email,
          campaignType: isAffiliate ? "affiliate_campaign" : "campaign",
          referenceId: campaign.id,
          templateKey: isAffiliate ? "affiliate_campaign" : "campaign",
          openTrackingPixelUrl: buildCampaignOpenUrl(campaign.id, recipient.email),
          // A gift-carrying send already holds its claim, taken before the
          // mint. Passing it means the wrapper closes THAT row rather than
          // asking the guard for a second one — which would answer "deferred",
          // because the row this send is holding is itself a marketing send
          // inside the window.
          claimedLogId,
          ...template,
        });
        // It RESOLVED — delivered, suppressed, or a returned failure. The
        // pipeline works, so any previous throw was about that one recipient
        // and the run starts over.
        consecutiveThrows = 0;
      } catch (error) {
        result = {
          success: false,
          error: error instanceof Error ? error.message : "send failed unexpectedly",
        };
        // A THROW ENDS THE SWEEP — it does not just cost this recipient.
        //
        // Catching the throw stopped the batch being abandoned, and on its own
        // introduced a quieter fault. This loop re-claims pending rows until the
        // time budget runs out, so a SYSTEMIC failure — Supabase refusing
        // connections, the provider down — throws for every recipient, returns
        // each to pending, re-claims it immediately and throws again. Three
        // attempts burn in seconds and the campaign closes permanently 'failed',
        // for an outage that would have cleared before the next sweep.
        //
        // Ending the sweep costs a deterministic per-recipient throw one attempt
        // per sweep (so it still terminates after MAX_ATTEMPTS, across three
        // sweeps) and costs an outage one attempt in total.
        consecutiveThrows += 1;
        sweepAborted = consecutiveThrows >= CONSECUTIVE_THROW_ABORT;
      }

      // A GIFT THAT WAS MINTED FOR A MESSAGE THAT NEVER ARRIVED IS WITHDRAWN.
      //
      // The token exists only in this process — it is never stored, only its
      // hash — so a send that failed after the mint leaves a live, spendable,
      // unannounced offer that nobody can be told about and that blocks the
      // one-live-offer index for the retry. Withdrawing it makes the retry a
      // clean mint rather than a reissue, and closes the window in which an
      // offer nobody was told about stands open against the store.
      //
      // Only ever touches a row that is still unspent, so a token the customer
      // is already spending at this instant is left exactly as it is.
      if (mintedToken && !result.success) {
        await revokeUnredeemedOffer(mintedToken, "send_failed");
      }

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
      } else if (result.deferred) {
        // THE FREQUENCY GUARD SAID NOT TODAY. Back to pending with a
        // deferred_until the batch claim honours, and no attempt counted: a
        // recipient who was mailed by something else this morning has not
        // failed anything. The campaign stays 'sending' until they are reached.
        deferred++;
        await supabaseAdmin
          .from("email_campaign_recipients")
          .update({
            status: "pending",
            claimed_at: null,
            deferred_until: new Date(result.retryAt ?? Date.now() + 60 * 60 * 1000).toISOString(),
            error: "deferred: a marketing email reached this address inside the last 24 hours",
          })
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

      if (sweepAborted) break;
    }

    if (sweepAborted) {
      // Hand the rest of this batch straight back rather than leaving it for
      // reclaimStaleClaims ten minutes later. Scoped to the rows this sweep
      // claimed, and conditioned on status, so a concurrent sweep's rows are
      // untouched.
      const stillClaimed = batch.map((row) => row.id);
      if (stillClaimed.length) {
        await supabaseAdmin
          .from("email_campaign_recipients")
          .update({ status: "pending", claimed_at: null })
          .in("id", stillClaimed)
          .eq("status", "claiming");
      }
      break;
    }
  }

  const { count: remainingCount } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .in("status", ["pending", "claiming"]);

  const remaining = remainingCount ?? 0;
  const finished = remaining === 0;

  let terminalStatus: string | null = null;
  if (finished) {
    // A DRAINED QUEUE IS NOT THE SAME AS A DELIVERED CAMPAIGN.
    //
    // This used to write 'sent' the moment nothing was left pending. A row that
    // FAILED is not pending either, so a campaign whose every recipient was
    // refused — an expired SMTP password, a revoked API key, a provider outage —
    // closed as 'sent' and showed the owner a green "Sent" in the history. The
    // failure count sat in its own column, but the status badge is what gets
    // scanned, and it said the message went out. For an affiliate broadcast
    // ("the new commission structure", "the sale starts Friday") that is the one
    // report that must never be wrong: nobody received it, and nothing on screen
    // said so.
    //
    // COUNTED FROM THE DATABASE, NOT FROM THIS BATCH'S OWN TALLIES. A large send
    // spans several sweeps and only the last one closes it; that closing sweep
    // may have sent nothing of its own while earlier sweeps delivered to
    // thousands. The verdict is about the campaign, so it is read from the
    // campaign's rows.
    const [{ count: deliveredCount }, { count: failedCount }] = await Promise.all([
      supabaseAdmin
        .from("email_campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign.id)
        .eq("status", "sent"),
      supabaseAdmin
        .from("email_campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign.id)
        .eq("status", "failed"),
    ]);

    // Only the unambiguous case is called a failure: nothing delivered, and at
    // least one refusal to explain why. A PARTIAL failure stays 'sent' — those
    // people genuinely received it, and telling the owner to resend would mail
    // them twice. An audience that was entirely suppressed also stays 'sent':
    // nothing went wrong, there was simply nobody left to mail.
    terminalStatus = (deliveredCount ?? 0) === 0 && (failedCount ?? 0) > 0 ? "failed" : "sent";

    await supabaseAdmin
      .from("email_campaigns")
      .update({ status: terminalStatus, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("status", "sending");
  }

  return { sent, suppressed, failed, deferred, remaining, finished, status: terminalStatus };
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
