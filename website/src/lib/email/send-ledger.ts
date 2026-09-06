import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * EVERY MESSAGE THE SYSTEM SENT, WHO GOT IT, AND WHAT THEY DID WITH IT.
 *
 * The reporting that existed answered "how did this campaign do" and "how is
 * this automation doing". Neither answers the question the owner actually
 * asked, which was simpler and had no home: *is this mail arriving, and is
 * anyone opening it?* Cart recovery — the largest single channel by volume —
 * appeared in no report at all, and auth mail (the signup confirmation, the
 * password reset: the two messages whose failure costs a customer outright)
 * appeared in none either.
 *
 * So this reads `email_send_log`, which has one row per send across every
 * channel, and joins the provider's delivery webhook to it.
 *
 * THE TWO JOINS, AND WHY ONE OF THEM IS WEAKER ON PURPOSE.
 *
 * Marketing sends record the provider's message id, and that is an exact join:
 * this row, that delivery. Auth mail does not — Supabase's GoTrue sends it, so
 * our code never sees the provider's response and has no id to record. The
 * provider still reports the delivery, keyed by address and time.
 *
 * Rather than show those 26 sends as permanently unknowable, a send with no id
 * is matched to a delivery event for the SAME ADDRESS inside a window around
 * its send time. That is an inference, not a fact — two messages to one address
 * in the same half hour could be matched to the wrong event — so it is carried
 * as `deliveryEvidence: "address"` and the panel says so. It is the difference
 * between "we cannot tell" and "almost certainly delivered, matched by
 * address", and for the mail that gates a new account, that difference is the
 * whole question.
 *
 * WHAT IS NOT TRACKED IS SAID, NOT SHOWN AS ZERO. An auth email carries no
 * pixel and never will — a tracking pixel in a password reset is a phishing
 * signature. Reporting it as "0 opens" alongside a campaign's opens is what
 * produced the belief that nothing had ever been opened; it reports as
 * untracked instead.
 */

/** Sends read for the panel. Bounded: this grows for ever and the page must not. */
const LEDGER_LIMIT = 500;

/**
 * How far around a send to look for a delivery event when there is no message
 * id to join on.
 *
 * Asymmetric on purpose. A provider accepts and delivers within seconds to
 * minutes, so the forward window is generous; the backward window exists only
 * to absorb clock skew between our `sent_at` and the provider's `received_at`,
 * and a wide one would let a PREVIOUS message's delivery be credited to this
 * send.
 */
const ADDRESS_MATCH_BEFORE_MS = 2 * 60 * 1000;
const ADDRESS_MATCH_AFTER_MS = 30 * 60 * 1000;

export type DeliveryEvidence = "message-id" | "address" | "none";

export type SendLedgerRow = {
  id: string;
  recipient: string;
  /** Human name for the kind of mail — "Cart recovery · 24 h", "Password reset". */
  channel: string;
  campaignType: string;
  sentAt: string | null;
  status: string;
  delivered: boolean;
  bounced: boolean;
  complained: boolean;
  deliveryEvidence: DeliveryEvidence;
  openedAt: string | null;
  clickedAt: string | null;
  /** False for mail that carries no open tracking at all, so a blank is not a zero. */
  openTracked: boolean;
};

export type SendLedgerChannel = {
  channel: string;
  sent: number;
  delivered: number;
  bounced: number;
  /** Sends whose delivery could be established either way. The denominator. */
  deliveryKnown: number;
  opened: number;
  clicked: number;
  /** Sends that carry open tracking. The denominator for `opened`. */
  openTracked: number;
  lastSentAt: string | null;
};

export type SendLedger = {
  rows: SendLedgerRow[];
  channels: SendLedgerChannel[];
  totals: {
    sent: number;
    delivered: number;
    deliveryKnown: number;
    bounced: number;
    opened: number;
    openTracked: number;
    clicked: number;
  };
  /** True when the read hit its ceiling and older sends are not shown. */
  truncated: boolean;
  /** Set when a read failed — the panel says so rather than showing zeroes. */
  error: string | null;
};

const CART_STAGE_LABELS: Record<string, string> = {
  t30m: "1 h",
  t12h: "12 h",
  t24h: "24 h",
  t72h: "72 h",
};

const FIXED_LABELS: Record<string, string> = {
  campaign: "Campaign",
  affiliate_campaign: "Affiliate broadcast",
  membership_welcome: "Membership welcome",
  "auth:signup_confirmation": "Signup confirmation",
  "auth:signup_confirmation_resend": "Signup confirmation (resent)",
  // GoTrue sent this one rather than our own mailer. Named, because a slug in
  // this column reads as a data problem rather than as a different sender.
  "auth:signup_confirmation_supabase_fallback": "Signup confirmation (Supabase)",
  "auth:password_reset": "Password reset",
  "auth:email_change": "Email change confirmation",
};

/** A readable name for a campaign_type, so the panel is not a list of slugs. */
export function describeSendChannel(campaignType: string): string {
  const type = String(campaignType ?? "");
  if (FIXED_LABELS[type]) return FIXED_LABELS[type];
  if (type.startsWith("cart_recovery_")) {
    const stage = type.slice("cart_recovery_".length);
    return `Cart recovery · ${CART_STAGE_LABELS[stage] ?? stage}`;
  }
  if (type.startsWith("automation:")) {
    const key = type.slice("automation:".length).replace(/_/g, " ");
    return `Automation · ${key}`;
  }
  if (type.startsWith("auth:")) return `Account mail · ${type.slice("auth:".length).replace(/_/g, " ")}`;
  return type ? type.replace(/_/g, " ") : "Unknown";
}

/**
 * Does this kind of mail carry open tracking?
 *
 * Auth mail deliberately does not, and the reason is worth keeping next to the
 * code: a remote image in a password reset is exactly the shape a phishing
 * filter scores against, and there is nothing to optimise in a message the
 * recipient asked for thirty seconds earlier. Everything else — campaigns,
 * automations, cart recovery — carries a first-party pixel, and once the
 * provider's open tracking is on it carries that too.
 */
export function channelHasOpenTracking(campaignType: string): boolean {
  return !String(campaignType ?? "").startsWith("auth:");
}

type DeliveryRow = { provider_message_id: string | null; recipient_email: string | null; kind: string; received_at: string };

/**
 * AN OPEN PROVES DELIVERY MORE STRONGLY THAN A DELIVERY RECEIPT DOES.
 *
 * A receipt says the receiving server accepted the message. An open says a
 * person's mail client fetched an image out of it, which cannot happen unless
 * it arrived AND landed somewhere they were looking. So an open or a click
 * counts as delivered here even when no `email.delivered` event was recorded —
 * without that, a campaign whose only event was an open reported "0 of 1
 * delivered" on the same row as "1 opened", which reads as a broken report and
 * is really just two events that were never reconciled.
 */
function classify(kinds: Iterable<string>): { delivered: boolean; bounced: boolean; complained: boolean } {
  let delivered = false;
  let bounced = false;
  let complained = false;
  for (const kind of kinds) {
    if (kind === "delivered" || kind === "opened" || kind === "clicked") delivered = true;
    else if (kind === "hard_bounce" || kind === "soft_bounce") bounced = true;
    else if (kind === "complaint") complained = true;
  }
  return { delivered, bounced, complained };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function emptySendLedger(error: string | null = null): SendLedger {
  return {
    rows: [],
    channels: [],
    totals: { sent: 0, delivered: 0, deliveryKnown: 0, bounced: 0, opened: 0, openTracked: 0, clicked: 0 },
    truncated: false,
    error,
  };
}

export async function loadSendLedger(limit: number = LEDGER_LIMIT): Promise<SendLedger> {
  type LogRow = {
    id: string;
    campaign_type: string | null;
    recipient_email: string | null;
    status: string | null;
    sent_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    provider_message_id: string | null;
  };

  let logs: LogRow[];
  try {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .select("id, campaign_type, recipient_email, status, sent_at, opened_at, clicked_at, provider_message_id")
      // A claim still at 'sending' is a send in flight, not a send. Failures are
      // kept: "it went out and bounced" and "it never went out" are different
      // answers to "did they get it", and both belong in a delivery report.
      .neq("status", "sending")
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(limit + 1);
    if (error) return emptySendLedger(error.message ?? "Could not read the send log.");
    logs = (data ?? []) as LogRow[];
  } catch (error) {
    return emptySendLedger(error instanceof Error ? error.message : "Could not read the send log.");
  }

  const truncated = logs.length > limit;
  if (truncated) logs = logs.slice(0, limit);

  // JOIN ONE: exact, by the provider's own message id.
  const messageIds = Array.from(new Set(logs.map((row) => row.provider_message_id).filter((id): id is string => Boolean(id))));
  const byMessageId = new Map<string, string[]>();
  for (const ids of chunk(messageIds, 200)) {
    const { data } = await supabaseAdmin
      .from("email_delivery_events")
      .select("provider_message_id, recipient_email, kind, received_at")
      .in("provider_message_id", ids);
    for (const row of (data ?? []) as DeliveryRow[]) {
      if (!row.provider_message_id) continue;
      const list = byMessageId.get(row.provider_message_id) ?? [];
      list.push(row.kind);
      byMessageId.set(row.provider_message_id, list);
    }
  }

  // JOIN TWO: by address and time, for the sends that carry no id — auth mail,
  // and anything sent before message-id capture landed on 2026-09-04.
  const unmatchedEmails = Array.from(new Set(
    logs.filter((row) => !row.provider_message_id).map((row) => (row.recipient_email ?? "").trim().toLowerCase()).filter(Boolean),
  ));
  const byAddress = new Map<string, Array<{ kind: string; at: number }>>();
  for (const emails of chunk(unmatchedEmails, 200)) {
    const { data } = await supabaseAdmin
      .from("email_delivery_events")
      .select("provider_message_id, recipient_email, kind, received_at")
      .in("recipient_email", emails);
    for (const row of (data ?? []) as DeliveryRow[]) {
      const email = (row.recipient_email ?? "").trim().toLowerCase();
      const at = Date.parse(row.received_at);
      if (!email || !Number.isFinite(at)) continue;
      const list = byAddress.get(email) ?? [];
      list.push({ kind: row.kind, at });
      byAddress.set(email, list);
    }
  }

  const rows: SendLedgerRow[] = logs.map((log) => {
    const campaignType = String(log.campaign_type ?? "");
    const recipient = (log.recipient_email ?? "").trim().toLowerCase();
    const sentAtMs = log.sent_at ? Date.parse(log.sent_at) : NaN;

    let evidence: DeliveryEvidence = "none";
    let kinds: string[] = [];
    if (log.provider_message_id && byMessageId.has(log.provider_message_id)) {
      evidence = "message-id";
      kinds = byMessageId.get(log.provider_message_id) ?? [];
    } else if (!log.provider_message_id && recipient && Number.isFinite(sentAtMs)) {
      const near = (byAddress.get(recipient) ?? []).filter(
        (event) => event.at >= sentAtMs - ADDRESS_MATCH_BEFORE_MS && event.at <= sentAtMs + ADDRESS_MATCH_AFTER_MS,
      );
      if (near.length > 0) {
        evidence = "address";
        kinds = near.map((event) => event.kind);
      }
    }

    const verdict = classify(kinds);
    return {
      id: String(log.id),
      recipient,
      channel: describeSendChannel(campaignType),
      campaignType,
      sentAt: log.sent_at,
      status: String(log.status ?? ""),
      delivered: verdict.delivered,
      bounced: verdict.bounced,
      complained: verdict.complained,
      deliveryEvidence: evidence,
      openedAt: log.opened_at,
      clickedAt: log.clicked_at,
      openTracked: channelHasOpenTracking(campaignType),
    };
  });

  const channels = new Map<string, SendLedgerChannel>();
  const totals = { sent: 0, delivered: 0, deliveryKnown: 0, bounced: 0, opened: 0, openTracked: 0, clicked: 0 };

  for (const row of rows) {
    const entry = channels.get(row.channel) ?? {
      channel: row.channel,
      sent: 0, delivered: 0, bounced: 0, deliveryKnown: 0, opened: 0, clicked: 0, openTracked: 0,
      lastSentAt: null as string | null,
    };
    // A failed send never reached the wire, so it counts in neither the delivery
    // denominator nor the open one — it is visible as its own row and nothing else.
    const attempted = row.status !== "failed";
    if (attempted) {
      entry.sent += 1;
      totals.sent += 1;
      if (row.deliveryEvidence !== "none") { entry.deliveryKnown += 1; totals.deliveryKnown += 1; }
      if (row.delivered) { entry.delivered += 1; totals.delivered += 1; }
      if (row.bounced) { entry.bounced += 1; totals.bounced += 1; }
      if (row.openTracked) { entry.openTracked += 1; totals.openTracked += 1; }
      if (row.openedAt) { entry.opened += 1; totals.opened += 1; }
      if (row.clickedAt) { entry.clicked += 1; totals.clicked += 1; }
      if (row.sentAt && (!entry.lastSentAt || row.sentAt > entry.lastSentAt)) entry.lastSentAt = row.sentAt;
    }
    channels.set(row.channel, entry);
  }

  return {
    rows,
    channels: Array.from(channels.values()).sort((a, b) => b.sent - a.sent || a.channel.localeCompare(b.channel)),
    totals,
    truncated,
    error: null,
  };
}
