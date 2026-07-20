import { supabaseAdmin } from "@/lib/supabase-server";
import { getControlSnapshot } from "@/lib/admin-control";
import { calculateEarnedPoints, dollarsToPoints, pointsToDollars, POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";

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
  status: "active" | "paused" | "cancelled";
  startedAt: string;
  renewsAt: string | null;
}

// Every registered customer is a Research Member (free tier) by default -
// there is no row in customer_memberships until they upgrade, so this
// synthesizes one from the free tier rather than requiring a signup-time
// insert for every account.
export async function getCustomerMembership(userId: string): Promise<CustomerMembership> {
  const { data, error } = await supabaseAdmin
    .from("customer_memberships")
    .select("tier_id, billing_cycle, status, started_at, renews_at, membership_tiers(*)")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data && data.membership_tiers) {
    return {
      tier: mapTier(data.membership_tiers as unknown as Record<string, unknown>),
      billingCycle: (data.billing_cycle as CustomerMembership["billingCycle"]) ?? "monthly",
      status: (data.status as CustomerMembership["status"]) ?? "active",
      startedAt: String(data.started_at),
      renewsAt: data.renews_at ? String(data.renews_at) : null,
    };
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
  };
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
