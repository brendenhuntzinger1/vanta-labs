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
import { getAuthUserContact, sendMembershipEmail } from "@/lib/membership-billing";
import { membershipPaymentFailedTemplate, membershipRenewalReceiptTemplate } from "@/lib/email/templates";
import { formatDisplayDate } from "@/lib/format-date";
import { getSiteUrl } from "@/lib/env";

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
}

async function findLocalMembership(veyraMembershipId: string): Promise<LocalMembershipRow | null> {
  const { data, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle")
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

    const { error } = await supabaseAdmin
      .from("customer_memberships")
      .update(patch)
      .eq("veyra_membership_id", veyraMembershipId);
    if (error) throw error;

    await recordEvent({
      userId: local.user_id,
      tierId: local.tier_id,
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
    await recordMembershipChargeOrder({
      userId: local.user_id,
      tierId: local.tier_id,
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
    try {
      const contact = await getAuthUserContact(local.user_id);
      if (contact) {
        await sendMembershipEmail(
          contact.email,
          membershipRenewalReceiptTemplate({
            name: contact.name,
            monthlyPriceCents: chargedCents,
            nextBillingDate: formatDisplayDate(data.next_renewal_at ?? data.current_period_end ?? null, "long") ?? "",
          }),
          "renewal receipt",
        );
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
    // Terminal. Mirrors a cancel initiated at Veyra (admin action, dunning
    // exhaustion, or our own cancel call echoing back) so the two sides agree.
    const { error } = await supabaseAdmin
      .from("customer_memberships")
      .update({
        status: "cancelled",
        cancel_at_period_end: true,
        cancelled_at: nowIso,
        updated_at: nowIso,
      })
      .eq("veyra_membership_id", veyraMembershipId);
    if (error) throw error;

    await recordEvent({
      userId: local.user_id,
      tierId: local.tier_id,
      eventType: "cancel",
      amountCents: 0,
      status: "succeeded",
      failureReason: data.cancellation_reason ?? null,
    });

    return { handled: true, membershipId: veyraMembershipId, userId: local.user_id };
  }

  return { handled: false, reason: "unhandled_membership_event" };
}
