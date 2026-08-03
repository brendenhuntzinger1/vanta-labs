import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getBillingProvider, type ChargeCardResult } from "@/lib/billing-provider";
import { startVeyraMembership } from "@/lib/veyra-membership";
import { getPaymentProvider, isCheckoutOpen } from "@/lib/payment-provider";
import { computeTierChangeBilling } from "@/lib/membership-billing-math";
import { PAID_EVENT_TYPES } from "@/lib/membership-status";
import { grantMonthlyStoreCredit, reconcileMonthlyStoreCredit } from "@/lib/store-credit";
import { sendEmail } from "@/lib/email/send";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { getSiteUrl } from "@/lib/env";
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
  if (!tier) return;

  const now = new Date();
  const nextBillingAt = new Date(now.getTime() + 365 * ONE_DAY_MS);

  await supabaseAdmin.from("customer_memberships").upsert({
    user_id: userId,
    tier_id: tier.id,
    billing_cycle: "annual",
    status: "active",
    started_at: now.toISOString(),
    renews_at: nextBillingAt.toISOString(),
    intro_status: "not_applicable",
    next_billing_at: nextBillingAt.toISOString(),
    next_billing_amount_cents: 0,
    cancel_at_period_end: true,
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });

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
        nextBillingDate: nextBillingAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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
  if (!tier) return;

  const now = new Date();
  const nextBillingAt = new Date(now.getTime() + 30 * ONE_DAY_MS);

  await supabaseAdmin.from("customer_memberships").upsert({
    user_id: userId,
    tier_id: tier.id,
    billing_cycle: "monthly",
    status: "active",
    started_at: now.toISOString(),
    renews_at: nextBillingAt.toISOString(),
    intro_status: "not_applicable",
    next_billing_at: nextBillingAt.toISOString(),
    next_billing_amount_cents: tier.monthly_price_cents ?? 0,
    cancel_at_period_end: false,
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });

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
        nextBillingDate: nextBillingAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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

  const orderId = `order-${randomUUID()}`;
  const orderNumber = `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

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
  const { data: existingMembership } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle")
    .eq("user_id", input.userId)
    .maybeSingle();

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
    // Same tier, already active/trialing — no-op (prevents duplicate intro
    // charges and duplicate welcome/trial emails on a double-submit).
    return { success: true, changed: false };
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
    const nextBillingAt = new Date(now.getTime() + (input.billingCycle === "annual" ? 365 : 30) * ONE_DAY_MS);

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
          interval: input.billingCycle === "annual" ? "annual" : "monthly",
          tokenIntentId: input.tokenIntentId,
          customerEmail: contact.email,
          subscriptionKind: "shippable",
          customerNamespace: input.userId,
          ...(input.consentTextVersion ? { consentTextVersion: input.consentTextVersion } : {}),
        });

        if (veyra.ok) {
          veyraMembershipId = veyra.membershipId;
          chargeResult = { success: true, providerChargeId: veyra.membershipId };
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
        next_billing_amount_cents: amountCents,
        cancel_at_period_end: false,
        updated_at: now.toISOString(),
      }, { onConflict: "user_id" });
    }

    if (chargeResult.success) {
      await recordBillingEvent({ userId: input.userId, tierId: tier.id, eventType: "renewal", amountCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });
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
            nextBillingDate: nextBillingAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, renews_at")
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
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, cancel_at_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new Error("You don't have a membership to pause.");
  if (existing.billing_cycle !== "monthly") throw new Error("Only monthly memberships can be paused.");
  if (existing.status !== "active") throw new Error("Only an active membership can be paused.");
  if (existing.cancel_at_period_end) throw new Error("This membership is already set to end — nothing to pause.");

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("customer_memberships")
    .update({ status: "paused", updated_at: nowIso })
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
    .select("user_id, tier_id, status, next_billing_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new Error("You don't have a membership to resume.");
  if (existing.status !== "paused") throw new Error("This membership isn't paused.");

  const now = new Date();
  const storedNext = existing.next_billing_at ? new Date(existing.next_billing_at as string) : null;
  const nextBillingAt = !storedNext || storedNext.getTime() <= now.getTime() ? new Date(now.getTime() + 30 * ONE_DAY_MS) : storedNext;

  const { error: updateError } = await supabaseAdmin
    .from("customer_memberships")
    .update({
      status: "active",
      next_billing_at: nextBillingAt.toISOString(),
      renews_at: nextBillingAt.toISOString(),
      renewal_reminder_sent_at: null,
      updated_at: now.toISOString(),
    })
    .eq("user_id", userId)
    .eq("status", "paused");
  if (updateError) throw updateError;

  await recordBillingEvent({ userId, tierId: existing.tier_id, eventType: "resume", amountCents: 0, status: "succeeded" });
  return { status: "active", nextBillingAt: nextBillingAt.toISOString() };
}

// Skip the next monthly charge: push the next-billing date forward one cycle
// (30 days) so exactly one renewal is skipped, and re-arm the renewal reminder.
export async function skipNextBilling(userId: string): Promise<MembershipScheduleResult> {
  const { data: existing, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status, billing_cycle, next_billing_at, cancel_at_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!existing) throw new Error("You don't have a membership to skip.");
  if (existing.billing_cycle !== "monthly") throw new Error("Only monthly memberships can skip a cycle.");
  if (existing.status !== "active") throw new Error("Only an active membership can skip a cycle.");
  if (existing.cancel_at_period_end) throw new Error("This membership is already set to end.");

  const now = new Date();
  // Cap to ONE skip per paid period. Without this a member could POST skip in a
  // loop, pushing next_billing_at years out while staying "active" — keeping all
  // perks and monthly store credit forever for a single charge. If the next
  // charge is already deferred more than a cycle out, they've already skipped.
  if (existing.next_billing_at && new Date(existing.next_billing_at as string).getTime() > now.getTime() + 33 * ONE_DAY_MS) {
    throw new Error("You've already skipped a charge this cycle — your next billing is already deferred.");
  }

  const base = existing.next_billing_at ? new Date(existing.next_billing_at as string) : now;
  const from = base.getTime() <= now.getTime() ? now : base;
  const nextBillingAt = new Date(from.getTime() + 30 * ONE_DAY_MS);

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
  const { data: existing } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, tier_id, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    return;
  }

  await supabaseAdmin
    .from("customer_memberships")
    .update({
      status: "cancelled",
      cancel_at_period_end: false,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  await recordBillingEvent({
    userId,
    tierId: existing.tier_id as string,
    eventType: "cancellation",
    amountCents: 0,
    status: "succeeded",
  }).catch(() => {});
}

export async function updatePaymentMethod(userId: string, paymentMethodRef: string) {
  // ONLY update the stored card reference. Do NOT force status to "active":
  // a cancelled/refund-revoked or past_due member updating their card must not
  // silently regain paid perks without an actual successful charge. A past_due
  // member is recovered by the next sweep charge succeeding on the new card,
  // not by the card update itself.
  const { error } = await supabaseAdmin
    .from("customer_memberships")
    .update({ payment_method_ref: paymentMethodRef, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) throw error;
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
export async function grantMonthlyStoreCreditSweep(): Promise<{ granted: number }> {
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
    .not("next_billing_at", "is", null);

  if (error) {
    if (String(error.code) === "42P01") return { granted: 0 };
    throw error;
  }

  let granted = 0;
  for (const row of (data ?? []) as unknown as Array<{ user_id: string; membership_tiers: { slug: string; monthly_store_credit_cents: number } | null }>) {
    const tier = row.membership_tiers;
    if (!tier || tier.slug === "free") continue;
    const cents = Number(tier.monthly_store_credit_cents ?? 0);
    if (cents <= 0) continue;
    try {
      if (await grantMonthlyStoreCredit(String(row.user_id), cents)) granted += 1;
    } catch {
      // One member's grant failing must not stop the rest of the sweep.
    }
  }

  return { granted };
}

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
      .gt("intro_ends_at", now.toISOString());

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
            chargeDate: new Date(row.intro_ends_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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
      .lte("intro_ends_at", now.toISOString());

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
        await supabaseAdmin
          .from("customer_memberships")
          .update({
            intro_status: "converted",
            status: "active",
            next_billing_at: nextBillingAt.toISOString(),
            next_billing_amount_cents: tier.monthly_price_cents,
            renews_at: nextBillingAt.toISOString(),
            renewal_reminder_sent_at: null,
            updated_at: now.toISOString(),
          })
          .eq("user_id", row.user_id);

        await recordBillingEvent({ userId: row.user_id, tierId: tier.id, eventType: "first_month_remainder", amountCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });

        const contact = await getAuthUserContact(row.user_id);
        if (contact) {
          await sendEmail({
            to: contact.email,
            ...membershipRemainderReceiptTemplate({
              name: contact.name,
              remainderCents: amountCents,
              nextBillingDate: nextBillingAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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
      .lte("next_billing_at", now.toISOString());

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
      .gt("next_billing_at", now.toISOString());

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
            chargeDate: new Date(row.next_billing_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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
      .lte("next_billing_at", now.toISOString());

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
        idempotencyKey: `renewal-${row.user_id}-${tier.id}-${now.toISOString().slice(0, 10)}`,
      });

      if (chargeResult.success) {
        const nextBillingAt = new Date(now.getTime() + 30 * ONE_DAY_MS);
        await supabaseAdmin
          .from("customer_memberships")
          .update({
            next_billing_at: nextBillingAt.toISOString(),
            next_billing_amount_cents: tier.monthly_price_cents,
            renews_at: nextBillingAt.toISOString(),
            renewal_reminder_sent_at: null,
            updated_at: now.toISOString(),
          })
          .eq("user_id", row.user_id);

        await recordBillingEvent({ userId: row.user_id, tierId: tier.id, eventType: "renewal", amountCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });

        const contact = await getAuthUserContact(row.user_id);
        if (contact) {
          await sendEmail({
            to: contact.email,
            ...membershipRenewalReceiptTemplate({
              name: contact.name,
              monthlyPriceCents: amountCents,
              nextBillingDate: nextBillingAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
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
