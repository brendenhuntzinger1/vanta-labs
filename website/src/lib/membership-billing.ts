import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getBillingProvider, type ChargeCardResult } from "@/lib/billing-provider";
import {
  startVeyraMembership,
  cancelVeyraMembership,
  skipVeyraMembershipCycle,
  updateVeyraMembershipCard,
  changeVeyraMembershipPlan,
} from "@/lib/veyra-membership";
import { getPaymentProvider, isCheckoutOpen } from "@/lib/payment-provider";
import { computeTierChangeBilling, decideMembershipAttempt, guardDuplicateMembershipPurchase, membershipTermPlan } from "@/lib/membership-billing-math";
import { recordMembershipChargeOrder } from "@/lib/membership-orders";
import { PAID_EVENT_TYPES, skipUsedThisPaidPeriod } from "@/lib/membership-status";
import { currentPeriodMonth, grantMonthlyStoreCredit, reconcileMonthlyStoreCredit } from "@/lib/store-credit";
import { sendEmail } from "@/lib/email/send";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { getSiteUrl } from "@/lib/env";
import { recordSystemAlert } from "@/lib/monitoring";
import { formatDisplayDate } from "@/lib/format-date";
import {
  membershipWelcomeTemplate,
  membershipSignupReceiptTemplate,
  membershipRemainderReminderTemplate,
  membershipRemainderReceiptTemplate,
  membershipRenewalReminderTemplate,
  membershipRenewalReceiptTemplate,
  membershipPaymentFailedTemplate,
  membershipWinBackTemplate,
} from "@/lib/email/templates";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface TierRow {
  id: string;
  slug: string;
  name: string;
  monthly_price_cents: number;
  annual_price_cents: number;
  intro_price_cents: number;
  intro_duration_days: number;
  intro_offer_enabled: boolean;
  monthly_store_credit_cents?: number;
}

async function getTierById(tierId: string): Promise<TierRow | null> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("id, slug, name, monthly_price_cents, annual_price_cents, intro_price_cents, intro_duration_days, intro_offer_enabled, monthly_store_credit_cents")
    .eq("id", tierId)
    .maybeSingle();

  if (error) throw error;
  return data as TierRow | null;
}

async function getAuthUserContact(userId: string): Promise<{ email: string; name: string } | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) {
    return null;
  }

  const fullName = typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name : "";
  return { email: data.user.email, name: fullName || data.user.email.split("@")[0] };
}

/**
 * Has this account ever completed a real membership charge?
 *
 * Asks for a PAID event specifically — see PAID_EVENT_TYPES in
 * membership-status.ts for why "has a succeeded billing event" is not the same
 * question and will wrongly clear an account that only ever cancelled.
 */
export async function hasSuccessfulPayment(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("membership_billing_events")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "succeeded")
    .gt("amount_cents", 0)
    .in("event_type", PAID_EVENT_TYPES as unknown as string[])
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function recordBillingEvent(input: {
  userId: string;
  tierId?: string | null;
  eventType: string;
  amountCents: number;
  status: "succeeded" | "failed";
  providerChargeId?: string | null;
  failureReason?: string | null;
}) {
  const { error } = await supabaseAdmin.from("membership_billing_events").insert({
    user_id: input.userId,
    tier_id: input.tierId ?? null,
    event_type: input.eventType,
    amount_cents: input.amountCents,
    status: input.status,
    provider_charge_id: input.providerChargeId ?? null,
    failure_reason: input.failureReason ?? null,
    created_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function handleChargeFailure(input: { userId: string; tier: TierRow; amountCents: number; eventType: string; error?: string }) {
  await recordBillingEvent({
    userId: input.userId,
    tierId: input.tier.id,
    eventType: input.eventType,
    amountCents: input.amountCents,
    status: "failed",
    failureReason: input.error ?? null,
  });

  await supabaseAdmin
    .from("customer_memberships")
    .update({ status: "past_due", updated_at: new Date().toISOString() })
    .eq("user_id", input.userId);

  const contact = await getAuthUserContact(input.userId);
  if (contact) {
    await sendEmail({
      to: contact.email,
      ...membershipPaymentFailedTemplate({
        name: contact.name,
        amountCents: input.amountCents,
        updatePaymentUrl: `${getSiteUrl()}/account`,
      }),
    });
  }

  // A distinct "we attempted recovery" event, separate from the raw charge
  // failure above - see admin-membership.ts's getMembershipAnalytics for
  // how failedPaymentsCount vs recoveryAttemptsCount are told apart.
  await recordBillingEvent({
    userId: input.userId,
    tierId: input.tier.id,
    eventType: "payment_failed",
    amountCents: input.amountCents,
    status: "failed",
    failureReason: input.error ?? null,
  });
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

// Creates a one-time ORDER for an ANNUAL membership paid via a manual method
// (Cash App / Zelle / PayPal). It flows through the same manual-payment panel
// and admin Payment Verification dashboard as product orders; on approval,
// finalizeManualPayment activates the membership. No card, no fee, non-refundable.
export async function createAnnualMembershipManualOrder(input: {
  userId: string;
  tierId: string;
  paymentMethod: string;
}): Promise<{ orderId: string; orderNumber: string; amount: number }> {
  const tier = await getTierById(input.tierId);
  if (!tier) {
    throw new Error("Membership tier not found");
  }

  const amount = roundMoney((tier.annual_price_cents ?? 0) / 100);
  if (amount <= 0) {
    throw new Error("This membership has no annual price set.");
  }

  const contact = await getAuthUserContact(input.userId);
  if (!contact) {
    throw new Error("Unable to load your account details.");
  }

  const orderId = `order-${randomUUID()}`;
  const orderNumber = `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin.from("orders").insert({
    order_id: orderId,
    order_number: orderNumber,
    order_type: "membership",
    membership_tier_id: tier.id,
    membership_cycle: "annual",
    payment_method: input.paymentMethod,
    customer_email: contact.email,
    customer_name: contact.name,
    currency: "USD",
    subtotal: amount,
    shipping_amount: 0,
    handling_fee: 0,
    tax_amount: 0,
    discount_amount: 0,
    amount_paid: amount,
    customer_user_id: input.userId,
    payment_status: "pending_payment",
    fulfillment_status: "pending",
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;

  await supabaseAdmin.from("order_items").insert({
    order_id: orderId,
    product_id: `membership:${tier.slug ?? tier.id}`,
    product_name: `Annual Membership — ${tier.name}`,
    unit_price: amount,
    quantity: 1,
    line_total: amount,
  });

  return { orderId, orderNumber, amount };
}

// Activates an annual membership after its manual payment is approved. It's a
// one-year, non-refundable pass paid off-platform, so it does NOT auto-renew
// (no card on file) — it simply lapses at the end of the paid year, and perks
// are active for the whole term.
export async function activateAnnualMembership(userId: string, tierId: string) {
  const tier = await getTierById(tierId);
  // The customer PAID for this tier. Returning quietly because it cannot be
  // resolved leaves them charged with no membership and no alert — the caller
  // treats a silent return as success.
  if (!tier) throw new Error(`Membership tier ${tierId} not found; annual membership not activated.`);

  const now = new Date();
  const nextBillingAt = new Date(now.getTime() + 365 * ONE_DAY_MS);

  // THE MEMBERSHIP WRITE IS THE EFFECT. Its error was discarded, so this
  // function returned normally with no membership row written and
  // unsafe_effect_failed_membership_activation could never fire for it — the
  // alert only ever covered the receipt emails that follow.
  const { error: activationError } = await supabaseAdmin.from("customer_memberships").upsert({
    user_id: userId,
    tier_id: tier.id,
    billing_cycle: "annual",
    status: "active",
    started_at: now.toISOString(),
    renews_at: nextBillingAt.toISOString(),
    intro_status: "not_applicable",
    next_billing_at: nextBillingAt.toISOString(),
    next_billing_amount_cents: 0,
    // Annual is a one-year non-renewing pass, so it is "ending" by design.
    cancel_at_period_end: true,
    // A rejoin must not inherit the previous cancellation's timestamp — the row
    // would read active with a cancelled_at date, and every UI that treats
    // cancelled_at as "this membership was cancelled" shows a stale banner.
    cancelled_at: null,
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });

  if (activationError) throw activationError;

  await recordBillingEvent({ userId, tierId: tier.id, eventType: "renewal", amountCents: tier.annual_price_cents ?? 0, status: "succeeded" });

  const contact = await getAuthUserContact(userId);
  if (contact) {
    await sendMarketingEmail({
      to: contact.email,
      campaignType: "membership_welcome",
      referenceId: userId,
      templateKey: "membershipWelcomeTemplate",
      ...membershipWelcomeTemplate({ name: contact.name, tierName: tier.name }),
    });

    // Transactional receipt for the real charge (always sent).
    await sendEmail({
      to: contact.email,
      ...membershipSignupReceiptTemplate({
        name: contact.name,
        tierName: tier.name,
        amountCents: tier.annual_price_cents ?? 0,
        billingCycle: "annual",
        nextBillingDate: formatDisplayDate(nextBillingAt, "long") ?? "",
        autoRenews: false,
      }),
    });
  }
}

// Activates a MONTHLY membership after its first payment clears. Benefits turn
// on immediately and the next charge is scheduled ~30 days out; the billing
// sweep renews it once a recurring billing provider is connected (until then a
// renewal attempt fails honestly and the member goes past-due).
export async function activateMonthlyMembership(userId: string, tierId: string) {
  const tier = await getTierById(tierId);
  // See activateAnnualMembership: a paid membership that cannot be activated is
  // an operator's problem, not a silent no-op.
  if (!tier) throw new Error(`Membership tier ${tierId} not found; monthly membership not activated.`);

  const now = new Date();
  const nextBillingAt = new Date(now.getTime() + 30 * ONE_DAY_MS);

  // THE MEMBERSHIP WRITE IS THE EFFECT. Its error was discarded, so this
  // function returned normally with no membership row written and
  // unsafe_effect_failed_membership_activation could never fire for it — the
  // alert only ever covered the receipt emails that follow.
  const { error: activationError } = await supabaseAdmin.from("customer_memberships").upsert({
    user_id: userId,
    tier_id: tier.id,
    billing_cycle: "monthly",
    status: "active",
    started_at: now.toISOString(),
    renews_at: nextBillingAt.toISOString(),
    intro_status: "not_applicable",
    next_billing_at: nextBillingAt.toISOString(),
    next_billing_amount_cents: tier.monthly_price_cents ?? 0,
    // Paying REVIVES the membership: clear any prior cancel-at-period-end and
    // its timestamp. Without this a member who cancelled and then re-subscribed
    // stayed flagged "ending", so the account page said "set to cancel at the
    // end of your period" and admin read "active · ending" — moments after a
    // successful charge.
    cancel_at_period_end: false,
    cancelled_at: null,
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });

  if (activationError) throw activationError;

  await recordBillingEvent({ userId, tierId: tier.id, eventType: "renewal", amountCents: tier.monthly_price_cents ?? 0, status: "succeeded" });

  const contact = await getAuthUserContact(userId);
  if (contact) {
    await sendMarketingEmail({
      to: contact.email,
      campaignType: "membership_welcome",
      referenceId: userId,
      templateKey: "membershipWelcomeTemplate",
      ...membershipWelcomeTemplate({ name: contact.name, tierName: tier.name }),
    });

    await sendEmail({
      to: contact.email,
      ...membershipSignupReceiptTemplate({
        name: contact.name,
        tierName: tier.name,
        amountCents: tier.monthly_price_cents ?? 0,
        billingCycle: "monthly",
        nextBillingDate: formatDisplayDate(nextBillingAt, "long") ?? "",
        autoRenews: true,
      }),
    });
  }
}

// Turns on a membership after its order is PAID (card webhook or manual
// approval), picking the right cycle. This is the single activation entry point
// used by the payment paths.
export async function activatePaidMembership(userId: string, tierId: string, billingCycle: "monthly" | "annual") {
  if (billingCycle === "monthly") {
    await activateMonthlyMembership(userId, tierId);
  } else {
    await activateAnnualMembership(userId, tierId);
  }
}

// Creates a membership ORDER and a live checkout session for it, so the customer
// pays through the same processor as any product order. On payment the webhook
// flips the order paid and activates the membership + perks (see
// payment-webhook.ts). Returns the hosted checkout URL to redirect the buyer to.
export async function createMembershipCheckoutSession(input: {
  userId: string;
  tierId: string;
  billingCycle: "monthly" | "annual";
}): Promise<{ orderId: string; orderNumber: string; hostedCheckoutUrl: string }> {
  if (!isCheckoutOpen()) {
    throw new Error("Checkout isn't open yet — card payments aren't connected. Contact support to activate your membership.");
  }

  const tier = await getTierById(input.tierId);
  if (!tier) {
    throw new Error("Membership tier not found");
  }

  // NEVER CHARGE TWICE FOR THE SAME MEMBERSHIP. startMembershipSignup no-ops
  // when the buyer is already active on this tier; this hosted-checkout lane had
  // no equivalent guard, so an active member who reached the subscribe page
  // again was sent to a live checkout and charged for a plan they already hold.
  // A different tier is a legitimate plan change and still goes through.
  // A DUPLICATE-CHARGE GUARD THAT CANNOT READ MUST NOT SAY "NO MEMBERSHIP".
  // Discarding this error sent an already-active member to a live checkout and
  // charged them again for a plan they hold.
  const { data: existingMembership, error: existingMembershipError } = await supabaseAdmin
    .from("customer_memberships")
    .select("status, tier_id, cancel_at_period_end, veyra_membership_id, membership_tiers(name)")
    .eq("user_id", input.userId)
    .maybeSingle();

  if (existingMembershipError) throw existingMembershipError;

  const existingTier = existingMembership?.membership_tiers as unknown as { name?: string } | null;
  const purchaseDecision = guardDuplicateMembershipPurchase(
    existingMembership
      ? {
          status: String(existingMembership.status ?? ""),
          tierId: String(existingMembership.tier_id ?? ""),
          tierName: existingTier?.name ? String(existingTier.name) : undefined,
          cancelAtPeriodEnd: Boolean(existingMembership.cancel_at_period_end),
          hasProcessorSubscription: Boolean(existingMembership.veyra_membership_id),
        }
      : null,
    tier.id,
  );
  if (!purchaseDecision.allowed) {
    throw new Error(purchaseDecision.reason);
  }

  const amountCents = input.billingCycle === "annual"
    ? Number(tier.annual_price_cents ?? 0)
    : Number(tier.monthly_price_cents ?? 0);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error(`This membership has no ${input.billingCycle} price set.`);
  }
  const amount = roundMoney(amountCents / 100);

  const contact = await getAuthUserContact(input.userId);
  if (!contact) {
    throw new Error("Unable to load your account details.");
  }

  const now = new Date().toISOString();

  // IDEMPOTENCY. This used to mint a fresh order row on every call, so a double
  // click, a back-and-retry, or a refresh of the subscribe page left one
  // "awaiting payment" order behind per attempt — four signup attempts on the
  // first test account produced four orders. Reuse the buyer's existing OPEN
  // attempt for the same tier and cycle instead.
  //
  // No time window: a stale open attempt is reused rather than blocked, which
  // is why this is app-level reuse and not a unique index — an index would hard
  // fail a legitimate retry once an abandoned row lingered.
  const { data: openAttempt, error: lookupError } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, amount_paid")
    .eq("customer_user_id", input.userId)
    .eq("order_type", "membership")
    .eq("membership_tier_id", tier.id)
    .eq("membership_cycle", input.billingCycle)
    .eq("payment_status", "pending_payment")
    .is("paid_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) throw lookupError;

  // Reuse only at the same price. If the tier has been repriced since the
  // abandoned attempt, retire that row and open a fresh one so the buyer is
  // never sent to a checkout for a stale amount.
  const decision = decideMembershipAttempt(
    openAttempt
      ? {
          orderId: String(openAttempt.order_id),
          orderNumber: String(openAttempt.order_number),
          amountPaid: Number(openAttempt.amount_paid ?? 0),
        }
      : null,
    amount,
  );

  let orderId: string;
  let orderNumber: string;

  if (decision.action === "reuse") {
    orderId = decision.orderId;
    orderNumber = decision.orderNumber;
    await supabaseAdmin.from("orders").update({ updated_at: now }).eq("order_id", orderId);
  } else {
    if (decision.action === "replace") {
      await supabaseAdmin
        .from("orders")
        .update({ payment_status: "canceled", updated_at: now })
        .eq("order_id", decision.retireOrderId);
    }

    orderId = `order-${randomUUID()}`;
    orderNumber = `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

    const { error } = await supabaseAdmin.from("orders").insert({
      order_id: orderId,
      order_number: orderNumber,
      order_type: "membership",
      membership_tier_id: tier.id,
      membership_cycle: input.billingCycle,
      payment_method: "card",
      customer_email: contact.email,
      customer_name: contact.name,
      currency: "USD",
      subtotal: amount,
      shipping_amount: 0,
      handling_fee: 0,
      tax_amount: 0,
      discount_amount: 0,
      amount_paid: amount,
      customer_user_id: input.userId,
      payment_status: "pending_payment",
      fulfillment_status: "pending",
      created_at: now,
      updated_at: now,
    });
    if (error) throw error;

    await supabaseAdmin.from("order_items").insert({
      order_id: orderId,
      product_id: `membership:${tier.slug ?? tier.id}`,
      product_name: `${input.billingCycle === "annual" ? "Annual" : "Monthly"} Membership — ${tier.name}`,
      unit_price: amount,
      quantity: 1,
      line_total: amount,
    });
  }

  const provider = getPaymentProvider();
  const session = await provider.createCheckoutSession({
    orderId,
    amount: amountCents, // minor units, as LivePaymentProvider expects
    currency: "USD",
    customerEmail: contact.email,
    metadata: { orderNumber },
  });

  return { orderId, orderNumber, hostedCheckoutUrl: session.hostedCheckoutUrl };
}

export interface StartMembershipSignupInput {
  userId: string;
  tierId: string;
  billingCycle: "monthly" | "annual";
  /**
   * Basis Theory token intent from the card capture that just ran.
   *
   * PRESENT  -> the Veyra recurring lane. One POST /api/v1/membership does the
   *             first charge + vault + membership row + Veyra's own renewal
   *             cron. We store the returned id in `veyra_membership_id`, which
   *             is what makes runMembershipBillingSweep() skip the row. Veyra
   *             bills every period after this one; we never do.
   * ABSENT   -> the legacy local lane (noop/mock BillingProvider). Unchanged.
   *
   * Price is ALWAYS resolved server-side from the tier row — never accept an
   * amount from the client (mirrors Evo's pages/api/membership/subscribe.js).
   */
  tokenIntentId?: string | null;
  /** Recorded with the membership for audit; version the consent copy. */
  consentTextVersion?: string;
}

export async function startMembershipSignup(input: StartMembershipSignupInput) {
  const tier = await getTierById(input.tierId);
  if (!tier) {
    throw new Error("Membership tier not found");
  }

  const contact = await getAuthUserContact(input.userId);
  const now = new Date();
  const billingProvider = getBillingProvider();

  // UPGRADE / DOWNGRADE, not a fresh signup: if the user already holds an
  // active or trialing paid membership, switch the tier IN PLACE. This never
  // re-runs the $1 intro charge, never overwrites a paid (e.g. annual) term,
  // and never re-sends welcome/trial emails — it just changes perks and
  // reconciles this month's store credit to the new tier.
  // Same rule as the hosted-checkout lane: an unreadable membership must not be
  // treated as a fresh signup, which re-runs the intro charge on a paying member.
  const { data: existingMembership, error: existingMembershipError } = await supabaseAdmin
    .from("customer_memberships")
    // cancel_at_period_end + veyra_membership_id are REQUIRED by the same-tier
    // branch below: without them it reads undefined, treats every member as
    // having no subscription, and falls through — which would charge a
    // legitimate member again on a double-submit.
    .select("user_id, tier_id, status, billing_cycle, cancel_at_period_end, veyra_membership_id")
    .eq("user_id", input.userId)
    .maybeSingle();

  if (existingMembershipError) throw existingMembershipError;

  if (
    existingMembership &&
    (existingMembership.status === "active" || existingMembership.status === "trialing") &&
    existingMembership.tier_id !== tier.id
  ) {
    // Reprice the NEXT charge to the new tier (pure logic in
    // computeTierChangeBilling, unit-tested in membership-billing-math.test.ts).
    // Without this the stored amounts keep the OLD tier's price, so the next
    // charge is wrong — an upgrade would undercharge and a downgrade overcharge.
    const isTrialing = existingMembership.status === "trialing";
    const changedCycle = (existingMembership.billing_cycle as string) ?? "monthly";
    const repriced = computeTierChangeBilling({
      isTrialing,
      billingCycle: changedCycle,
      monthlyPriceCents: tier.monthly_price_cents,
      annualPriceCents: tier.annual_price_cents ?? null,
      introPriceCents: tier.intro_price_cents,
    });

    // REPRICE AT VEYRA FIRST, AND ONLY MOVE THE MEMBER IF IT TAKES.
    //
    // Veyra owns the subscription and the amount it charges. This branch used to
    // write tier_id and next_billing_amount_cents locally and stop, so the perks
    // switched immediately while the card kept being billed the OLD tier's price
    // — an upgrade undercharged forever, a downgrade overcharged forever, and
    // every membership.renewed webhook carried the stale amount.
    //
    // A member with no veyra_membership_id has no ongoing subscription billing
    // them at all (charged once, nothing at the processor), so there is nothing
    // to keep in sync and the local change stands on its own.
    const veyraMembershipId = (existingMembership as { veyra_membership_id?: string | null })
      .veyra_membership_id;

    if (veyraMembershipId) {
      const repricedAtProcessor = await changeVeyraMembershipPlan(veyraMembershipId, {
        amountCents: repriced.nextBillingAmountCents,
        interval: changedCycle === "annual" ? "annual" : "monthly",
      });

      if (!repricedAtProcessor.ok) {
        // Leave the member exactly where they were. Granting the new tier's
        // perks while the old price is still what gets charged is the bug this
        // guard exists to prevent.
        console.error(
          "Could not reprice a membership at Veyra; tier change refused",
          input.userId,
          repricedAtProcessor.message,
        );
        await recordBillingEvent({
          userId: input.userId,
          tierId: tier.id,
          eventType: "tier_change",
          amountCents: 0,
          status: "failed",
        });
        return { success: false, changed: false, error: repricedAtProcessor.message };
      }
    }

    await supabaseAdmin
      .from("customer_memberships")
      .update({
        tier_id: tier.id,
        next_billing_amount_cents: repriced.nextBillingAmountCents,
        ...(repriced.firstMonthRemainderCents !== null
          ? { first_month_remainder_cents: repriced.firstMonthRemainderCents }
          : {}),
        renewal_reminder_sent_at: null,
        updated_at: now.toISOString(),
      })
      .eq("user_id", input.userId);

    await recordBillingEvent({ userId: input.userId, tierId: tier.id, eventType: "tier_change", amountCents: 0, status: "succeeded" });
    await reconcileMonthlyStoreCredit(input.userId, tier.monthly_store_credit_cents ?? 0).catch(() => {});

    return { success: true, changed: true };
  }

  if (existingMembership && (existingMembership.status === "active" || existingMembership.status === "trialing")) {
    // Same tier, already active/trialing — normally a no-op, which is what
    // stops a double-submit charging twice.
    //
    // BUT there are two states where this member is NOT actually served by an
    // ongoing subscription, and silently returning success traps them forever:
    //
    //   • No veyra_membership_id — charged once, nothing at the processor, so
    //     it can never renew. Buying again is the ONLY repair.
    //   • cancel_at_period_end — winding down; re-subscribing is the way back.
    //
    // Both were hitting this branch and getting `success: true` with NO charge,
    // NO Veyra call, NO card vaulted and NO billing event. The UI reported
    // success, the card was never presented, and the member stayed exactly as
    // broken as before with nothing in their history to explain it.
    const hasProcessorSubscription = Boolean(
      (existingMembership as { veyra_membership_id?: string | null }).veyra_membership_id,
    );
    const isWindingDown = Boolean(
      (existingMembership as { cancel_at_period_end?: boolean }).cancel_at_period_end,
    );

    if (hasProcessorSubscription && !isWindingDown) {
      return { success: true, changed: false };
    }
    // Otherwise fall through and create a REAL subscription below.
  }

  // No intro/trial flow — REMOVED per the owner (2026-07): every signup
  // charges the full period amount immediately, and the membership only
  // becomes "active" (benefits on) when that charge SUCCEEDS. A failed or
  // impossible charge (no processor connected) records "past_due", which
  // isMembershipActive treats as no benefits. The per-day idempotency key
  // makes double-clicks, retries, and races provider-deduplicated — the same
  // person can never be charged twice for the same signup.
  {
    const amountCents = input.billingCycle === "annual" ? tier.annual_price_cents : tier.monthly_price_cents;
    // Term shape (end date, next amount, wind-down flags, processor interval)
    // lives in membership-billing-math so the five values that must agree with
    // each other are decided together — and can be tested without Supabase.
    const term = membershipTermPlan(input.billingCycle, amountCents, now);
    const nextBillingAt = term.nextBillingAt;

    // Two lanes. A token intent means the shopper just entered a card and we
    // hand the whole subscription to Veyra; without one we fall back to the
    // legacy local provider (noop/mock) exactly as before.
    let chargeResult: ChargeCardResult;
    let veyraMembershipId: string | null = null;

    if (input.tokenIntentId) {
      if (!contact?.email) {
        // Veyra requires a customer email. Refuse rather than charge a card we
        // cannot attach to anyone — an orphaned recurring subscription is far
        // worse than a failed signup.
        chargeResult = { success: false, error: "No email on file for this account." };
      } else {
        const veyra = await startVeyraMembership({
          planCode: tier.slug || tier.id,
          amountCents,
          // "annual" is the Veyra spelling. "yearly" 400s.
          interval: term.processorInterval,
          tokenIntentId: input.tokenIntentId,
          customerEmail: contact.email,
          subscriptionKind: "shippable",
          customerNamespace: input.userId,
          ...(input.consentTextVersion ? { consentTextVersion: input.consentTextVersion } : {}),
        });

        if (veyra.ok) {
          veyraMembershipId = veyra.membershipId;
          chargeResult = { success: true, providerChargeId: veyra.membershipId };

          // ANNUAL DOES NOT AUTO-RENEW (owner decision). Veyra was asked for
          // `interval: "annual"`, and it would happily rebill the card a year
          // later — charging a customer for a second year they never agreed to,
          // on a card vaulted 12 months earlier. Tell Veyra to stop at the end
          // of this term immediately, so the year is paid for and nothing
          // follows it.
          //
          // We still create the subscription rather than a bare one-time charge:
          // that is what vaults the card and gives us a processor-side record to
          // cancel or refund against.
          if (term.stopAutoRenewAtProcessor) {
            const stopRenewal = await cancelVeyraMembership(veyra.membershipId, true);
            if (!stopRenewal.ok) {
              // The charge succeeded, so the member is entitled to their year.
              // Do NOT fail the signup — alert instead, because the live risk is
              // an unwanted renewal 12 months out, not anything today.
              await recordSystemAlert({
                type: "membership_annual_autorenew_not_stopped",
                severity: "critical",
                message:
                  `Annual membership ${veyra.membershipId} for user ${input.userId} was created, but the payment provider refused to stop auto-renewal (${stopRenewal.message}). `
                  + "This customer will be charged again in a year unless it is cancelled manually at the processor.",
                context: { userId: input.userId, veyraMembershipId: veyra.membershipId, error: stopRenewal.message },
              }).catch(() => {});
            }
          }
        } else {
          // Both failure kinds leave the member past-due and unbilled, but they
          // are NOT the same event: `payment_unavailable` is the shopper's to
          // fix (try another card), while config/transport is ours. Log the
          // distinction so a misconfigured merchant does not read as a store
          // full of declining cards.
          if (veyra.kind !== "payment_unavailable") {
            console.error(`[membership] Veyra ${veyra.kind} for user ${input.userId}: ${veyra.message}`);
          }
          chargeResult = { success: false, error: veyra.message };
        }
      }
    } else {
      chargeResult = await billingProvider.chargeCard({
        billingProviderCustomerId: null,
        paymentMethodRef: null,
        amountCents,
        currency: "usd",
        description: `${tier.name} - ${input.billingCycle} membership`,
        // Date-scoped: dedupes any duplicate submission of THIS signup while
        // still allowing a genuine cancel-and-rejoin on a later day.
        idempotencyKey: `signup-${input.userId}-${tier.id}-${input.billingCycle}-${now.toISOString().slice(0, 10)}`,
      });
    }

    // A membership record is created ONLY by a CONFIRMED successful charge.
    //
    // This upsert used to run unconditionally, writing tier_id, started_at,
    // renews_at and next_billing_at with status "past_due" whenever the charge
    // failed. That is what made a failed FIRST payment look like a real
    // membership: the account showed a tier name, an access-until date and a
    // next-billing date it had never paid for.
    //
    // A failed first payment now leaves the account with NO membership row at
    // all. "past_due" is reserved for an account that was already a member and
    // whose RENEWAL failed — handleChargeFailure below issues that as an UPDATE,
    // which is a no-op when no row exists, so the distinction holds automatically.
    if (chargeResult.success) {
      await supabaseAdmin.from("customer_memberships").upsert({
        user_id: input.userId,
        tier_id: tier.id,
        billing_cycle: input.billingCycle,
        status: "active",
        // THE load-bearing write. Non-null makes every sweep query skip this row,
        // because Veyra now owns its renewals. Drop this and the member is billed
        // twice a month — once by Veyra's cron, once by our sweep.
        veyra_membership_id: veyraMembershipId,
        started_at: now.toISOString(),
        renews_at: nextBillingAt.toISOString(),
        intro_status: "not_applicable",
        next_billing_at: nextBillingAt.toISOString(),
        // Annual takes no further charge, so there is no "next billing amount"
        // to promise. Showing the year's price here would tell the member they
        // are about to be charged again.
        next_billing_amount_cents: term.nextBillingAmountCents,
        // Annual is a one-year pass that does not auto-renew (owner decision),
        // and we just told Veyra to stop at period end — so the local row must
        // say the same thing. Leaving this false would show "renews on <date>"
        // for a membership that is actually ending, which is the same class of
        // lie as showing "ending" for one that is not.
        cancel_at_period_end: term.cancelAtPeriodEnd,
        updated_at: now.toISOString(),
      }, { onConflict: "user_id" });
    }

    if (chargeResult.success) {
      await recordBillingEvent({ userId: input.userId, tierId: tier.id, eventType: "renewal", amountCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });

      // THE MONEY, WHERE THE REPORTS LOOK FOR IT (VL-29).
      //
      // This lane is the ONLY live way to buy a membership — the hosted-checkout
      // lane (createMembershipCheckoutSession) and the manual annual lane
      // (createAnnualMembershipManualOrder) both write orders and both have no
      // callers left — and it wrote no order at all. So month one of every
      // membership was as invisible to /admin/revenue, the profit engine,
      // analytics and the CSV export as the renewals were.
      //
      // KEYED TO THE PROCESSOR SUBSCRIPTION, NOT TO THE ATTEMPT. The guard that
      // normally stops a double signup is the "already active" branch above, and
      // it reads the LOCAL membership row — so a retry that lands after the
      // charge but before (or instead of) that row falls straight through to
      // here a second time. `veyraMembershipId` is minted once per subscription
      // by the processor, so keying on it means the same subscription can never
      // book two sales, while a genuine cancel-and-rejoin mints a new id and is
      // correctly a second one.
      //
      // The legacy local lane has no such id; it takes the same date-scoped key
      // its own charge is deduplicated on (`signup-<user>-<tier>-<cycle>-<day>`),
      // so a retry inside the day that the provider deduplicates cannot book a
      // second order either.
      await recordMembershipChargeOrder({
        userId: input.userId,
        tierId: tier.id,
        billingCycle: input.billingCycle,
        amountCents,
        kind: "signup",
        paymentId: veyraMembershipId
          ? `membership-signup:${veyraMembershipId}`
          : `membership-signup:${input.userId}:${tier.id}:${input.billingCycle}:${now.toISOString().slice(0, 10)}`,
        paidAt: now.toISOString(),
      });

      if (contact) {
        await sendMarketingEmail({
          to: contact.email,
          campaignType: "membership_welcome",
          referenceId: input.userId,
          templateKey: "membershipWelcomeTemplate",
          ...membershipWelcomeTemplate({ name: contact.name, tierName: tier.name }),
        });

        // Transactional receipt for the real charge (always sent). Annual is a
        // one-year non-renewing pass; monthly auto-renews.
        await sendEmail({
          to: contact.email,
          ...membershipSignupReceiptTemplate({
            name: contact.name,
            tierName: tier.name,
            amountCents,
            billingCycle: input.billingCycle,
            nextBillingDate: formatDisplayDate(nextBillingAt, "long") ?? "",
            autoRenews: input.billingCycle === "monthly",
          }),
        });
      }
    } else {
      await handleChargeFailure({ userId: input.userId, tier, amountCents, eventType: "renewal", error: chargeResult.error });
    }

    return { success: chargeResult.success };
  }
}

export interface MembershipCancellationResult {
  billingCycle: "monthly" | "annual" | "free";
  // Access continues until the end of the term already paid for; it will not
  // renew. For an annual plan this is up to a year out.
  accessUntil: string | null;
  // Memberships are non-refundable — cancelling never returns money for the
  // current term (monthly OR annual). Annual members simply keep access for
  // the remainder of the year they paid for.
  refundable: false;
}

export async function cancelMembership(userId: string): Promise<MembershipCancellationResult> {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, renews_at, veyra_membership_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existing) {
    throw new Error("This customer has no paid membership to cancel");
  }

  const nowIso = new Date().toISOString();
  // A cancel DURING the $1 trial must terminate the trial immediately and STOP
  // the first-month remainder charge — otherwise the sweep would still bill the
  // remainder after an explicit cancel (money taken after cancellation). Only
  // the $1 was paid and memberships are non-refundable, so the trial simply
  // ends. For a fully-paid (active) term we keep the original behavior: stop
  // auto-renewal, let access run to the end of the already-paid period.
  const isTrialing = existing.status === "trialing";

  // Tell Veyra FIRST. It owns the billing schedule for these rows, so a
  // local-only cancel stops nothing — the customer sees "cancelled" and keeps
  // being charged every month, indefinitely. If Veyra refuses we abort and
  // leave local state untouched rather than show a cancellation that isn't real.
  //
  // Trialing cancels immediately (the remainder charge must not fire); a paid
  // term cancels at period end so access runs out the period already paid for.
  const veyraIdForCancel = (existing as { veyra_membership_id?: string | null }).veyra_membership_id;
  if (veyraIdForCancel) {
    const res = await cancelVeyraMembership(veyraIdForCancel, !isTrialing);
    if (!res.ok) {
      throw new Error(
        `We couldn't cancel your membership with the payment provider (${res.message}). Nothing was changed — please try again or contact support.`,
      );
    }
  }

  const cancelUpdate = isTrialing
    ? {
        status: "cancelled",
        intro_status: "cancelled",
        cancel_at_period_end: true,
        cancelled_at: nowIso,
        updated_at: nowIso,
      }
    : { cancel_at_period_end: true, updated_at: nowIso };

  const { error } = await supabaseAdmin
    .from("customer_memberships")
    .update(cancelUpdate)
    .eq("user_id", userId);

  if (error) throw error;

  await recordBillingEvent({ userId, tierId: existing.tier_id, eventType: "cancellation", amountCents: 0, status: "succeeded" });

  const billingCycle = (existing.billing_cycle as "monthly" | "annual" | "free") ?? "monthly";
  const accessUntil = (existing.next_billing_at as string | null) ?? (existing.renews_at as string | null) ?? null;

  return { billingCycle, accessUntil, refundable: false };
}

export interface MembershipBillingHistoryEntry {
  id: string;
  eventType: string;
  amountCents: number;
  status: string;
  failureReason: string | null;
  createdAt: string;
}

// Member-facing read of the charge/cancellation ledger for the customer's own
// subscription page. Read-only; scoped to the given user. Degrades to an empty
// list on error so the subscription page never blanks over billing history.
export async function getMembershipBillingHistory(userId: string, limit = 24): Promise<MembershipBillingHistoryEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("membership_billing_events")
    .select("id, event_type, amount_cents, status, failure_reason, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return [];

  return (data ?? []).map((row) => ({
    id: String(row.id),
    eventType: String(row.event_type ?? ""),
    amountCents: Number(row.amount_cents ?? 0),
    status: String(row.status ?? ""),
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    createdAt: String(row.created_at),
  }));
}

export interface MembershipScheduleResult {
  status: string;
  nextBillingAt: string | null;
}

// Pause a MONTHLY membership: billing stops (the sweep only ever charges
// active/trialing rows) and member benefits pause too (isMembershipActive
// requires active/trialing). Fully reversible via resumeMembership. Only valid
// for an active monthly plan that isn't already ending — annual plans are a
// one-time pass, and a plan set to cancel-at-period-end should just cancel.
export async function pauseMembership(userId: string): Promise<MembershipScheduleResult> {
  const { data: existing, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, cancel_at_period_end, veyra_membership_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new Error("You don't have a membership to pause.");
  if (existing.billing_cycle !== "monthly") throw new Error("Only monthly memberships can be paused.");
  if (existing.status !== "active") throw new Error("Only an active membership can be paused.");
  if (existing.cancel_at_period_end) throw new Error("This membership is already set to end — nothing to pause.");

  // Defer the charge at Veyra before flipping local state. A local-only pause
  // does not stop anything: observed live 2026-08-03, a membership paused here
  // stayed "active" at Veyra with its next charge still booked.
  //
  // ⚠️ Veyra has no pause endpoint (only cancel / skip_cycle / change / card /
  // retention), so a pause defers exactly ONE cycle. A member left paused past
  // that cycle would be charged again. Revisit if Veyra adds real pause.
  const veyraIdForPause = (existing as { veyra_membership_id?: string | null }).veyra_membership_id;
  let pausedNextRenewalAt: string | null = null;
  if (veyraIdForPause) {
    const res = await skipVeyraMembershipCycle(veyraIdForPause, "member paused");
    if (!res.ok) {
      throw new Error(
        `We couldn't pause your billing with the payment provider (${res.message}). Nothing was changed — please try again or contact support.`,
      );
    }
    pausedNextRenewalAt = res.nextRenewalAt ?? null;
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("customer_memberships")
    .update({
      status: "paused",
      updated_at: nowIso,
      // Adopt VEYRA's new date. Without this the row keeps the pre-pause date
      // and disagrees with the day the card is actually charged — observed
      // 2026-08-03: Veyra moved to Oct 3 while local still read Sep 2.
      ...(pausedNextRenewalAt
        ? { next_billing_at: pausedNextRenewalAt, renews_at: pausedNextRenewalAt, renewal_reminder_sent_at: null }
        : {}),
    })
    .eq("user_id", userId)
    .eq("status", "active");
  if (updateError) throw updateError;

  await recordBillingEvent({ userId, tierId: existing.tier_id, eventType: "pause", amountCents: 0, status: "succeeded" });
  return { status: "paused", nextBillingAt: (existing.next_billing_at as string | null) ?? null };
}

// Resume a paused membership. Benefits and billing turn back on. If the stored
// next-billing date is already in the past (time passed while paused), it rolls
// forward to a fresh 30-day cycle from now so the member is never retroactively
// charged for the paused stretch.
export async function resumeMembership(userId: string): Promise<MembershipScheduleResult> {
  const { data: existing, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, next_billing_at, cancel_at_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new Error("You don't have a membership to resume.");

  // TWO things can be "resumed", and only one of them was handled.
  //
  //   • paused                — billing is suspended, restart it.
  //   • cancel_at_period_end  — still active and paid through the period, but
  //                             set to lapse. Undoing this is just clearing the
  //                             flag; NO charge is due, because the current
  //                             period is already paid for.
  //
  // Handling only "paused" left a cancelled member with no way back: the button
  // refused, and buying again was refused too by the duplicate-purchase guard
  // (their status is still "active"). The account was stuck reading "Ending at
  // period end" with nothing that could clear it.
  const isPaused = existing.status === "paused";
  const isEnding = Boolean((existing as { cancel_at_period_end?: boolean }).cancel_at_period_end);
  if (!isPaused && !isEnding) {
    throw new Error("This membership is already active and set to renew.");
  }

  const now = new Date();
  const storedNext = existing.next_billing_at ? new Date(existing.next_billing_at as string) : null;
  const nextBillingAt = !storedNext || storedNext.getTime() <= now.getTime() ? new Date(now.getTime() + 30 * ONE_DAY_MS) : storedNext;

  const { error: updateError } = await supabaseAdmin
    .from("customer_memberships")
    .update({
      status: "active",
      next_billing_at: nextBillingAt.toISOString(),
      renews_at: nextBillingAt.toISOString(),
      // Undo the wind-down: the membership renews again, and the old
      // cancellation timestamp must not linger on a row that is now continuing.
      cancel_at_period_end: false,
      cancelled_at: null,
      renewal_reminder_sent_at: null,
      updated_at: now.toISOString(),
    })
    .eq("user_id", userId);
  if (updateError) throw updateError;

  await recordBillingEvent({ userId, tierId: existing.tier_id, eventType: "resume", amountCents: 0, status: "succeeded" });
  return { status: "active", nextBillingAt: nextBillingAt.toISOString() };
}

// Skip the next monthly charge: push the next-billing date forward one cycle
// (30 days) so exactly one renewal is skipped, and re-arm the renewal reminder.
/**
 * Has this member already used their skip for the period they are currently in?
 *
 * K-07. The old guard asked a DATE-DISTANCE question — "is next_billing_at more
 * than 33 days out?" — as a proxy for "has a skip happened?". It was wrong by
 * three days (the advance is +30d, the threshold was >33d, and the comparison was
 * strict), so any renewal within 3 days could be skipped TWICE: about 60 days of
 * perks and two extra monthly store-credit grants on one charge. And the window
 * in which it worked was exactly the window Step 4's "your renewal is in 3 days"
 * reminder targets, so the email put members into it.
 *
 * Moving the constant would fix today's arithmetic and leave the shape wrong: the
 * threshold and the advance live 200 lines apart with nothing tying them
 * together, and the reminder window is a third constant elsewhere again.
 *
 * So ask the real question instead. skipNextBilling already writes a `skip` row
 * to membership_billing_events, and PAID_EVENT_TYPES already names the events
 * that BEGIN a paid period. One skip since the last of those. A renewal starts a
 * new period and restores the entitlement; a failed or zero-amount event does
 * not, because membership-status.ts is explicit that lifecycle rows carry
 * status "succeeded" with amount_cents 0 for operations nobody paid for.
 *
 * A member with no paid event at all (an admin comp) gets one skip ever, which is
 * the conservative reading of "one per paid period" when no period was paid for.
 */
async function hasSkippedThisPaidPeriod(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("membership_billing_events")
    .select("event_type, amount_cents, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  // Fail CLOSED on a read error. Being unable to tell whether the entitlement is
  // spent must not spend it again — the failure this guard exists to prevent is
  // unbounded, and refusing costs the member one cycle's convenience.
  if (error) throw error;

  const rows = (data ?? []) as Array<{ event_type: string; amount_cents: number; status: string }>;
  return skipUsedThisPaidPeriod(
    rows.map((row) => ({
      eventType: row.event_type,
      status: row.status,
      amountCents: Number(row.amount_cents ?? 0),
    })),
  );
}

export async function skipNextBilling(userId: string): Promise<MembershipScheduleResult> {
  const { data: existing, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, cancel_at_period_end, veyra_membership_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new Error("You don't have a membership to skip.");
  if (existing.billing_cycle !== "monthly") throw new Error("Only monthly memberships can skip a cycle.");
  if (existing.status !== "active") throw new Error("Only an active membership can skip a cycle.");
  if (existing.cancel_at_period_end) throw new Error("This membership is already set to end.");

  const now = new Date();

  // ONE SKIP PER PAID PERIOD, asked as a fact rather than inferred from a date.
  // See hasSkippedThisPaidPeriod: the ledger already records every skip and every
  // paid event, so the entitlement is a query, not arithmetic.
  if (await hasSkippedThisPaidPeriod(userId)) {
    throw new Error("You've already skipped a charge this cycle — your next billing is already deferred.");
  }

  // Defence in depth, and the reason it is `>=` and `30` rather than `> 33`:
  // the advance below is `from + 30 days`, so any threshold above 30 can be
  // re-satisfied by the result of a skip. `>= 30d` cannot. This catches a
  // deferral that arrived some other way (a Veyra-side skip, a manual date edit)
  // without depending on the ledger.
  if (existing.next_billing_at && new Date(existing.next_billing_at as string).getTime() >= now.getTime() + 30 * ONE_DAY_MS) {
    throw new Error("You've already skipped a charge this cycle — your next billing is already deferred.");
  }

  // Same rule as pause/cancel: Veyra owns the schedule, so move the date THERE
  // first. A local-only skip leaves Veyra's charge booked on the original date
  // and the member is billed on a cycle they were told was skipped.
  const veyraIdForSkip = (existing as { veyra_membership_id?: string | null }).veyra_membership_id;
  let veyraSkippedTo: string | null = null;
  if (veyraIdForSkip) {
    const res = await skipVeyraMembershipCycle(veyraIdForSkip, "member skipped a cycle");
    if (!res.ok) {
      throw new Error(
        `We couldn't skip your next charge with the payment provider (${res.message}). Nothing was changed — please try again or contact support.`,
      );
    }
    veyraSkippedTo = res.nextRenewalAt ?? null;
  }

  const base = existing.next_billing_at ? new Date(existing.next_billing_at as string) : now;
  const from = base.getTime() <= now.getTime() ? now : base;
  // Prefer VEYRA's date over the local +30d computation whenever Veyra owns the
  // schedule — the local arithmetic is an approximation and drifts from the day
  // the card is actually charged.
  const nextBillingAt = veyraSkippedTo
    ? new Date(veyraSkippedTo)
    : new Date(from.getTime() + 30 * ONE_DAY_MS);

  const { error: updateError } = await supabaseAdmin
    .from("customer_memberships")
    .update({
      next_billing_at: nextBillingAt.toISOString(),
      renews_at: nextBillingAt.toISOString(),
      renewal_reminder_sent_at: null,
      updated_at: now.toISOString(),
    })
    .eq("user_id", userId)
    .eq("status", "active");
  if (updateError) throw updateError;

  await recordBillingEvent({ userId, tierId: existing.tier_id, eventType: "skip", amountCents: 0, status: "succeeded" });
  return { status: "active", nextBillingAt: nextBillingAt.toISOString() };
}

// A refunded or charged-back membership ends IMMEDIATELY. Unlike a normal
// cancellation (which keeps benefits until the already-paid period ends), a
// refund/chargeback means the customer no longer paid — so every benefit stops
// right now. Safe to call for any order; no-ops when the user has no membership.
export async function revokeMembershipForRefund(userId: string): Promise<void> {
  // "I COULD NOT READ" IS NOT "THEY HAVE NO MEMBERSHIP".
  //
  // This read's error was discarded, so a transient failure returned from this
  // function normally — the webhook's try completed, the brand-new
  // unsafe_effect_failed_membership_revoke alert never fired, and a customer who
  // charged back kept member pricing, free shipping, their points multiplier and
  // (because cancelVeyraMembership is skipped too) their Veyra subscription.
  // The one failure the alert exists for was the one it could not see.
  const { data: existing, error: readError } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, veyra_membership_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) throw readError;

  if (!existing) {
    return;
  }

  // STOP THE BILLING AT VEYRA, not just in our table.
  //
  // A refund or chargeback that only flips a local column leaves the Veyra
  // subscription running: the customer who just disputed a charge keeps being
  // billed every month, with our own records showing them cancelled. That is
  // the same local-only failure already fixed for cancel, pause and card
  // update — this path was missed, and it is the worst place to have it.
  //
  // Immediate (at_period_end: false), NOT at period end: the money has been
  // returned, so there is no paid period left to honour.
  //
  // Unlike customer-initiated cancel, we do NOT abort when Veyra refuses. The
  // refund already happened, so leaving them locally active would be wrong too.
  // Revoke locally either way and raise a CRITICAL alert so an operator cancels
  // at the processor by hand — an un-cancelled subscription after a refund
  // bills a disputing customer indefinitely.
  const veyraIdForRevoke = (existing as { veyra_membership_id?: string | null }).veyra_membership_id;
  if (veyraIdForRevoke) {
    const res = await cancelVeyraMembership(veyraIdForRevoke, false);
    if (!res.ok) {
      await recordSystemAlert({
        type: "membership_refund_not_cancelled",
        severity: "critical",
        message:
          `Refund/chargeback revoked membership for user ${userId} locally, but the payment provider REFUSED to cancel subscription ${veyraIdForRevoke} (${res.message}). `
          + "This customer will keep being charged until it is cancelled manually at the processor.",
        context: { userId, veyraMembershipId: veyraIdForRevoke, error: res.message },
      }).catch(() => {});
    }
  }

  // The revocation itself. Its error was discarded too, so this function
  // reported success having changed nothing at all.
  const { error: revokeError } = await supabaseAdmin
    .from("customer_memberships")
    .update({
      status: "cancelled",
      cancel_at_period_end: false,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (revokeError) throw revokeError;

  await recordBillingEvent({
    userId,
    tierId: existing.tier_id as string,
    eventType: "cancellation",
    amountCents: 0,
    status: "succeeded",
  }).catch(() => {});
}

export async function updatePaymentMethod(userId: string, paymentMethodRef: string) {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, veyra_membership_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing) throw new Error("You don't have a membership to update.");

  // TELL VEYRA FIRST for a Veyra-managed membership. The card lives THERE, not
  // here, so writing our local column alone changed nothing: a past-due member
  // who "updated their card" was still billed against the dead one on every
  // retry and could never recover. Same failure shape as the pause/cancel holes
  // — local-only state for a subscription somebody else owns.
  //
  // If Veyra refuses, abort and leave local state untouched rather than show a
  // card change that never happened.
  const veyraId = (existing as { veyra_membership_id?: string | null }).veyra_membership_id;
  if (veyraId) {
    const res = await updateVeyraMembershipCard(veyraId, paymentMethodRef);
    if (!res.ok) {
      throw new Error(
        `We couldn't update your card with the payment provider (${res.message}). Nothing was changed — please try again or contact support.`,
      );
    }
  }

  // Do NOT force status to "active": a cancelled/refund-revoked or past_due
  // member updating their card must not silently regain paid perks without an
  // actual successful charge. A past_due member is recovered by the next charge
  // succeeding on the new card, not by the card update itself.
  const { error } = await supabaseAdmin
    .from("customer_memberships")
    .update({ payment_method_ref: paymentMethodRef, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) throw error;
}

// A charge succeeded and the row must now be moved off "due". If that write
// fails the money has already moved, so this is never a silent path: the
// schedule still says the member owes for a period they have paid, and the
// next sweep will pick the same row up again.
//
// The idempotency key below is what stops that re-attempt becoming a second
// charge, and this alert is what stops the underlying breakage going unnoticed
// while the key quietly absorbs it. Both are needed; neither substitutes for
// the other.
async function advanceScheduleAfterCharge(
  userId: string,
  payload: Record<string, unknown>,
  context: { tierId: string; amountCents: number; eventType: string; providerChargeId?: string },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("customer_memberships")
    .update(payload)
    .eq("user_id", userId);
  if (!error) return;

  console.error("Charged a member but could not advance their billing schedule", userId, error);
  try {
    await recordSystemAlert({
      type: "membership_schedule_not_advanced",
      severity: "critical",
      message:
        `Charged ${userId} ${(context.amountCents / 100).toFixed(2)} for ${context.eventType} ` +
        "but could not advance next_billing_at. The member reads as still due and will be re-attempted.",
      context: { userId, ...context, error: error.message ?? String(error) },
    });
  } catch {
    // The alert is best-effort; the console line above is the floor.
  }
}

interface DueMembershipRow {
  user_id: string;
  tier_id: string;
  status: string;
  intro_status: string;
  intro_ends_at: string | null;
  next_billing_at: string | null;
  next_billing_amount_cents: number | null;
  first_month_remainder_cents: number | null;
  cancel_at_period_end: boolean;
  membership_tiers: TierRow | null;
}

const DUE_ROW_SELECT =
  "user_id, tier_id, status, intro_status, intro_ends_at, next_billing_at, next_billing_amount_cents, first_month_remainder_cents, cancel_at_period_end, membership_tiers(*)";

export interface MembershipBillingSweepResult {
  remainderRemindersSent: number;
  remainderChargesAttempted: number;
  renewalRemindersSent: number;
  renewalChargesAttempted: number;
  cancellationsFinalized: number;
}

// Idempotent, safe to run at any interval - each step only ever touches
// rows that are actually due and haven't already been handled, so a
// coarser cron interval just means coarser timing, never a double-charge
// or double-send.
// Grants the current month's store credit to every active paying member.
// Idempotent per member per month (unique index on the grant), so it's safe
// to run on every cron tick — a member only ever gets one grant per month, and
// it stops the instant their membership is no longer active/trialing.
/**
 * HOW MANY GRANTS ONE TICK MAY WRITE, and how far it may look for them.
 *
 * This sweep read EVERY active member and awaited an insert for each one, every
 * thirty minutes, for ever. The insert is idempotent — a unique index on
 * (user_id, period_month) refuses the second one — so after the first tick of
 * the month essentially all of that work was round trips that could only fail.
 * The cost was one database call per member per tick regardless, which on a
 * 60-second function is a ceiling on the membership base rather than on
 * anything the business chose.
 *
 * A plain `.limit()` would have been WORSE than the unbounded version: the same
 * already-granted members sort first every tick and would spend the whole
 * budget being refused, so members past the limit would never be granted at
 * all. So the period's existing grants are read first and subtracted, and the
 * budget is spent only on members who genuinely have none. That drains: a
 * member granted this tick is excluded from the next one, permanently, until
 * the period rolls over.
 */
const STORE_CREDIT_GRANT_BUDGET = 200;

/** Members examined per tick while looking for that many ungranted ones. */
const STORE_CREDIT_SCAN_PAGE = 500;
const STORE_CREDIT_MAX_SCAN = 5000;

interface StoreCreditCandidate {
  user_id: string;
  membership_tiers: { slug: string; monthly_store_credit_cents: number } | null;
}

/** Which of these members already hold this period's grant. */
async function alreadyGrantedThisPeriod(userIds: string[], period: string): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("user_id")
    .eq("reason", "membership_monthly_grant")
    .eq("period_month", period)
    .in("user_id", userIds);

  // Fail OPEN — an unreadable ledger means we cannot subtract anyone, so every
  // candidate is attempted and the unique index does the deduplication as
  // before. Slower, never wrong.
  if (error || !data) return new Set();
  return new Set(data.map((row) => String(row.user_id)));
}

export async function grantMonthlyStoreCreditSweep(): Promise<{ granted: number; scanned: number }> {
  const period = currentPeriodMonth();
  let granted = 0;
  let scanned = 0;
  const pending: Array<{ userId: string; cents: number }> = [];

  for (let offset = 0; offset < STORE_CREDIT_MAX_SCAN && pending.length < STORE_CREDIT_GRANT_BUDGET; offset += STORE_CREDIT_SCAN_PAGE) {
    // Only fully-active (paid) members receive store credit — NOT $1 trial
    // members (mirrors the bulk-savings rule), so a $1 trial can't immediately
    // pull $75 of credit.
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select("user_id, status, membership_tiers(slug, monthly_store_credit_cents)")
      .eq("status", "active")
      // Only members on a real recurring billing cycle earn monthly store credit.
      // Admin-assigned complimentary memberships have next_billing_at = null, so
      // they are excluded — a comp must NOT silently hand out credit every month.
      .not("next_billing_at", "is", null)
      // A stable order is what makes the paging mean anything: without it two
      // pages can return the same row and miss another.
      .order("user_id", { ascending: true })
      .range(offset, offset + STORE_CREDIT_SCAN_PAGE - 1);

    if (error) {
      if (String(error.code) === "42P01") return { granted: 0, scanned: 0 };
      throw error;
    }

    const page = (data ?? []) as unknown as StoreCreditCandidate[];
    if (page.length === 0) break;
    scanned += page.length;

    const eligible = page.filter((row) => {
      const tier = row.membership_tiers;
      return Boolean(tier) && tier?.slug !== "free" && Number(tier?.monthly_store_credit_cents ?? 0) > 0;
    });

    const alreadyGranted = await alreadyGrantedThisPeriod(
      eligible.map((row) => String(row.user_id)),
      period,
    );

    for (const row of eligible) {
      const userId = String(row.user_id);
      if (alreadyGranted.has(userId)) continue;
      pending.push({ userId, cents: Number(row.membership_tiers?.monthly_store_credit_cents ?? 0) });
      if (pending.length >= STORE_CREDIT_GRANT_BUDGET) break;
    }

    if (page.length < STORE_CREDIT_SCAN_PAGE) break;
  }

  for (const { userId, cents } of pending) {
    try {
      if (await grantMonthlyStoreCredit(userId, cents)) granted += 1;
    } catch {
      // One member's grant failing must not stop the rest of the sweep.
    }
  }

  return { granted, scanned };
}

/**
 * HOW MUCH BILLING ONE TICK MAY DO.
 *
 * Every step below used to select its whole due window with no limit and then
 * await per row — a card charge, a provider round trip and an email each. Cost
 * per tick therefore grew with the membership base, on a function capped at 60
 * seconds, so past some number of members the sweep stopped finishing and the
 * renewals at the back were never reached. Nothing said so: an overrun is
 * killed by the platform, which is why the watchdog in the cron route exists.
 *
 * Bounding is safe here BECAUSE EVERY STEP DRAINS. Each window is defined by
 * the state the step then changes — a reminder sets `*_reminder_sent_at`, a
 * charge advances `next_billing_at`, a declined charge moves the member to
 * `past_due` — so a row that has been handled leaves the window and cannot
 * hold the budget on the next tick. Oldest-due-first, so the queue is FIFO and
 * the longest-waiting member is never the one that gets skipped.
 *
 * At a tick every 30 minutes these are ~1,200 charges and ~2,400 notices a day.
 */
const MEMBERSHIP_CHARGE_BATCH = 25;

/** Reminders and cancellations: an email and an update, no card call. */
const MEMBERSHIP_NOTICE_BATCH = 50;

export async function runMembershipBillingSweep(): Promise<MembershipBillingSweepResult> {
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * ONE_DAY_MS);
  const result: MembershipBillingSweepResult = {
    remainderRemindersSent: 0,
    remainderChargesAttempted: 0,
    renewalRemindersSent: 0,
    renewalChargesAttempted: 0,
    cancellationsFinalized: 0,
  };

  const billingProvider = getBillingProvider();

  // Step 1: 3-day reminder before the first-month remainder charge.
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
      // Veyra owns the renewal schedule for any membership created through
      // /api/v1/membership — it charges the card AND runs the retry/dunning
      // cron itself. This sweep must therefore never see those rows: not to
      // charge them, not to remind on them, not to mark them past-due. If both
      // sides billed, every Veyra-backed member would be charged twice a month.
      // (Same double-fire shape as the EVO confirm-backfill leak, 2026-08-01:
      // a second system acting on rows it does not own.)
      .is("veyra_membership_id", null)
      .eq("status", "trialing")
      .eq("intro_status", "active")
      .eq("cancel_at_period_end", false)
      .is("first_month_reminder_sent_at", null)
      .lte("intro_ends_at", in3Days.toISOString())
      .gt("intro_ends_at", now.toISOString())
      .order("intro_ends_at", { ascending: true })
      .limit(MEMBERSHIP_NOTICE_BATCH);

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
      // Atomically CLAIM before sending: flip first_month_reminder_sent_at
      // NULL -> now and proceed only if THIS sweep won the flip. Two overlapping
      // sweeps can no longer both email the same member.
      const { data: claimedRemainder } = await supabaseAdmin
        .from("customer_memberships")
        .update({ first_month_reminder_sent_at: now.toISOString() })
        .eq("user_id", row.user_id)
        .is("first_month_reminder_sent_at", null)
        .select("user_id");
      if (!claimedRemainder || claimedRemainder.length === 0) continue;
      const contact = await getAuthUserContact(row.user_id);
      if (contact && row.first_month_remainder_cents !== null && row.intro_ends_at) {
        await sendEmail({
          to: contact.email,
          ...membershipRemainderReminderTemplate({
            name: contact.name,
            remainderCents: row.first_month_remainder_cents,
            chargeDate: formatDisplayDate(row.intro_ends_at, "long") ?? "",
          }),
        });
      }
      result.remainderRemindersSent += 1;
    }
  }

  // Step 2: the first-month remainder charge itself, once the intro period ends.
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
      // Veyra owns the renewal schedule for any membership created through
      // /api/v1/membership — it charges the card AND runs the retry/dunning
      // cron itself. This sweep must therefore never see those rows: not to
      // charge them, not to remind on them, not to mark them past-due. If both
      // sides billed, every Veyra-backed member would be charged twice a month.
      // (Same double-fire shape as the EVO confirm-backfill leak, 2026-08-01:
      // a second system acting on rows it does not own.)
      .is("veyra_membership_id", null)
      .eq("status", "trialing")
      .eq("intro_status", "active")
      .eq("cancel_at_period_end", false)
      .lte("intro_ends_at", now.toISOString())
      .order("intro_ends_at", { ascending: true })
      .limit(MEMBERSHIP_CHARGE_BATCH);

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
      const tier = row.membership_tiers;
      if (!tier) continue;
      const amountCents = row.first_month_remainder_cents ?? 0;
      result.remainderChargesAttempted += 1;

      const chargeResult = await billingProvider.chargeCard({
        billingProviderCustomerId: null,
        paymentMethodRef: null,
        amountCents,
        currency: "usd",
        description: `${tier.name} - first month remainder`,
        idempotencyKey: `remainder-${row.user_id}-${tier.id}`,
      });

      if (chargeResult.success) {
        const nextBillingAt = new Date(now.getTime() + 30 * ONE_DAY_MS);
        // Same exposure as the renewal below: this write is what moves the row
        // off "due". Its idempotency key is already period-stable, so a failure
        // here does not double-charge — but it does strand the member mid-
        // conversion, and that must not happen quietly.
        await advanceScheduleAfterCharge(
          row.user_id,
          {
            intro_status: "converted",
            status: "active",
            next_billing_at: nextBillingAt.toISOString(),
            next_billing_amount_cents: tier.monthly_price_cents,
            renews_at: nextBillingAt.toISOString(),
            renewal_reminder_sent_at: null,
            updated_at: now.toISOString(),
          },
          { tierId: tier.id, amountCents, eventType: "first_month_remainder", providerChargeId: chargeResult.providerChargeId },
        );

        await recordBillingEvent({ userId: row.user_id, tierId: tier.id, eventType: "first_month_remainder", amountCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });

        const contact = await getAuthUserContact(row.user_id);
        if (contact) {
          await sendEmail({
            to: contact.email,
            ...membershipRemainderReceiptTemplate({
              name: contact.name,
              remainderCents: amountCents,
              nextBillingDate: formatDisplayDate(nextBillingAt, "long") ?? "",
              monthlyPriceCents: tier.monthly_price_cents,
            }),
          });
        }
      } else {
        await handleChargeFailure({ userId: row.user_id, tier, amountCents, eventType: "first_month_remainder", error: chargeResult.error });
      }
    }
  }

  // Step 3: cancellations whose period has now ended (cancel_at_period_end
  // was requested earlier, and next_billing_at - the end of the paid
  // period - has now arrived).
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
      // Veyra owns the renewal schedule for any membership created through
      // /api/v1/membership — it charges the card AND runs the retry/dunning
      // cron itself. This sweep must therefore never see those rows: not to
      // charge them, not to remind on them, not to mark them past-due. If both
      // sides billed, every Veyra-backed member would be charged twice a month.
      // (Same double-fire shape as the EVO confirm-backfill leak, 2026-08-01:
      // a second system acting on rows it does not own.)
      .is("veyra_membership_id", null)
      .eq("status", "active")
      .eq("cancel_at_period_end", true)
      .lte("next_billing_at", now.toISOString())
      .order("next_billing_at", { ascending: true })
      .limit(MEMBERSHIP_NOTICE_BATCH);

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
      const tier = row.membership_tiers;
      await supabaseAdmin
        .from("customer_memberships")
        .update({ status: "cancelled", cancelled_at: now.toISOString(), updated_at: now.toISOString() })
        .eq("user_id", row.user_id);

      const contact = await getAuthUserContact(row.user_id);
      if (contact && tier) {
        await sendMarketingEmail({
          to: contact.email,
          campaignType: "membership_winback",
          referenceId: row.user_id,
          templateKey: "membershipWinBackTemplate",
          ...membershipWinBackTemplate({
            name: contact.name,
            tierName: tier.name,
            offerPercent: 20,
            resubscribeUrl: `${getSiteUrl()}/membership/${tier.slug}/subscribe`,
          }),
        });
      }
      result.cancellationsFinalized += 1;
    }
  }

  // Step 4: 3-day reminder before a monthly renewal charge.
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
      // Veyra owns the renewal schedule for any membership created through
      // /api/v1/membership — it charges the card AND runs the retry/dunning
      // cron itself. This sweep must therefore never see those rows: not to
      // charge them, not to remind on them, not to mark them past-due. If both
      // sides billed, every Veyra-backed member would be charged twice a month.
      // (Same double-fire shape as the EVO confirm-backfill leak, 2026-08-01:
      // a second system acting on rows it does not own.)
      .is("veyra_membership_id", null)
      .eq("status", "active")
      .eq("cancel_at_period_end", false)
      .is("renewal_reminder_sent_at", null)
      .lte("next_billing_at", in3Days.toISOString())
      .gt("next_billing_at", now.toISOString())
      .order("next_billing_at", { ascending: true })
      .limit(MEMBERSHIP_NOTICE_BATCH);

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
      // Atomically CLAIM before sending (same exactly-once pattern as the
      // remainder reminder) so overlapping sweeps can't both send it.
      const { data: claimedRenewal } = await supabaseAdmin
        .from("customer_memberships")
        .update({ renewal_reminder_sent_at: now.toISOString() })
        .eq("user_id", row.user_id)
        .is("renewal_reminder_sent_at", null)
        .select("user_id");
      if (!claimedRenewal || claimedRenewal.length === 0) continue;
      const tier = row.membership_tiers;
      const contact = await getAuthUserContact(row.user_id);
      if (contact && tier && row.next_billing_at) {
        await sendEmail({
          to: contact.email,
          ...membershipRenewalReminderTemplate({
            name: contact.name,
            monthlyPriceCents: tier.monthly_price_cents,
            chargeDate: formatDisplayDate(row.next_billing_at, "long") ?? "",
          }),
        });
      }
      result.renewalRemindersSent += 1;
    }
  }

  // Step 5: the monthly renewal charge itself.
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
      // Veyra owns the renewal schedule for any membership created through
      // /api/v1/membership — it charges the card AND runs the retry/dunning
      // cron itself. This sweep must therefore never see those rows: not to
      // charge them, not to remind on them, not to mark them past-due. If both
      // sides billed, every Veyra-backed member would be charged twice a month.
      // (Same double-fire shape as the EVO confirm-backfill leak, 2026-08-01:
      // a second system acting on rows it does not own.)
      .is("veyra_membership_id", null)
      .eq("status", "active")
      .eq("cancel_at_period_end", false)
      .lte("next_billing_at", now.toISOString())
      .order("next_billing_at", { ascending: true })
      .limit(MEMBERSHIP_CHARGE_BATCH);

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
      const tier = row.membership_tiers;
      if (!tier) continue;
      const amountCents = row.next_billing_amount_cents ?? tier.monthly_price_cents;
      result.renewalChargesAttempted += 1;

      const chargeResult = await billingProvider.chargeCard({
        billingProviderCustomerId: null,
        paymentMethodRef: null,
        amountCents,
        currency: "usd",
        description: `${tier.name} - monthly renewal`,
        // KEYED TO THE PERIOD BEING BILLED, NOT TO THE DAY THE SWEEP RAN.
        //
        // This was `now.toISOString().slice(0, 10)` — today's UTC date. That
        // identifies WHEN the attempt happened rather than WHICH renewal it
        // pays for, so two attempts at the same renewal ninety seconds apart
        // either side of UTC midnight carried two different keys, and the
        // processor's idempotency — the last thing between a retry and a
        // second charge — did not fire.
        //
        // The row's own next_billing_at is the period. It is stable across
        // every retry of that renewal no matter when the sweep runs, and it
        // still changes next month, so a legitimate later renewal is not
        // deduped away.
        idempotencyKey: `renewal-${row.user_id}-${tier.id}-${row.next_billing_at ?? "unscheduled"}`,
      });

      if (chargeResult.success) {
        const nextBillingAt = new Date(now.getTime() + 30 * ONE_DAY_MS);
        await advanceScheduleAfterCharge(
          row.user_id,
          {
            next_billing_at: nextBillingAt.toISOString(),
            next_billing_amount_cents: tier.monthly_price_cents,
            renews_at: nextBillingAt.toISOString(),
            renewal_reminder_sent_at: null,
            updated_at: now.toISOString(),
          },
          { tierId: tier.id, amountCents, eventType: "renewal", providerChargeId: chargeResult.providerChargeId },
        );

        await recordBillingEvent({ userId: row.user_id, tierId: tier.id, eventType: "renewal", amountCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });

        // THE MONEY, WHERE THE REPORTS LOOK FOR IT (VL-29). Same reasoning as
        // the Veyra lane in membership-webhook.ts: the billing event above is
        // read by one admin screen, and every revenue surface reads `orders`.
        //
        // Keyed to the period just billed — the SAME key the charge above is
        // deduplicated on at the processor — so a retried or overlapping sweep
        // books one order, not two.
        await recordMembershipChargeOrder({
          userId: row.user_id,
          // The row's own column, not the embedded tier: it is the value every
          // other membership surface reports from, and it is present even when
          // the tier join is not.
          tierId: row.tier_id ?? tier.id ?? null,
          billingCycle: "monthly",
          amountCents,
          kind: "renewal",
          paymentId: `membership-renewal:${row.user_id}:${row.next_billing_at ?? now.toISOString()}`,
          paidAt: now.toISOString(),
        });

        const contact = await getAuthUserContact(row.user_id);
        if (contact) {
          await sendEmail({
            to: contact.email,
            ...membershipRenewalReceiptTemplate({
              name: contact.name,
              monthlyPriceCents: amountCents,
              nextBillingDate: formatDisplayDate(nextBillingAt, "long") ?? "",
            }),
          });
        }
      } else {
        await handleChargeFailure({ userId: row.user_id, tier, amountCents, eventType: "renewal", error: chargeResult.error });
      }
    }
  }

  return result;
}
