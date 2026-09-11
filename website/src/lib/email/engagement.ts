import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * ONE PLACE THAT ANSWERS "DID THEY OPEN IT?".
 *
 * Engagement was recorded in four different tables by four different routes,
 * and none of them was the table that lists every send. Cart recovery wrote to
 * `abandoned_cart_emails`, campaigns to `email_campaign_recipients`, automations
 * to `email_send_log`, and the provider's own open events were parsed into
 * `kind: "ignored"` and thrown away. So the honest answer to "who opened what"
 * was "depends which kind of mail you mean, and for two of the four kinds,
 * nobody knows" — which is how a 40% cart-recovery open rate sat in the database
 * for six weeks while the owner believed nothing had ever been opened.
 *
 * `email_send_log` already has one row per send across every channel, and it
 * already carries `opened_at` and `clicked_at`. It was simply never written to
 * by anything except the automations pixel. Every tracker now stamps it, so a
 * single read over one table answers the question for every message the system
 * sends. The per-channel tables keep their own copies — they are what the
 * campaign and cart-recovery panels already read, and rewriting those is a
 * separate change — but they are no longer the only copy.
 *
 * FIRST TOUCH ONLY. Every write is conditioned on the column still being null,
 * so the timestamp means "when they first opened it" rather than "when they
 * last did". That also makes the whole path idempotent, which matters because
 * both sources can report the same open: a mailbox that loads the pixel usually
 * loads the provider's tracking pixel in the same fetch.
 *
 * NEVER THROWS. Every caller is a tracking pixel, a redirect, or a webhook —
 * none of them may fail a customer's request over a bookkeeping write.
 */

export type EngagementKind = "opened" | "clicked";

const COLUMN: Record<EngagementKind, "opened_at" | "clicked_at"> = {
  opened: "opened_at",
  clicked: "clicked_at",
};

/** The campaign_type values whose reference_id is an email_campaigns row. */
const CAMPAIGN_TYPES = new Set(["campaign", "affiliate_campaign"]);

export interface SendLogIdentity {
  campaignType: string;
  referenceId: string | null;
  recipientEmail: string | null;
}

/**
 * Stamp the send-log row a first-party tracker just heard from.
 *
 * `recipientEmail` narrows the match and must be supplied whenever one
 * reference_id covers many recipients — a campaign fans out to thousands of
 * rows sharing its id, and stamping all of them because one person opened would
 * turn a 2% open rate into 100%. Automations and cart-recovery stages are
 * one-row-per-reference, so they may omit it.
 */
export async function stampSendLogEngagement(input: {
  kind: EngagementKind;
  campaignType: string;
  referenceId: string;
  recipientEmail?: string | null;
  at?: string;
}): Promise<boolean> {
  if (!input.campaignType || !input.referenceId) return false;
  const column = COLUMN[input.kind];
  try {
    let query = supabaseAdmin
      .from("email_send_log")
      .update({ [column]: input.at ?? new Date().toISOString() })
      .eq("campaign_type", input.campaignType)
      .eq("reference_id", input.referenceId)
      .is(column, null);
    if (input.recipientEmail) {
      query = query.eq("recipient_email", input.recipientEmail.trim().toLowerCase());
    }
    const { data, error } = await query.select("id");
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

export type EngagementSource = "pixel" | "click" | "provider";

const USER_AGENT_MAX = 300;

/**
 * KEEP THE EVIDENCE. Every open and click, raw, with what fetched it.
 *
 * The first-touch stamps above answer "did anyone ever open it". They cannot
 * say whether the fetch eight seconds after the send was a person, and on
 * 2026-09-11 a third of the "opens" on real recovery sends were that fetch.
 * This writes one append-only row per event into `email_engagement_events`;
 * engagement-classification.ts decides at read time which rows were people,
 * so the rule can change without losing history.
 *
 * NEVER THROWS, and never blocks a tracker: a pixel, a redirect and a webhook
 * all call this, and none of them may fail a customer's request over a
 * bookkeeping write. A missing table (the migration not yet applied) is the
 * same as a failed insert: false, and the first-touch columns still carry on.
 */
export async function recordEngagementEvent(input: {
  kind: EngagementKind;
  source: EngagementSource;
  campaignType: string;
  referenceId: string | null;
  recipientEmail: string | null;
  userAgent: string | null | undefined;
  at?: string;
}): Promise<boolean> {
  const campaignType = String(input.campaignType ?? "").trim();
  const referenceId = input.referenceId ? String(input.referenceId) : null;
  const recipientEmail = input.recipientEmail ? String(input.recipientEmail).trim().toLowerCase() : null;
  // A row that names no send is noise nothing can ever join.
  if (!campaignType || (!referenceId && !recipientEmail)) return false;
  const agent = String(input.userAgent ?? "").trim();
  try {
    const { error } = await supabaseAdmin.from("email_engagement_events").insert({
      campaign_type: campaignType,
      reference_id: referenceId,
      recipient_email: recipientEmail,
      kind: input.kind,
      source: input.source,
      at: input.at ?? new Date().toISOString(),
      user_agent: agent ? agent.slice(0, USER_AGENT_MAX) : null,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * The send behind a provider message id, whether or not its first touch is
 * already stamped. `stampSendLogEngagementByMessageId` returns the identity
 * only when it stamped something, which is right for a first-touch column and
 * wrong for an event log that must keep the second open too.
 */
export async function findSendLogIdentityByMessageId(providerMessageId: string): Promise<SendLogIdentity | null> {
  if (!providerMessageId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .select("campaign_type, reference_id, recipient_email")
      .eq("provider_message_id", providerMessageId)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { campaign_type?: string | null; reference_id?: string | null; recipient_email?: string | null };
    if (!row.campaign_type) return null;
    return { campaignType: String(row.campaign_type), referenceId: row.reference_id ?? null, recipientEmail: row.recipient_email ?? null };
  } catch {
    return null;
  }
}

/**
 * The campaign tracker's event. A campaign id belongs to one kind of send
 * (customer campaign or affiliate broadcast) and the send log knows which, so
 * the event is filed under the same campaign_type the send was.
 */
export async function recordCampaignEngagementEvent(
  kind: EngagementKind,
  campaignId: string,
  recipientEmail: string,
  options: { source: EngagementSource; userAgent: string | null | undefined },
): Promise<boolean> {
  if (!campaignId || !recipientEmail) return false;
  try {
    const { data } = await supabaseAdmin
      .from("email_send_log")
      .select("campaign_type")
      .in("campaign_type", Array.from(CAMPAIGN_TYPES))
      .eq("reference_id", campaignId)
      .eq("recipient_email", recipientEmail.trim().toLowerCase())
      .limit(1)
      .maybeSingle();
    const campaignType = String((data as { campaign_type?: string } | null)?.campaign_type ?? "campaign");
    return await recordEngagementEvent({ kind, source: options.source, campaignType, referenceId: campaignId, recipientEmail, userAgent: options.userAgent });
  } catch {
    return false;
  }
}

/**
 * Stamp the send-log row the PROVIDER just reported on.
 *
 * The provider knows only its own message id, which is exactly why every send
 * path records one: it is the single handle that joins their view of a message
 * to ours. Returns what the row turned out to be so the caller can mirror the
 * engagement into whichever per-channel table owns that kind of send — the
 * webhook has no other way to know whether a message id belonged to a campaign,
 * an automation or a cart reminder.
 *
 * Returns null when nothing was stamped, which covers three different things
 * and deliberately does not distinguish them: no row carries that id (an auth
 * email, or a send that predates message-id capture), the row is already
 * stamped, or the read failed.
 */
export async function stampSendLogEngagementByMessageId(input: {
  kind: EngagementKind;
  providerMessageId: string;
  at?: string;
}): Promise<SendLogIdentity | null> {
  if (!input.providerMessageId) return null;
  const column = COLUMN[input.kind];
  try {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .update({ [column]: input.at ?? new Date().toISOString() })
      .eq("provider_message_id", input.providerMessageId)
      .is(column, null)
      .select("campaign_type, reference_id, recipient_email");
    if (error) return null;
    const row = (data ?? [])[0] as
      | { campaign_type?: string | null; reference_id?: string | null; recipient_email?: string | null }
      | undefined;
    if (!row) return null;
    return {
      campaignType: String(row.campaign_type ?? ""),
      referenceId: row.reference_id ?? null,
      recipientEmail: row.recipient_email ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Stamp the send-log row behind a campaign link.
 *
 * A campaign link knows the campaign id and the recipient, but not whether the
 * campaign was a customer campaign or an affiliate broadcast — the two share
 * `email_campaigns` and differ only in the `campaign_type` their sends are
 * logged under. Matching both is exact rather than loose: a campaign id belongs
 * to one row of one kind, so at most one of the two can match.
 */
export async function stampCampaignEngagement(
  kind: EngagementKind,
  campaignId: string,
  recipientEmail: string,
): Promise<boolean> {
  if (!campaignId || !recipientEmail) return false;
  const column = COLUMN[kind];
  try {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .update({ [column]: new Date().toISOString() })
      .in("campaign_type", Array.from(CAMPAIGN_TYPES))
      .eq("reference_id", campaignId)
      .eq("recipient_email", recipientEmail.trim().toLowerCase())
      .is(column, null)
      .select("id");
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Stamp the send-log row behind a cart-recovery reservation.
 *
 * The recovery pixel and click redirect are addressed by
 * `abandoned_cart_emails.id` — a reservation, minted before the message was
 * built, which is the only handle a link in that email can carry. The send log
 * is keyed on (campaign_type, reference_id) instead, so the reservation has to
 * be read to learn which cart and which stage it was. One extra read on a path
 * that is already doing a write, in exchange for cart recovery appearing in the
 * same table as every other kind of mail.
 */
export async function stampCartRecoveryEngagement(
  kind: EngagementKind,
  reservationId: string,
  options?: { userAgent?: string | null; source?: EngagementSource },
): Promise<boolean> {
  if (!reservationId) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from("abandoned_cart_emails")
      .select("abandoned_cart_id, stage")
      .eq("id", reservationId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { abandoned_cart_id?: string | null; stage?: string | null };
    if (!row.abandoned_cart_id || !row.stage) return false;
    const campaignType = `cart_recovery_${row.stage}`;
    // The event is kept whether or not this is the first touch: a second open
    // is still an open, and the classifier needs to see every fetch.
    await recordEngagementEvent({
      kind,
      source: options?.source ?? (kind === "opened" ? "pixel" : "click"),
      campaignType,
      referenceId: row.abandoned_cart_id,
      recipientEmail: null,
      userAgent: options?.userAgent ?? null,
    });
    return await stampSendLogEngagement({ kind, campaignType, referenceId: row.abandoned_cart_id });
  } catch {
    return false;
  }
}

/**
 * Mirror an engagement into the per-channel table that owns this kind of send.
 *
 * The campaign panel reads `email_campaign_recipients` and the cart-recovery
 * numbers read `abandoned_cart_emails`; both existed before the send log carried
 * engagement and both keep working unchanged. Without this, an open reported by
 * the provider rather than by our own pixel would appear in the new per-send
 * view and be missing from the panel next to it, which reads as a bug in
 * whichever one the operator happens to trust less.
 *
 * A campaign_type this does not recognise (an automation, a membership mail)
 * simply has no second home, and the send-log row is the whole record.
 */
export async function mirrorEngagementToChannel(input: {
  kind: EngagementKind;
  identity: SendLogIdentity;
  at?: string;
}): Promise<void> {
  const { campaignType, referenceId, recipientEmail } = input.identity;
  if (!referenceId) return;
  const column = COLUMN[input.kind];
  const at = input.at ?? new Date().toISOString();

  try {
    if (CAMPAIGN_TYPES.has(campaignType)) {
      if (!recipientEmail) return;
      await supabaseAdmin
        .from("email_campaign_recipients")
        .update({ [column]: at })
        .eq("campaign_id", referenceId)
        .eq("email", recipientEmail.trim().toLowerCase())
        .is(column, null);
      return;
    }
    if (campaignType.startsWith("cart_recovery_")) {
      const stage = campaignType.slice("cart_recovery_".length);
      if (!stage) return;
      await supabaseAdmin
        .from("abandoned_cart_emails")
        .update({ [column]: at })
        .eq("abandoned_cart_id", referenceId)
        .eq("stage", stage)
        .is(column, null);
    }
  } catch {
    // Best-effort by design: the send-log row is already stamped, and that is
    // the copy the per-send view reads.
  }
}
