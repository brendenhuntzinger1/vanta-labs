import { supabaseAdmin } from "@/lib/supabase-server";
import { getControlSnapshot } from "@/lib/admin-control";
import { calculateEarnedPoints, dollarsToPoints, pointsToDollars, POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";
import { getStoreCreditBalanceCents } from "@/lib/store-credit";

export interface MembershipBonusSettings {
  signupBonusEnabled: boolean;
  referralBonusEnabled: boolean;
  birthdayBonusEnabled: boolean;
  signupBonusPoints: number;
  referralSignupBonusPoints: number;
  birthdayBonusPoints: number;
}

const DEFAULT_SIGNUP_BONUS_POINTS = 200;
const DEFAULT_REFERRAL_SIGNUP_BONUS_POINTS = 100;
const DEFAULT_BIRTHDAY_BONUS_POINTS = 150;

// Bonus enable/disable + amount overrides live in the same generic admin
// config store as homepage/promotions settings (src/lib/admin-control.ts) -
// no new table needed, and it's editable from /admin/membership the same
// way the homepage editor already works.
export async function getMembershipBonusSettings(): Promise<MembershipBonusSettings> {
  const snapshot = await getControlSnapshot("membership");
  const config = snapshot.membership ?? {};

  return {
    signupBonusEnabled: config.signup_bonus_enabled !== false,
    referralBonusEnabled: config.referral_bonus_enabled !== false,
    birthdayBonusEnabled: config.birthday_bonus_enabled !== false,
    signupBonusPoints: Number(config.signup_bonus_points ?? DEFAULT_SIGNUP_BONUS_POINTS),
    referralSignupBonusPoints: Number(config.referral_bonus_points ?? DEFAULT_REFERRAL_SIGNUP_BONUS_POINTS),
    birthdayBonusPoints: Number(config.birthday_bonus_points ?? DEFAULT_BIRTHDAY_BONUS_POINTS),
  };
}

export { calculateEarnedPoints, dollarsToPoints, pointsToDollars, POINTS_PER_DOLLAR_REDEMPTION };

export interface MembershipTier {
  id: string;
  slug: string;
  name: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  pointsPerDollar: number;
  freeShipping: boolean;
  priorityShipping: boolean;
  earlyAccess: boolean;
  exclusivePricing: boolean;
  referralBonusPoints: number;
  benefits: string[];
  position: number;
  isActive: boolean;
  introPriceCents: number;
  introDurationDays: number;
  introOfferEnabled: boolean;
  memberDiscountPercent: number;
  monthlyStoreCreditCents: number;
  storeCreditMinOrderCents: number;
  compareMonthlyPriceCents: number;
}

function mapTier(row: Record<string, unknown>): MembershipTier {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    monthlyPriceCents: Number(row.monthly_price_cents ?? 0),
    annualPriceCents: Number(row.annual_price_cents ?? 0),
    pointsPerDollar: Number(row.points_per_dollar ?? 1),
    freeShipping: Boolean(row.free_shipping),
    priorityShipping: Boolean(row.priority_shipping),
    earlyAccess: Boolean(row.early_access),
    exclusivePricing: Boolean(row.exclusive_pricing),
    referralBonusPoints: Number(row.referral_bonus_points ?? 0),
    benefits: Array.isArray(row.benefits) ? (row.benefits as string[]) : [],
    position: Number(row.position ?? 0),
    isActive: Boolean(row.is_active),
    introPriceCents: Number(row.intro_price_cents ?? 100),
    introDurationDays: Number(row.intro_duration_days ?? 7),
    introOfferEnabled: Boolean(row.intro_offer_enabled ?? true),
    memberDiscountPercent: Number(row.member_discount_percent ?? 0),
    monthlyStoreCreditCents: Number(row.monthly_store_credit_cents ?? 0),
    storeCreditMinOrderCents: Number(row.store_credit_min_order_cents ?? 0),
    compareMonthlyPriceCents: Number(row.compare_monthly_price_cents ?? 0),
  };
}

export async function getActiveMembershipTiers(): Promise<MembershipTier[]> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("*")
    .eq("is_active", true)
    .order("position", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(mapTier);
}

export async function getTierBySlug(slug: string): Promise<MembershipTier | null> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapTier(data) : null;
}

export async function getFreeTier(): Promise<MembershipTier | null> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("*")
    .eq("slug", "free")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapTier(data) : null;
}

export interface CustomerMembership {
  tier: MembershipTier;
  billingCycle: "monthly" | "annual" | "free";
  status: "active" | "paused" | "cancelled" | "trialing" | "past_due";
  startedAt: string;
  renewsAt: string | null;
  introStatus: "not_applicable" | "active" | "converted" | "failed";
  introEndsAt: string | null;
  nextBillingAt: string | null;
  nextBillingAmountCents: number | null;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
}

const MEMBERSHIP_SELECT_FIELDS =
  "tier_id, billing_cycle, status, started_at, renews_at, intro_status, intro_ends_at, next_billing_at, next_billing_amount_cents, cancel_at_period_end, payment_method_ref, membership_tiers(*)";

function mapCustomerMembership(data: Record<string, unknown>): CustomerMembership {
  return {
    tier: mapTier(data.membership_tiers as unknown as Record<string, unknown>),
    billingCycle: (data.billing_cycle as CustomerMembership["billingCycle"]) ?? "monthly",
    status: (data.status as CustomerMembership["status"]) ?? "active",
    startedAt: String(data.started_at),
    renewsAt: data.renews_at ? String(data.renews_at) : null,
    introStatus: (data.intro_status as CustomerMembership["introStatus"]) ?? "not_applicable",
    introEndsAt: data.intro_ends_at ? String(data.intro_ends_at) : null,
    nextBillingAt: data.next_billing_at ? String(data.next_billing_at) : null,
    nextBillingAmountCents: data.next_billing_amount_cents !== null && data.next_billing_amount_cents !== undefined ? Number(data.next_billing_amount_cents) : null,
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
    hasPaymentMethod: Boolean(data.payment_method_ref),
  };
}

// Every registered customer is a Research Member (free tier) by default -
// there is no row in customer_memberships until they upgrade, so this
// synthesizes one from the free tier rather than requiring a signup-time
// insert for every account.
export interface MembershipPerks {
  isActiveMember: boolean;
  tierSlug: string;
  memberDiscountPercent: number;
  freeShipping: boolean;
  pointsPerDollar: number;
  storeCreditBalanceCents: number;
  storeCreditMinOrderCents: number;
}

// The single source of truth for what perks a buyer's account currently
// receives. Discount, free shipping, and store credit apply ONLY while the
// membership is an active paying (or trialing) PAID tier — so the moment a
// member stops paying (status leaves active/trialing) every perk switches off
// automatically. For annual members the status stays active for the paid year.
export async function getMembershipPerks(userId: string): Promise<MembershipPerks> {
  const membership = await getCustomerMembership(userId);
  const active = membership.status === "active" || membership.status === "trialing";
  const isActiveMember = active && membership.tier.slug !== "free";

  const [storeCreditBalanceCents, freeTier] = await Promise.all([
    isActiveMember ? getStoreCreditBalanceCents(userId) : Promise.resolve(0),
    active ? Promise.resolve(null) : getFreeTier(),
  ]);

  return {
    isActiveMember,
    tierSlug: membership.tier.slug,
    memberDiscountPercent: isActiveMember ? membership.tier.memberDiscountPercent : 0,
    freeShipping: isActiveMember && membership.tier.freeShipping,
    // Points rate only comes from the member's tier while their plan is active
    // or trialing; a cancelled/past-due member drops back to the free-tier rate.
    pointsPerDollar: active ? membership.tier.pointsPerDollar : (freeTier?.pointsPerDollar ?? 1),
    storeCreditBalanceCents,
    storeCreditMinOrderCents: isActiveMember ? membership.tier.storeCreditMinOrderCents : 0,
  };
}

// The points-per-dollar rate to actually award on an order, gated on an active
// (or trialing) membership. A lapsed member earns the free-tier rate, never
// their old paid rate.
export async function getActivePointsPerDollar(userId: string): Promise<number> {
  const membership = await getCustomerMembership(userId);
  const active = membership.status === "active" || membership.status === "trialing";
  if (active) {
    return membership.tier.pointsPerDollar;
  }
  const free = await getFreeTier();
  return free?.pointsPerDollar ?? 1;
}

export async function getCustomerMembership(userId: string): Promise<CustomerMembership> {
  const { data, error } = await supabaseAdmin
    .from("customer_memberships")
    .select(MEMBERSHIP_SELECT_FIELDS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data && data.membership_tiers) {
    return mapCustomerMembership(data as unknown as Record<string, unknown>);
  }

  const freeTier = await getFreeTier();
  if (!freeTier) {
    throw new Error("Free membership tier is not configured");
  }

  return {
    tier: freeTier,
    billingCycle: "free",
    status: "active",
    startedAt: new Date().toISOString(),
    renewsAt: null,
    introStatus: "not_applicable",
    introEndsAt: null,
    nextBillingAt: null,
    nextBillingAmountCents: null,
    cancelAtPeriodEnd: false,
    hasPaymentMethod: false,
  };
}

// "Exclusive Buy In Bulk Savings" is scoped to the highest tier (by
// position) and only to members with an actual active-paying subscription
// - trial members (status "trialing") don't qualify yet.
export async function isEligibleForBulkSavings(userId: string): Promise<boolean> {
  const membership = await getCustomerMembership(userId);
  if (membership.status !== "active" && membership.status !== "trialing") {
    return false;
  }
  // Bulk savings apply to the Elite and Black tiers (the tiers whose plans
  // advertise "Exclusive Bulk Discounts"). Tied to the account's active tier.
  return membership.tier.slug === "elite" || membership.tier.slug === "black";
}

// Priority order processing - a real operational signal (orders.priority),
// not just marketing copy, so fulfillment staff can actually filter by it.
export async function isPriorityMember(userId: string): Promise<boolean> {
  const membership = await getCustomerMembership(userId);
  return membership.tier.priorityShipping && (membership.status === "active" || membership.status === "trialing");
}

export async function getActivePointsMultiplier(): Promise<{ multiplier: number; eventName: string | null }> {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("promotional_point_events")
    .select("name, multiplier")
    .eq("is_active", true)
    .lte("starts_at", nowIso)
    .gte("ends_at", nowIso)
    .order("multiplier", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data
    ? { multiplier: Number(data.multiplier ?? 1), eventName: String(data.name) }
    : { multiplier: 1, eventName: null };
}


export async function getPointsBalance(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("points_ledger")
    .select("amount")
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

  return (data ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
}

export interface PointsLedgerEntry {
  id: string;
  amount: number;
  reason: string;
  orderId: string | null;
  createdAt: string;
}

export async function getPointsHistory(userId: string, limit = 50): Promise<PointsLedgerEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("points_ledger")
    .select("id, amount, reason, order_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    amount: Number(row.amount ?? 0),
    reason: String(row.reason),
    orderId: row.order_id ? String(row.order_id) : null,
    createdAt: String(row.created_at),
  }));
}

export async function recordPointsLedgerEntry(input: {
  userId: string;
  amount: number;
  reason: string;
  orderId?: string;
  metadata?: Record<string, unknown>;
}) {
  if (input.amount === 0) {
    return;
  }

  const { error } = await supabaseAdmin.from("points_ledger").insert({
    user_id: input.userId,
    amount: Math.round(input.amount),
    reason: input.reason,
    order_id: input.orderId ?? null,
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

// Claws back the points a specific order earned. This is a simple full
// reversal (not FIFO-aware of what's since been redeemed), so a customer's
// balance can go negative if they already redeemed those points elsewhere -
// same tradeoff most lightweight loyalty programs accept rather than
// blocking redemption entirely.
export async function reverseOrderPoints(orderId: string) {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("customer_user_id, points_earned")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const pointsEarned = Number(order?.points_earned ?? 0);
  if (!order?.customer_user_id || pointsEarned <= 0) {
    return;
  }

  await recordPointsLedgerEntry({
    userId: String(order.customer_user_id),
    amount: -pointsEarned,
    reason: "order_refund_reversal",
    orderId,
  });
}

export async function getReferralEarnedPoints(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("points_ledger")
    .select("amount, metadata")
    .eq("user_id", userId)
    .eq("reason", "referral_bonus");

  if (error) {
    throw error;
  }

  return (data ?? [])
    .filter((row) => (row.metadata as Record<string, unknown> | null)?.role === "referrer")
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
}

// A simple, always-meaningful progress indicator: how close the customer
// is to their next $5-increment reward (500 points), regardless of tier.
export function getProgressToNextReward(pointsBalance: number) {
  const milestone = 500;
  const currentMilestoneBase = Math.floor(pointsBalance / milestone) * milestone;
  const pointsIntoMilestone = pointsBalance - currentMilestoneBase;
  const nextMilestone = currentMilestoneBase + milestone;

  return {
    pointsIntoMilestone,
    milestone,
    nextMilestone,
    progressPercent: Math.round((pointsIntoMilestone / milestone) * 100),
  };
}

async function hasLedgerEntryWithReason(userId: string, reason: string) {
  const { data, error } = await supabaseAdmin
    .from("points_ledger")
    .select("id")
    .eq("user_id", userId)
    .eq("reason", reason)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

// Idempotent - safe to call on every login, since it checks the ledger for
// a prior award before writing a new one.
export async function awardSignupBonusIfNeeded(userId: string) {
  const settings = await getMembershipBonusSettings();
  if (!settings.signupBonusEnabled) {
    return;
  }

  const alreadyAwarded = await hasLedgerEntryWithReason(userId, "signup_bonus");
  if (alreadyAwarded) {
    return;
  }

  await recordPointsLedgerEntry({
    userId,
    amount: settings.signupBonusPoints,
    reason: "signup_bonus",
  });
}

// Awards both sides of a referral once, at the referred customer's signup:
// the new customer gets a flat bonus, and whoever referred them gets their
// own membership tier's referral bonus. Idempotent per new customer.
export async function awardReferralSignupBonus(newUserId: string, referrerUserId: string) {
  const settings = await getMembershipBonusSettings();
  if (!settings.referralBonusEnabled) {
    return;
  }

  const alreadyAwarded = await hasLedgerEntryWithReason(newUserId, "referral_bonus");
  if (alreadyAwarded) {
    return;
  }

  await recordPointsLedgerEntry({
    userId: newUserId,
    amount: settings.referralSignupBonusPoints,
    reason: "referral_bonus",
    metadata: { role: "referred" },
  });

  const referrerMembership = await getCustomerMembership(referrerUserId);
  if (referrerMembership.tier.referralBonusPoints > 0) {
    await recordPointsLedgerEntry({
      userId: referrerUserId,
      amount: referrerMembership.tier.referralBonusPoints,
      reason: "referral_bonus",
      metadata: { role: "referrer", referredUserId: newUserId },
    });
  }
}

// Lazy check meant to run whenever a customer visits their dashboard: since
// there's no scheduled job runner in this app, birthdays are checked
// on-demand rather than by a daily cron.
export async function checkAndAwardBirthdayBonus(userId: string, birthday: string | null) {
  if (!birthday) {
    return false;
  }

  const settings = await getMembershipBonusSettings();
  if (!settings.birthdayBonusEnabled) {
    return false;
  }

  const today = new Date();
  const birthdayDate = new Date(birthday);
  const isBirthdayToday = today.getUTCMonth() === birthdayDate.getUTCMonth() && today.getUTCDate() === birthdayDate.getUTCDate();
  if (!isBirthdayToday) {
    return false;
  }

  const currentYear = today.getUTCFullYear();
  const { data } = await supabaseAdmin
    .from("customer_preferences")
    .select("birthday_bonus_year")
    .eq("user_id", userId)
    .maybeSingle();

  if (Number(data?.birthday_bonus_year) === currentYear) {
    return false;
  }

  await recordPointsLedgerEntry({
    userId,
    amount: settings.birthdayBonusPoints,
    reason: "birthday_bonus",
  });

  await supabaseAdmin
    .from("customer_preferences")
    .upsert({ user_id: userId, birthday_bonus_year: currentYear, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  return true;
}
