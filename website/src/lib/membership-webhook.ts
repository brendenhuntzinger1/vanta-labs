import "server-only";

// Membership lifecycle webhooks from Veyra.
//
// WHY THIS EXISTS. Veyra bills renewals on its own cron. Before this handler,
// those events arrived and were silently dropped: `getOrderStatusForEventType`
// mapped them to "pending_payment", `isRecognisedMoneyEvent` returned false, and
// the webhook returned early. Nothing was corrupted — but nothing was recorded
// either. So on a renewal:
//
//   • no membership_billing_events row → the member's billing history is a lie
//   • next_billing_at never advanced → still points at the date just charged
//   • isMembershipActive's grace window lapses ~3 days later
//
// …and the member loses every perk while Veyra keeps charging their card, every
// month, silently. A 30-day fuse on any membership created through the Veyra
// lane.
//
// EVENT NAMES ARE READ FROM VEYRA'S SOURCE, NOT GUESSED. They are
// `membership.*` — NOT `subscription.*` / `invoice.*`, which is the natural
// assumption and is wrong. See veyragate `lib/membership/events-pure.ts`.
//
// WIRE SHAPE GOTCHA: the membership id arrives as `membership_id`, NOT `id`.
// Veyra remaps it precisely so it cannot collide with the webhook envelope's own
// event `id` (which must stay unique per delivery for merchant idempotency).
// Reading `data.id` here would silently match nothing and every event would
// no-op — the same failure mode this handler exists to fix.
//
// Idempotency is NOT handled here: the caller claims the event id first via
// payment_events, which is the same exactly-once path the order webhooks use.

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordMembershipChargeOrder } from "@/lib/membership-orders";
import { getAuthUserContact, sendMembershipEmail, sendMembershipReceiptOnce } from "@/lib/membership-billing";
import { membershipPaymentFailedTemplate, membershipRenewalReceiptTemplate } from "@/lib/email/templates";
import { formatDisplayDate } from "@/lib/format-date";
import { getSiteUrl } from "@/lib/env";
import { recordSystemAlert } from "@/lib/monitoring";

export const MEMBERSHIP_EVENT_TYPES = new Set([
  "membership.created",
  "membership.renewed",
  "membership.payment_failed",
  "membership.canceled",
  "membership.card_updated",
]);

export function isMembershipEvent(eventType: string | null | undefined): boolean {
  return MEMBERSHIP_EVENT_TYPES.has((eventType ?? "").trim());
}

/** The customer-safe projection Veyra sends. No card/token/provider fields exist here. */
export interface MembershipEventData {
  membership_id?: string | null;
  status?: string | null;
  plan_code?: string | null;
  amount_cents?: number | null;
  amount_charged_cents?: number | null;
  currency?: string | null;
  interval?: string | null;
  current_period_end?: string | null;
  next_renewal_at?: string | null;
  cancel_at_period_end?: boolean | null;
  customer_email?: string | null;
  dunning_attempts?: number | null;
  next_retry_at?: string | null;
  cancellation_reason?: string | null;
}

export interface MembershipWebhookResult {
  handled: boolean;
  reason?: string;
  membershipId?: string;
  userId?: string;
}

interface LocalMembershipRow {
  user_id: string;
  tier_id: string | null;
  status: string | null;
  // Carried so the renewal ORDER can say which cycle was billed. Reading it
  // from the event would be wrong: Veyra sends the plan's interval, and the
  // local row is what every other membership surface reports from.
  billing_cycle: string | null;
  // The end of the period already paid for, used when a cancel event carries
  // cancel_at_period_end but no date of its own.
  next_billing_at: string | null;
  /** An upgrade waiting for the renewal that pays for it (membership-billing.ts). */
  pending_tier_id?: string | null;
}

async function findLocalMembership(veyraMembershipId: string): Promise<LocalMembershipRow | null> {
  const { data, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, pending_tier_id")
    .eq("veyra_membership_id", veyraMembershipId)
    .maybeSingle();
  if (error) throw error;
  return (data as LocalMembershipRow | null) ?? null;
}

async function recordEvent(input: {
  userId: string;
  tierId: string | null;
  eventType: string;
  amountCents: number;
  status: "succeeded" | "failed";
  providerChargeId?: string | null;
  failureReason?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("membership_billing_events").insert({
    user_id: input.userId,
    tier_id: input.tierId,
    event_type: input.eventType,
    amount_cents: input.amountCents,
    status: input.status,
    provider_charge_id: input.providerChargeId ?? null,
    failure_reason: input.failureReason ?? null,
    created_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/**
 * Apply a Veyra membership event to local state.
 *
 * Returns `handled: false` (never throws) when the event refers to a membership
 * this store does not know about — a different storefront on the same merchant,
 * or a membership created before this lane existed. Throwing there would make
 * Veyra retry forever on an event that can never apply.
 */
export async function handleMembershipEvent(
  eventType: string,
  data: MembershipEventData,
): Promise<MembershipWebhookResult> {
  // `membership_id`, not `id` — see the wire-shape note in the header.
  const veyraMembershipId = (data.membership_id ?? "").trim();
  if (!veyraMembershipId) {
    return { handled: false, reason: "no_membership_id" };
  }

  // membership.created is applied synchronously at signup (we hold the id
  // returned by the API call). Re-applying it from a webhook would only risk
  // clobbering fresher local state, so acknowledge and do nothing.
  if (eventType === "membership.created" || eventType === "membership.card_updated") {
    return { handled: true, reason: "no_local_change_required", membershipId: veyraMembershipId };
  }

  const local = await findLocalMembership(veyraMembershipId);
  if (!local) {
    return { handled: false, reason: "membership_not_found_locally", membershipId: veyraMembershipId };
  }

  const nowIso = new Date().toISOString();

  if (eventType === "membership.renewed") {
    // The charge that actually happened. `amount_cents` is the LIST price;
    // `amount_charged_cents` is what was captured after any discount. Recording
    // the list price would overstate revenue on every discounted renewal.
    const chargedCents = data.amount_charged_cents ?? data.amount_cents ?? 0;

    const patch: Record<string, unknown> = {
      status: "active",
      updated_at: nowIso,
      // Let the next cycle's reminder send again.
      renewal_reminder_sent_at: null,
    };
    // Advance the schedule from VEYRA's date, not a locally computed +30d — Veyra
    // owns the schedule and a local guess drifts from what the card will actually
    // be charged on.
    if (data.next_renewal_at) {
      patch.next_billing_at = data.next_renewal_at;
      patch.renews_at = data.next_renewal_at;
    }
    if (typeof data.cancel_at_period_end === "boolean") {
      patch.cancel_at_period_end = data.cancel_at_period_end;
    }

    // THE RENEWAL IS THE MOMENT AN UPGRADE IS PAID FOR. A monthly upgrade was
    // repriced at Veyra and parked in pending_tier_id (membership-billing.ts);
    // this charge is the first at the new price, so the member moves onto the
    // tier now — never before.
    const appliedTierId = local.pending_tier_id ?? local.tier_id;
    if (local.pending_tier_id) {
      patch.tier_id = local.pending_tier_id;
      patch.pending_tier_id = null;
      patch.pending_tier_effective_at = null;
    }
    const { error } = await supabaseAdmin
      .from("customer_memberships")
      .update(patch)
      .eq("veyra_membership_id", veyraMembershipId);
    if (error) throw error;

    await recordEvent({
      userId: local.user_id,
      tierId: appliedTierId,
      eventType: "renewal",
      amountCents: chargedCents,
      status: "succeeded",
      providerChargeId: veyraMembershipId,
    });

    // THE MONEY, WHERE THE REPORTS LOOK FOR IT (VL-29). The billing event above
    // is read by one admin screen; every revenue surface reads `orders`.
    //
    // Keyed to the PERIOD, not the delivery: `next_renewal_at` is what Veyra
    // says this charge bought, so a redelivery of the same renewal collapses
    // onto the same order and next month's renewal is still its own. It falls
    // back to the period just ended, then to the day, because an event missing
    // both dates must still be recorded rather than dropped.
    //
    // THIS ASSUMES VEYRA DOES NOT SEND membership.renewed FOR THE FIRST INVOICE.
    // The signup charge is booked by startMembershipSignup under a
    // `membership-signup:<subscription>` key, and the two key namespaces cannot
    // collide by construction — so a `renewed` event covering the period the
    // signup already paid for would book a SECOND order for ONE charge. The
    // event vocabulary this handler was written from says the signup event is
    // `membership.created`, which is a no-op above, and no first-invoice
    // `renewed` has ever been observed in production. If one ever is, note that
    // the duplicate would already be visible one layer earlier, as two
    // "renewal" rows in membership_billing_events for a single charge — that is
    // the cheaper thing to watch, and it predates this order write.
    const renewalPeriodKey =
      (data.next_renewal_at ?? data.current_period_end ?? nowIso.slice(0, 10)) || nowIso.slice(0, 10);
    const renewalOrder = await recordMembershipChargeOrder({
      userId: local.user_id,
      tierId: appliedTierId,
      billingCycle: local.billing_cycle,
      amountCents: chargedCents,
      kind: "renewal",
      paymentId: `membership-renewal:${veyraMembershipId}:${renewalPeriodKey}`,
      paidAt: nowIso,
    });

    // THE RECEIPT FOR MONEY THAT HAS ALREADY LEFT THEIR ACCOUNT.
    //
    // This lane charged the card, booked a real paid order, and sent nothing —
    // the module did not import an email helper at all. The sweep lane in
    // membership-billing.ts calls the identical recordMembershipChargeOrder and
    // then sends membershipRenewalReceiptTemplate, and this IS the live billing
    // path for a Veyra-billed membership. So a member was charged every month,
    // in silence, with no receipt to reconcile against their statement.
    //
    // Never allowed to fail the webhook: the charge is already recorded, and
    // returning an error here would have Veyra retry an event we handled.
    //
    // Once per renewal ORDER: the order is period-keyed, so a redelivery of the
    // same renewal resolves to the same order and the same, already-taken
    // send-once slot — the receipt cannot go out twice for one charge.
    try {
      const contact = await getAuthUserContact(local.user_id);
      if (contact) {
        await sendMembershipReceiptOnce({
          orderId: renewalOrder.orderId ?? null,
          kind: "membership_renewal_receipt",
          to: contact.email,
          template: membershipRenewalReceiptTemplate({
            name: contact.name,
            monthlyPriceCents: chargedCents,
            nextBillingDate: formatDisplayDate(data.next_renewal_at ?? data.current_period_end ?? null, "long") ?? "",
          }),
        });
      }
    } catch (receiptError) {
      console.error("[membership-webhook] renewal receipt failed", receiptError);
    }

    return { handled: true, membershipId: veyraMembershipId, userId: local.user_id };
  }

  if (eventType === "membership.payment_failed") {
    // Veyra runs its own dunning and will retry. Mark past_due so perks stop,
    // but do NOT cancel — a later retry can still succeed and a cancel here
    // would end a membership the customer never asked to end.
    const { error } = await supabaseAdmin
      .from("customer_memberships")
      .update({ status: "past_due", updated_at: nowIso })
      .eq("veyra_membership_id", veyraMembershipId);
    if (error) throw error;

    await recordEvent({
      userId: local.user_id,
      tierId: local.tier_id,
      eventType: "payment_failed",
      amountCents: data.amount_charged_cents ?? data.amount_cents ?? 0,
      status: "failed",
      failureReason:
        data.dunning_attempts != null
          ? `Veyra dunning attempt ${data.dunning_attempts}`
          : "Renewal charge failed at the payment provider",
    });

    // THE OPERATOR HEARS ABOUT IT. This lane marked the member past_due, told
    // the member, and told nobody else: a renewal failure was a row on one
    // admin screen. Warning, not critical — Veyra's dunning is the retry, and
    // a declined card is the member's to fix — but on file and in Sentry so a
    // run of failures reads as a run. No local retry: the processor owns it.
    await recordSystemAlert({
      type: "membership_charge_failed",
      severity: "warning",
      message:
        `Processor renewal charge of ${((data.amount_charged_cents ?? data.amount_cents ?? 0) / 100).toFixed(2)} USD failed for user ${local.user_id}`
        + (data.dunning_attempts != null ? ` (dunning attempt ${data.dunning_attempts}` + (data.next_retry_at ? `, next retry ${data.next_retry_at}` : "") + ")" : "")
        + " — the member is past_due until the processor's retry succeeds.",
      context: {
        userId: local.user_id,
        tierId: local.tier_id,
        veyraMembershipId,
        amountCents: data.amount_charged_cents ?? data.amount_cents ?? 0,
        dunningAttempts: data.dunning_attempts ?? null,
        nextRetryAt: data.next_retry_at ?? null,
        lane: "veyra",
      },
    }).catch(() => {});

    // Perks have just stopped. Say so, and say how to fix it.
    //
    // This branch set past_due and told nobody, so the member lost their
    // benefits with no notice and no idea why — while Veyra's dunning quietly
    // retried a card that needs their attention. The sweep lane's
    // handleChargeFailure has always sent this exact message.
    try {
      const contact = await getAuthUserContact(local.user_id);
      if (contact) {
        await sendMembershipEmail(
          contact.email,
          membershipPaymentFailedTemplate({
            name: contact.name,
            amountCents: data.amount_charged_cents ?? data.amount_cents ?? 0,
            updatePaymentUrl: `${getSiteUrl().replace(/\/+$/, "")}/account`,
          }),
          "payment failed notice",
        );
      }
    } catch (noticeError) {
      console.error("[membership-webhook] payment-failed notice failed", noticeError);
    }

    return { handled: true, membershipId: veyraMembershipId, userId: local.user_id };
  }

  if (eventType === "membership.canceled") {
    // WINDING DOWN OR TERMINAL — the event says which, and they are not the
    // same thing. Our own cancelMembership asks Veyra for `cancel at_period_end`
    // and keeps the row active until the paid period runs out; if Veyra echoes
    // that request back as membership.canceled with cancel_at_period_end=true
    // and a period end still ahead, treating it as terminal flipped the row to
    // cancelled on the spot and stripped perks the member had paid for — the
    // opposite of what the cancel confirmation had just promised them. So a
    // period-end cancel with time left is recorded the way the app already
    // represents one (cancel_at_period_end, status untouched), and only a
    // cancel whose period has ended — or an immediate one — ends access now.
    const periodEndRaw = data.current_period_end ?? data.next_renewal_at ?? local.next_billing_at ?? null;
    const periodEndMs = periodEndRaw ? new Date(periodEndRaw).getTime() : Number.NaN;
    const windingDown =
      data.cancel_at_period_end === true && Number.isFinite(periodEndMs) && periodEndMs > Date.now();

    const patch: Record<string, unknown> = windingDown
      ? {
          cancel_at_period_end: true,
          updated_at: nowIso,
          // Veyra's date for the end of the paid period is the authority on
          // when access stops; adopt it so the account page and the expiry
          // guard agree with the processor.
          ...(data.current_period_end ? { next_billing_at: data.current_period_end, renews_at: data.current_period_end } : {}),
        }
      : {
          status: "cancelled",
          cancel_at_period_end: true,
          cancelled_at: nowIso,
          updated_at: nowIso,
        };

    const { error } = await supabaseAdmin
      .from("customer_memberships")
      .update(patch)
      .eq("veyra_membership_id", veyraMembershipId);
    if (error) throw error;

    await recordEvent({
      userId: local.user_id,
      tierId: local.tier_id,
      eventType: "cancel",
      amountCents: 0,
      status: "succeeded",
      failureReason: windingDown
        ? `Ends at period end${data.cancellation_reason ? `: ${data.cancellation_reason}` : ""}`
        : (data.cancellation_reason ?? null),
    });

    return { handled: true, membershipId: veyraMembershipId, userId: local.user_id };
  }

  return { handled: false, reason: "unhandled_membership_event" };
}
