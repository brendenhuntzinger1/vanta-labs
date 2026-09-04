import { supabaseAdmin } from "@/lib/supabase-server";
import { businessCalendarDate } from "@/lib/business-day";
import { getControlSnapshot } from "@/lib/admin-control";
import { calculateEarnedPoints, dollarsToPoints, pointsToDollars, POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";
import { getStoreCreditBalanceCents } from "@/lib/store-credit";
import { isMembershipActive } from "@/lib/membership-status";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { membershipBirthdayTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";

export { isMembershipActive } from "@/lib/membership-status";

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
  "tier_id, billing_cycle, status, started_at, renews_at, intro_status, intro_ends_at, next_billing_at, next_billing_amount_cents, cancel_at_period_end, payment_method_ref, veyra_membership_id, membership_tiers(*)";

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
    // A card can live in EITHER place: payment_method_ref for the legacy lane,
    // or vaulted at the processor for a recurring subscription, where we hold
    // only veyra_membership_id. Checking one field told a member who had just
    // paid — and whose card is on file for renewals — "Not connected yet".
    hasPaymentMethod: Boolean(data.payment_method_ref) || Boolean(data.veyra_membership_id),
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
// member stops paying (status leaves active/trialing, or the paid period ends)
// every perk switches off automatically.
export async function getMembershipPerks(userId: string): Promise<MembershipPerks> {
  const membership = await getCustomerMembership(userId);
  const active = isMembershipActive(membership);
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
  if (isMembershipActive(membership)) {
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
  if (!isMembershipActive(membership)) {
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
  return membership.tier.priorityShipping && isMembershipActive(membership);
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

/**
 * Was this write refused because the row it would have created ALREADY EXISTS?
 *
 * The refund reversals below are exactly-once per (order_id, reason), and until
 * now the only thing enforcing that was a SELECT immediately before the INSERT
 * (`ledgerRowExists`). Read-then-insert is not exactly-once: the webhook's
 * refund branch and the half-hourly refund sweep can — and on a slow refund do
 * — both read "no row", and both insert. The customer is then credited twice
 * for one refund.
 *
 * `idx_points_ledger_order_refund_once` (sql/refund-exactly-once-indexes.sql)
 * closes that window in the database, where the race actually lives. This
 * helper is the other half: the loser of the race gets 23505, and 23505 on
 * these reasons means "somebody else already applied this refund effect",
 * which is the same answer the guard above would have given a moment later.
 * It is a NO-OP, not a failure — reporting it as a failure would have the
 * sweep alerting on refunds that are, in fact, correctly applied.
 */
export function isDuplicateLedgerRow(error: unknown): boolean {
  return String((error as { code?: unknown } | null)?.code ?? "") === "23505";
}

/**
 * HAS THIS ORDER ALREADY GOT A LEDGER ROW FOR THIS REASON?
 *
 * TWO DEFECTS IN ONE LINE LIVED HERE, THREE TIMES OVER.
 *
 * 1. `const { data: existing } = await ...` discarded the read's error.
 *    PostgREST resolves `{ data: null, error }` for a statement timeout or a
 *    pooler blip, which is byte-identical to "no row exists" — so the guard
 *    failed OPEN and the caller inserted a second debit or credit.
 * 2. `.maybeSingle()` returns `{ data: null, error: PGRST116 }` when MORE THAN
 *    ONE row matches (verified against the installed @supabase/postgrest-js).
 *    So the first duplicate permanently disabled the guard for that order and
 *    every later call added another row — the failure amplified itself.
 *
 * `.limit(1)` answers the only question a guard has ("is there at least one?")
 * and cannot fail on a duplicate, and the error is now the answer "I could not
 * tell", which is never the same as "no".
 */
async function ledgerRowExists(orderId: string, reason: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("points_ledger")
    .select("id")
    .eq("order_id", orderId)
    .eq("reason", reason)
    .limit(1);

  if (error) throw error;
  return Boolean(data && data.length > 0);
}

/**
 * The ledger reason a points spend against an order is written under.
 *
 * Exported for the same reason as STORE_CREDIT_REDEMPTION_REASON: the
 * checkout-time hold (tender-reservation.ts) writes this very row, so the two
 * modules must agree on which rows mean "these points are spoken for".
 */
export const POINTS_REDEMPTION_REASON = "redeem";

// Records a points REDEMPTION debit for an order, capped to the customer's LIVE
// balance and idempotent per order — mirroring redeemStoreCredit. This prevents
// two concurrent pending orders that each froze the same balance from
// over-redeeming it (which would otherwise drive the ledger negative and hand
// out more discount than the customer had points for), and prevents a webhook
// retry from double-debiting.
//
// Checkout now HOLDS the points when the order is created, so the guard below
// is usually what runs at settlement: the debit is already on the ledger and
// this is a no-op. An order whose hold was released still debits here.
export async function redeemPoints(userId: string, points: number, orderId: string): Promise<void> {
  const requested = Math.floor(Number(points));
  if (!userId || !Number.isFinite(requested) || requested <= 0) {
    return;
  }

  // Idempotent: if this order already recorded a redemption, don't debit again.
  if (await ledgerRowExists(orderId, POINTS_REDEMPTION_REASON)) {
    return;
  }

  const liveBalance = await getPointsBalance(userId);
  const toRedeem = Math.min(requested, Math.max(0, liveBalance));
  if (toRedeem <= 0) {
    return;
  }

  await recordPointsLedgerEntry({ userId, amount: -toRedeem, reason: POINTS_REDEMPTION_REASON, orderId });
}

// Claws back the points a specific order earned. This is a simple full
// reversal (not FIFO-aware of what's since been redeemed), so a customer's
// balance can go negative if they already redeemed those points elsewhere -
// same tradeoff most lightweight loyalty programs accept rather than
// blocking redemption entirely.
/**
 * RETURNS WHETHER A REVERSAL ROW WAS ACTUALLY WRITTEN. An order with no
 * customer_user_id (a guest checkout) can never have points reversed — there is
 * no account to debit — so this returns early, and a caller that counted that
 * as a repair would report one every time it ran.
 */
export async function reverseOrderPoints(orderId: string): Promise<boolean> {
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
    return false;
  }

  // Idempotent: a repeated refund/chargeback event for the same order (distinct
  // event_ids both mapping to "refunded", or a refund followed by a chargeback)
  // must not claw back the earned points twice. Mirror restoreRedeemedPoints's
  // existing-row guard.
  if (await ledgerRowExists(orderId, "order_refund_reversal")) {
    return false;
  }

  try {
    await recordPointsLedgerEntry({
      userId: String(order.customer_user_id),
      amount: -pointsEarned,
      reason: "order_refund_reversal",
      orderId,
    });
  } catch (error) {
    // Lost the race to a concurrent webhook/sweep — see isDuplicateLedgerRow.
    // The reversal exists, it just was not written by this caller.
    if (isDuplicateLedgerRow(error)) return false;
    throw error;
  }
  return true;
}

/**
 * Re-credits the loyalty points a customer ACTUALLY SPENT on an order when that
 * order is fully refunded. Without this, a refunded customer loses the points
 * they redeemed for a discount even though the discount is being undone.
 *
 * RESTORE WHAT THE LEDGER SAYS WAS DEBITED, NOT WHAT THE ORDER INTENDED TO
 * SPEND. `orders.points_redeemed` is written by upsertOrderRecord BEFORE any
 * debit is attempted, and the debit that follows can legitimately be smaller
 * (redeemPoints clamps to the live balance) or never happen at all (the order
 * has no account, it is a membership order, or the ledger insert failed — which
 * this branch classifies as alert-only and survivable). Crediting the order
 * column back therefore created points out of nothing: a customer whose
 * redemption failed kept the discount AND was handed the points on refund, and
 * the refund sweep applied exactly that across a 90-day backlog automatically.
 *
 * Idempotent: a second refund call for the same order will not double-credit.
 * Returns whether a restore row was actually written — a guest order, or an
 * order whose points were never debited, has nothing to restore and never will.
 */
export async function restoreRedeemedPoints(orderId: string): Promise<boolean> {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("customer_user_id, points_redeemed")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!order?.customer_user_id) {
    return false;
  }

  if (await ledgerRowExists(orderId, "order_refund_points_restore")) {
    return false;
  }

  // The debit itself, from the ledger. Summed rather than read singly so a
  // historical duplicate cannot make this read fail, and so the figure restored
  // is exactly the figure taken.
  const { data: debits, error: debitError } = await supabaseAdmin
    .from("points_ledger")
    .select("amount")
    .eq("order_id", orderId)
    .eq("reason", POINTS_REDEMPTION_REASON);

  if (debitError) throw debitError;

  const debited = (debits ?? []).reduce(
    (sum, row) => sum + Math.abs(Number((row as { amount?: unknown }).amount ?? 0)),
    0,
  );
  if (debited <= 0) {
    return false;
  }

  try {
    await recordPointsLedgerEntry({
      userId: String(order.customer_user_id),
      amount: debited,
      reason: "order_refund_points_restore",
      orderId,
    });
  } catch (error) {
    // Same race, same answer: the restore is already on the ledger.
    if (isDuplicateLedgerRow(error)) return false;
    throw error;
  }
  return true;
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

  // The referrer earns their PAID tier's referral bonus only while their
  // membership is actually active; a lapsed/expired member drops to the free
  // tier's bonus (so they can't keep earning an elite-tier bonus after they
  // stopped paying).
  const referrerMembership = await getCustomerMembership(referrerUserId);
  const referrerBonusPoints = isMembershipActive(referrerMembership)
    ? referrerMembership.tier.referralBonusPoints
    : (await getFreeTier())?.referralBonusPoints ?? 0;
  if (referrerBonusPoints > 0) {
    await recordPointsLedgerEntry({
      userId: referrerUserId,
      amount: referrerBonusPoints,
      reason: "referral_bonus",
      metadata: { role: "referrer", referredUserId: newUserId },
    });
  }
}

// Lazy check meant to run whenever a customer visits their dashboard: since
// there's no scheduled job runner in this app, birthdays are checked
// on-demand rather than by a daily cron.
/**
 * Grant and announce every birthday bonus due today.
 *
 * THE PROMISE THE SETTINGS PAGE MADE AND NOBODY KEPT.
 *
 * Saving a birthday answers "Birthday saved. We'll send a bonus on your next
 * one!", and the field is captioned "add your birthday for a rewards bonus on
 * the day". Neither was true. checkAndAwardBirthdayBonus had exactly one caller
 * — the /account dashboard page render — and returns false unless today IS the
 * birthday, so the bonus landed only if the customer happened to open their
 * dashboard during that one UTC day. No email was ever sent: the birthday
 * template had zero production callers.
 *
 * So a customer handed over their date of birth on an explicit promise of an
 * email and points, and in the ordinary case received neither. The window shut
 * at UTC midnight and nothing retried.
 *
 * The function's own comment blamed "no scheduled job runner in this app",
 * which is stale — the sweep runs twenty-odd jobs, several of which mail. This
 * is the birthday one. It reuses the same per-year guard, so a customer who
 * DOES open their dashboard first is not paid twice.
 *
 * The email is MARKETING, not transactional: it is a gift announcement, so it
 * goes through sendMarketingEmail, which honours suppression and appends the
 * unsubscribe footer. Suppression stops the mail, never the points — the bonus
 * is owed either way.
 */
export async function runBirthdayBonusSweep(): Promise<{ granted: number; emailed: number }> {
  const settings = await getMembershipBonusSettings();
  if (!settings.birthdayBonusEnabled) {
    return { granted: 0, emailed: 0 };
  }

  // TODAY in the store's zone; the birthday itself stays on its UTC accessors
  // because `birthday` is a DATE column, and "1990-05-14" parses to UTC
  // midnight — reading THAT in Eastern would walk it back to May 13th.
  //
  // On UTC, a birthday started at 8pm ET the evening before and ended at 8pm ET
  // on the day itself, so the bonus and its email arrived a day early for
  // anyone who checked in the evening, and were gone by dinner on the day.
  const today = new Date();
  const { year: currentYear, month, day } = businessCalendarDate(today);

  // Read every stored birthday and match on month/day here. `birthday` is a
  // date, so "same day in any year" is not something a simple column filter can
  // express, and this table is small enough that the alternative — a SQL
  // function to maintain alongside it — buys nothing.
  const { data, error } = await supabaseAdmin
    .from("customer_preferences")
    .select("user_id, birthday, birthday_bonus_year")
    .not("birthday", "is", null);

  if (error) {
    console.error("[membership] birthday sweep could not read preferences", error);
    return { granted: 0, emailed: 0 };
  }

  let granted = 0;
  let emailed = 0;

  for (const row of data ?? []) {
    const birthday = new Date(String(row.birthday));
    if (Number.isNaN(birthday.getTime())) continue;
    if (birthday.getUTCMonth() + 1 !== month || birthday.getUTCDate() !== day) continue;
    if (Number(row.birthday_bonus_year) === currentYear) continue;

    const userId = String(row.user_id);
    try {
      await recordPointsLedgerEntry({
        userId,
        amount: settings.birthdayBonusPoints,
        reason: "birthday_bonus",
      });
      await supabaseAdmin
        .from("customer_preferences")
        .upsert(
          { user_id: userId, birthday_bonus_year: currentYear, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
      granted += 1;
    } catch (grantError) {
      // One customer's failure must not stop the rest of the day's birthdays.
      console.error("[membership] birthday bonus could not be granted", userId, grantError);
      continue;
    }

    // The points are banked. The email is a courtesy on top and is never
    // allowed to undo them.
    try {
      const { data: account } = await supabaseAdmin.auth.admin.getUserById(userId);
      const email = account?.user?.email;
      if (!email) continue;
      const fullName = typeof account?.user?.user_metadata?.full_name === "string"
        ? account.user.user_metadata.full_name
        : "";
      const result = await sendMarketingEmail({
        to: email,
        campaignType: "membership_birthday",
        onDeferred: "queue",
        templateKey: "membership_birthday",
        ...membershipBirthdayTemplate({
          name: fullName.trim().split(/\s+/)[0] ?? "",
          bonusPoints: settings.birthdayBonusPoints,
          // Points with nowhere to spend them is the whole complaint about
          // this email. The catalog is the shortest path to using them.
          rewardUrl: `${getSiteUrl().replace(/\/$/, "")}/products`,
        }),
      });
      if (result.success) emailed += 1;
    } catch (mailError) {
      console.error("[membership] birthday email failed", userId, mailError);
    }
  }

  return { granted, emailed };
}

export async function checkAndAwardBirthdayBonus(userId: string, birthday: string | null) {
  if (!birthday) {
    return false;
  }

  const settings = await getMembershipBonusSettings();
  if (!settings.birthdayBonusEnabled) {
    return false;
  }

  // Same split as the sweep: today in the store's zone, the stored birthday on
  // its UTC accessors because it is a plain date.
  const { year: currentYear, month, day } = businessCalendarDate();
  const birthdayDate = new Date(birthday);
  const isBirthdayToday = month === birthdayDate.getUTCMonth() + 1 && day === birthdayDate.getUTCDate();
  if (!isBirthdayToday) {
    return false;
  }

  // Same rule as every other already-granted guard here: a read that failed is
  // not a year with no bonus in it. Throwing leaves the caller's .catch() to
  // skip this page load; the customer's next visit today grants it once.
  const { data, error: bonusYearError } = await supabaseAdmin
    .from("customer_preferences")
    .select("birthday_bonus_year")
    .eq("user_id", userId)
    .maybeSingle();

  if (bonusYearError) throw bonusYearError;

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
