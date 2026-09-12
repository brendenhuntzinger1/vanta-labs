// The rewards (loyalty points) programme.
//
// This file used to be `membership.ts` and held TWO features: the paid
// membership tiers, and the points programme below. The paid half was removed
// on 2026-09-12 (see docs/MEMBERSHIP-REMOVAL-AND-RESTORE.md); the points half
// is unchanged and lives on here.
//
// The `membership_tiers` table SURVIVES that removal, because the free
// "Research Member" row is where every customer's baseline points rate is
// configured. Reading one row of it is the only tie left to that table.

import { supabaseAdmin } from "@/lib/supabase-server";
import { businessCalendarDate } from "@/lib/business-day";
import { getControlSnapshot } from "@/lib/admin-control";
import { calculateEarnedPoints, dollarsToPoints, pointsToDollars, POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { membershipBirthdayTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";

export interface RewardsBonusSettings {
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
// no new table needed, and it's edited from /admin/settings.
//
// THE "membership" NAMESPACE IS DELIBERATE AND MUST NOT BE RENAMED. These
// values are already stored under it in admin_control; renaming the namespace
// would orphan every setting the owner has saved and silently revert all six
// to their defaults. The namespace is a storage key, not a feature name.
export async function getRewardsBonusSettings(): Promise<RewardsBonusSettings> {
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

/**
 * The baseline points-per-dollar rate every customer earns at.
 *
 * This used to be tier-dependent: a paying member earned their tier's rate
 * while active, and dropped back to the free tier's rate the moment they
 * stopped paying. With paid tiers removed there is only the free tier, so the
 * rate is the same for everyone — which is exactly what the old code already
 * returned for every non-paying customer.
 *
 * The rate is still CONFIGURABLE rather than hardcoded, because it always was:
 * it is the `points_per_dollar` column on the free "Research Member" row. A
 * missing row falls back to 1x rather than throwing, so a misconfigured
 * database cannot take down checkout — it just stops earning bonus points.
 */
export async function getPointsRate(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("points_per_dollar")
    .eq("slug", "free")
    .maybeSingle();

  if (error) {
    throw error;
  }

  const rate = Number((data as { points_per_dollar?: unknown } | null)?.points_per_dollar ?? 1);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * The referral bonus a REFERRER earns, from the same free-tier row.
 *
 * Previously an active paid member earned their own tier's referral bonus and
 * everyone else earned the free tier's. Only the free tier remains.
 */
async function getReferrerBonusPoints(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("referral_bonus_points")
    .eq("slug", "free")
    .maybeSingle();

  if (error) {
    throw error;
  }

  const points = Number((data as { referral_bonus_points?: unknown } | null)?.referral_bonus_points ?? 0);
  return Number.isFinite(points) && points > 0 ? points : 0;
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
 * has no account, or the ledger insert failed — which
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
  const settings = await getRewardsBonusSettings();
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
// the new customer gets a flat bonus, and whoever referred them gets the
// configured referrer bonus. Idempotent per new customer.
export async function awardReferralSignupBonus(newUserId: string, referrerUserId: string) {
  const settings = await getRewardsBonusSettings();
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

  // The referrer's bonus. This used to depend on whether they held an active
  // PAID tier — an active member earned their own tier's bonus, everyone else
  // the free tier's. With paid tiers gone every referrer earns the free tier's
  // bonus, which is the branch the overwhelming majority always took.
  const referrerBonusPoints = await getReferrerBonusPoints();
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
  const settings = await getRewardsBonusSettings();
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
    console.error("[rewards] birthday sweep could not read preferences", error);
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
      console.error("[rewards] birthday bonus could not be granted", userId, grantError);
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
      console.error("[rewards] birthday email failed", userId, mailError);
    }
  }

  return { granted, emailed };
}

export async function checkAndAwardBirthdayBonus(userId: string, birthday: string | null) {
  if (!birthday) {
    return false;
  }

  const settings = await getRewardsBonusSettings();
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
