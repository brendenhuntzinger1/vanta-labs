import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getBillingProvider } from "@/lib/billing-provider";
import { grantMonthlyStoreCredit } from "@/lib/store-credit";
import { sendEmail } from "@/lib/email/send";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { getSiteUrl } from "@/lib/env";
import {
  membershipWelcomeTemplate,
  membershipTrialConfirmationTemplate,
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
}

async function getTierById(tierId: string): Promise<TierRow | null> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("id, slug, name, monthly_price_cents, annual_price_cents, intro_price_cents, intro_duration_days, intro_offer_enabled")
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
  }
}

export interface StartMembershipSignupInput {
  userId: string;
  tierId: string;
  billingCycle: "monthly" | "annual";
}

export async function startMembershipSignup(input: StartMembershipSignupInput) {
  const tier = await getTierById(input.tierId);
  if (!tier) {
    throw new Error("Membership tier not found");
  }

  const contact = await getAuthUserContact(input.userId);
  const now = new Date();
  const billingProvider = getBillingProvider();

  if (input.billingCycle === "annual" || !tier.intro_offer_enabled) {
    // No intro flow: annual signup, or a tier with the intro offer turned
    // off - charge the full period amount immediately, same honesty rule
    // as the monthly path (a real charge attempt, not a silent "active").
    const amountCents = input.billingCycle === "annual" ? tier.annual_price_cents : tier.monthly_price_cents;
    const nextBillingAt = new Date(now.getTime() + (input.billingCycle === "annual" ? 365 : 30) * ONE_DAY_MS);

    const chargeResult = await billingProvider.chargeCard({
      billingProviderCustomerId: null,
      paymentMethodRef: null,
      amountCents,
      currency: "usd",
      description: `${tier.name} - ${input.billingCycle} membership`,
      idempotencyKey: `signup-${input.userId}-${tier.id}-${input.billingCycle}`,
    });

    await supabaseAdmin.from("customer_memberships").upsert({
      user_id: input.userId,
      tier_id: tier.id,
      billing_cycle: input.billingCycle,
      status: chargeResult.success ? "active" : "past_due",
      started_at: now.toISOString(),
      renews_at: nextBillingAt.toISOString(),
      intro_status: "not_applicable",
      next_billing_at: nextBillingAt.toISOString(),
      next_billing_amount_cents: amountCents,
      cancel_at_period_end: false,
      updated_at: now.toISOString(),
    }, { onConflict: "user_id" });

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
      }
    } else {
      await handleChargeFailure({ userId: input.userId, tier, amountCents, eventType: "renewal", error: chargeResult.error });
    }

    return { success: chargeResult.success };
  }

  // Monthly signup with the $1-intro-then-remainder flow.
  const introChargeCents = tier.intro_price_cents;
  const remainderCents = Math.max(0, tier.monthly_price_cents - introChargeCents);
  const introEndsAt = new Date(now.getTime() + tier.intro_duration_days * ONE_DAY_MS);

  const chargeResult = await billingProvider.chargeCard({
    billingProviderCustomerId: null,
    paymentMethodRef: null,
    amountCents: introChargeCents,
    currency: "usd",
    description: `${tier.name} - ${tier.intro_duration_days}-day intro`,
    idempotencyKey: `intro-${input.userId}-${tier.id}`,
  });

  await supabaseAdmin.from("customer_memberships").upsert({
    user_id: input.userId,
    tier_id: tier.id,
    billing_cycle: "monthly",
    status: chargeResult.success ? "trialing" : "past_due",
    started_at: now.toISOString(),
    intro_status: "active",
    intro_started_at: now.toISOString(),
    intro_ends_at: introEndsAt.toISOString(),
    intro_charge_amount_cents: introChargeCents,
    first_month_remainder_cents: remainderCents,
    next_billing_at: introEndsAt.toISOString(),
    next_billing_amount_cents: remainderCents,
    cancel_at_period_end: false,
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });

  if (!chargeResult.success) {
    await handleChargeFailure({ userId: input.userId, tier, amountCents: introChargeCents, eventType: "intro_charge", error: chargeResult.error });
    return { success: false };
  }

  await recordBillingEvent({ userId: input.userId, tierId: tier.id, eventType: "intro_charge", amountCents: introChargeCents, status: "succeeded", providerChargeId: chargeResult.providerChargeId });

  if (contact) {
    await sendMarketingEmail({
      to: contact.email,
      campaignType: "membership_welcome",
      referenceId: input.userId,
      templateKey: "membershipWelcomeTemplate",
      ...membershipWelcomeTemplate({ name: contact.name, tierName: tier.name }),
    });

    await sendEmail({
      to: contact.email,
      ...membershipTrialConfirmationTemplate({
        name: contact.name,
        tierName: tier.name,
        introChargeCents,
        remainderCents,
        remainderChargeDate: introEndsAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
        monthlyPriceCents: tier.monthly_price_cents,
      }),
    });
  }

  return { success: true };
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

  const { error } = await supabaseAdmin
    .from("customer_memberships")
    // Non-refundable: we stop auto-renewal and let access run to the end of
    // the already-paid term. We never issue a refund here for either cycle.
    .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) throw error;

  await recordBillingEvent({ userId, tierId: existing.tier_id, eventType: "cancellation", amountCents: 0, status: "succeeded" });

  const billingCycle = (existing.billing_cycle as "monthly" | "annual" | "free") ?? "monthly";
  const accessUntil = (existing.next_billing_at as string | null) ?? (existing.renews_at as string | null) ?? null;

  return { billingCycle, accessUntil, refundable: false };
}

export async function updatePaymentMethod(userId: string, paymentMethodRef: string) {
  const { error } = await supabaseAdmin
    .from("customer_memberships")
    .update({ payment_method_ref: paymentMethodRef, status: "active", updated_at: new Date().toISOString() })
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
  const { data, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("user_id, status, membership_tiers(slug, monthly_store_credit_cents)")
    .in("status", ["active", "trialing"]);

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
      .eq("status", "trialing")
      .eq("intro_status", "active")
      .is("first_month_reminder_sent_at", null)
      .lte("intro_ends_at", in3Days.toISOString())
      .gt("intro_ends_at", now.toISOString());

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
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
      await supabaseAdmin.from("customer_memberships").update({ first_month_reminder_sent_at: now.toISOString() }).eq("user_id", row.user_id);
      result.remainderRemindersSent += 1;
    }
  }

  // Step 2: the first-month remainder charge itself, once the intro period ends.
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
      .eq("status", "trialing")
      .eq("intro_status", "active")
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
      .eq("status", "active")
      .eq("cancel_at_period_end", false)
      .is("renewal_reminder_sent_at", null)
      .lte("next_billing_at", in3Days.toISOString())
      .gt("next_billing_at", now.toISOString());

    if (error) throw error;

    for (const row of (data ?? []) as unknown as DueMembershipRow[]) {
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
      await supabaseAdmin.from("customer_memberships").update({ renewal_reminder_sent_at: now.toISOString() }).eq("user_id", row.user_id);
      result.renewalRemindersSent += 1;
    }
  }

  // Step 5: the monthly renewal charge itself.
  {
    const { data, error } = await supabaseAdmin
      .from("customer_memberships")
      .select(DUE_ROW_SELECT)
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
