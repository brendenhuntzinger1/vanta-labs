import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateReferralCode } from "@/lib/referral-code-utils";
import { validateReferralCodeFormat } from "@/lib/referral-code-validation";
import { isEarnedCommission } from "@/lib/ledger";
import { sendEmail } from "@/lib/email/send";
import {
  ambassadorApplicationReceivedTemplate,
  ambassadorApprovedTemplate,
  ambassadorDeniedTemplate,
  ambassadorPayoutSentTemplate,
  newAmbassadorApplicationTemplate,
  referralCodeAssignedTemplate,
} from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";
import { DEFAULT_REFERRAL_DISCOUNT_PERCENT, getBusinessSettings, getReferralProgramConfig } from "@/lib/admin-control";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { getAmbassadorProgramSettings, getAmbassadorMarketingResources, type AmbassadorMarketingResource } from "@/lib/ambassador-settings";

function formatSupabaseError(error: unknown) {
  if (!error) {
    return "Unknown Supabase error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function assertNoSupabaseError(context: string, error: unknown) {
  if (!error) {
    return;
  }

  throw new Error(`[Supabase] ${context} failed\n${formatSupabaseError(error)}`);
}

export interface PartnerSummary {
  partnerId: string;
  partnerName: string;
  referralCode: string;
  referralLink: string;
  commissionPercent: number;
  // The discount an ambassador's OWN audience receives. Resolved, not raw: an
  // ambassador with no override sees the program default, because that is what
  // their code actually gives -- not a blank.
  customerDiscountPercent: number;
  totalEarnings: number;
  pendingCommissions: number;
  pendingOnlyCommissions: number;
  approvedCommissions: number;
  paidCommissions: number;
  payoutMethod: string | null;
  payoutHandle: string | null;
  totalOrders: number;
  averageOrderValue: number;
  returningCustomerRate: number;
  totalRevenue: number;
  totalClicks: number;
  conversions: number;
  conversionRate: number;
  monthlyCommissions: number;
  recentOrders: Array<{
    orderId: string;
    createdAt: string;
    customerEmail: string | null;
    amountPaid: number;
    paymentStatus: string;
    commissionAmount: number;
    commissionStatus: string;
  }>;
  monthlyRevenueSeries: Array<{ label: string; value: number }>;
  lifetimeRevenueSeries: Array<{ label: string; value: number }>;
  marketingResources: AmbassadorMarketingResource[];
  accountStatus: string;
  payoutHistory: Array<{ id: string; amount: number; note: string | null; createdAt: string }>;
}

export interface AdminPartnerRow {
  id: string;
  name: string;
  email: string | null;
  referralCode: string;
  status: string;
  commissionPercent: number;
  commissionPercentLocked: boolean;
  // What this ambassador's CUSTOMERS save. null means "inherit the program
  // default" -- it is not 0%, and it must never be derived from the commission.
  customerDiscountPercent: number | null;
  totalRevenue: number;
  totalOrders: number;
  totalCommissions: number;
  pendingCommissions: number;
  approvedForPayoutCommissions: number;
  paidCommissions: number;
  reversedCommissions: number;
  clicks: number;
  conversionRate: number;
  updatedAt: string;
  phone: string | null;
  social: string | null;
  followerCount: number | null;
  preferredReferralCode: string | null;
}

export interface AdminOperationsSummary {
  liveSalesToday: number;
  liveSalesMonth: number;
  newCustomers: number;
  returningCustomers: number;
  returningCustomerRate: number;
  lowStockItems: number;
  pendingShipments: number;
  activeCoupons: number;
  pendingNotifications: number;
}

export interface PartnerProgramStats {
  totalCommissionsPaid: number;
  averagePartnerEarnings: number;
  averageApprovalTimeHours: number;
  topPartnerPayout: number;
}

// Fallback floor shown before any admin-configured baseline exists in
// partner_program_stats and before any real activity has happened.
const PRELAUNCH_PARTNER_PROGRAM_STATS: PartnerProgramStats = {
  totalCommissionsPaid: 0,
  averagePartnerEarnings: 0,
  averageApprovalTimeHours: 24,
  topPartnerPayout: 0,
};

export interface PartnerRecord {
  id: string;
  name: string;
  email: string | null;
  referral_code: string;
  status: string;
  commission_percent: number;
  auth_user_id: string | null;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * The first candidate that is a real percentage, falling back to 0 only when
 * every one is absent.
 *
 * numeric(5,2) arrives from postgres as the STRING "15.00", so a plain
 * `?? fallback` keeps it (good) but a truthiness check on Number() would drop a
 * deliberate 0 (bad). Both cases matter here: 0 is a legitimate configured rate
 * an owner may set, while null/undefined/"" means "not configured, look
 * further". Number("") is 0, which is exactly the confusion to avoid.
 */
function firstFinitePercent(candidates: Array<number | string | null | undefined>): number {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === "string" && candidate.trim() === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function isMissingRelationError(error: unknown, relationName: string) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { code?: string; message?: string; details?: string; hint?: string };
  const combined = [maybeError.message, maybeError.details, maybeError.hint]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  return maybeError.code === "42P01" || maybeError.code === "PGRST205" || combined.includes(relationName.toLowerCase());
}

async function enqueueNotification(kind: string, recipient: string, payload: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin
    .from("notification_queue")
    .insert({ kind, recipient, payload, status: "pending" })
    .select("id")
    .single();

  if (error) {
    if (isMissingRelationError(error, "notification_queue")) {
      return undefined;
    }
    assertNoSupabaseError("notification_queue.insert(partner status update)", error);
  }

  return data?.id as string | undefined;
}

async function sendPartnerStatusEmail(input: {
  to: string;
  name: string;
  status: "approved" | "rejected";
  referralCode?: string;
  commissionPercent?: number;
}) {
  let template;
  if (input.status === "approved") {
    // Enrich the approval email with the live program terms so the ambassador
    // gets the full onboarding: their rates, the 14-day hold, biweekly payouts.
    const [referralProgram, ambassadorSettings] = await Promise.all([
      getReferralProgramConfig().catch(() => null),
      getAmbassadorProgramSettings().catch(() => null),
    ]);
    template = ambassadorApprovedTemplate({
      name: input.name,
      referralCode: input.referralCode,
      dashboardUrl: `${getSiteUrl().replace(/\/$/, "")}/account/ambassador`,
      commissionPercent: input.commissionPercent ?? referralProgram?.defaultCommissionPercent,
      personalDiscountPercent: referralProgram?.personalDiscountPercent,
      referralDiscountPercent: referralProgram?.discountPercent,
      holdDays: ambassadorSettings?.commissionHoldDays,
    });
  } else {
    template = ambassadorDeniedTemplate({ name: input.name });
  }

  const result = await sendEmail({ to: input.to, ...template });
  return result.success;
}

// TELLING AN AMBASSADOR THEY EARN 0% IS WORSE THAN NOT WRITING.
//
// commissionPercent used to be a required number and the one call site passed
// `input.commissionPercent ?? 0` — the rate typed in THAT admin request. Assign
// a referral code without re-entering the rate in the same submission and it is
// undefined, so the email told an approved ambassador they earn 0% commission
// while the database held their real rate. It happened: MIZZY was emailed 0%
// with 15.00 stored on both ambassadors and partners.
//
// The rate is resolved HERE rather than at the call site, for the same reason
// the approval email resolves it inside sendPartnerStatusEmail: a caller that
// forgets cannot reintroduce a hole, and there is no longer any way to express
// "email them zero" by omission. An explicit 0 is still honoured — an owner may
// genuinely run a 0% ambassador — but silence now means "look it up".
async function sendReferralCodeAssignedEmail(input: {
  to: string;
  name: string;
  referralCode: string;
  /** The rate just written, if the same request set one. */
  commissionPercent?: number | null;
  /** The ambassador's stored rate, used when this request did not set one. */
  storedCommissionPercent?: number | null;
}) {
  // Program default last: it is what a brand-new ambassador is actually paid
  // when no per-ambassador rate has been set, and it is what the approval email
  // already falls back to. Reaching it means neither rate exists.
  const resolvedPercent = firstFinitePercent([
    input.commissionPercent,
    input.storedCommissionPercent,
    (await getReferralProgramConfig().catch(() => null))?.defaultCommissionPercent,
  ]);

  const template = referralCodeAssignedTemplate({
    name: input.name,
    referralCode: input.referralCode,
    referralLink: `${getSiteUrl()}/r/${input.referralCode}`,
    commissionPercent: resolvedPercent,
  });

  const result = await sendEmail({ to: input.to, ...template });
  return result.success;
}

export async function autoApproveEligibleCommissions() {
  const now = new Date();
  const [ambassadorSettings, referralProgram] = await Promise.all([
    getAmbassadorProgramSettings(),
    getReferralProgramConfig(),
  ]);

  // A global pause or a disabled program stops ALL auto-approval — no accrued
  // commission moves toward payout while either is in effect.
  if (!referralProgram.enabled || referralProgram.commissionsPaused) {
    return;
  }

  const holdPeriodMs = Math.max(1, ambassadorSettings.commissionHoldDays) * 24 * 60 * 60 * 1000;

  const { data: pendingRows, error: pendingError } = await supabaseAdmin
    .from("referral_orders")
    .select("id, order_id, ambassador_id, created_at, payment_status, ineligible_reason, fraud_flag")
    .eq("payment_status", "pending");

  assertNoSupabaseError("referral_orders.select(auto approve pending)", pendingError);

  if (!pendingRows || pendingRows.length === 0) {
    return;
  }

  // Only approved ambassadors' commissions auto-approve. A deactivated/removed
  // ambassador's already-accrued commissions never advance to payable.
  const ambassadorIds = Array.from(
    new Set(pendingRows.map((row) => row.ambassador_id).filter(Boolean)),
  );
  const { data: ambassadorRows, error: ambassadorError } = ambassadorIds.length
    ? await supabaseAdmin.from("ambassadors").select("id, status").in("id", ambassadorIds)
    : { data: [], error: null };
  assertNoSupabaseError("ambassadors.select(auto approve status)", ambassadorError);
  const approvedAmbassadorIds = new Set(
    (ambassadorRows ?? []).filter((row) => row.status === "approved").map((row) => row.id),
  );

  const orderIds = pendingRows.map((row) => row.order_id).filter(Boolean);
  if (orderIds.length === 0) {
    return;
  }

  const { data: orderRows, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("order_id, payment_status")
    .in("order_id", orderIds);

  assertNoSupabaseError("orders.select(auto approve pending)", orderError);

  const orderStatusById = new Map((orderRows ?? []).map((row) => [row.order_id, row.payment_status]));

  const eligibleIds = pendingRows
    .filter((row) => {
      // Orders below the minimum qualifying order, or flagged for fraud
      // review, never auto-approve - an admin has to clear them manually
      // from the Fraud & Review panel.
      if (row.ineligible_reason || row.fraud_flag) {
        return false;
      }

      // Ambassador must still be approved to receive payout.
      if (!row.ambassador_id || !approvedAmbassadorIds.has(row.ambassador_id)) {
        return false;
      }

      const orderStatus = orderStatusById.get(row.order_id);
      if (orderStatus !== "paid") {
        return false;
      }

      const createdAt = new Date(row.created_at).getTime();
      return Number.isFinite(createdAt) && now.getTime() - createdAt >= holdPeriodMs;
    })
    .map((row) => row.id);

  if (eligibleIds.length === 0) {
    return;
  }

  const approvedAt = now.toISOString();

  const { error: approveError } = await supabaseAdmin
    .from("referral_orders")
    .update({ payment_status: "approved_for_payout", approved_for_payout_at: approvedAt, updated_at: approvedAt })
    .in("id", eligibleIds);

  assertNoSupabaseError("referral_orders.update(auto approve)", approveError);

  const { error: mirrorError } = await supabaseAdmin
    .from("commissions")
    .update({ status: "approved_for_payout", updated_at: approvedAt })
    .in("order_id", pendingRows.filter((row) => eligibleIds.includes(row.id)).map((row) => row.order_id));

  assertNoSupabaseError("commissions.update(auto approve)", mirrorError);
}

function toMonthKey(dateIso: string) {
  const date = new Date(dateIso);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function toDateLabel(dateIso: string) {
  return new Date(dateIso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function getApprovedPartnerByAuthUserId(userId: string) {
  const partner = await getPartnerByAuthUserId(userId);
  if (!partner || partner.status !== "approved") {
    return null;
  }

  return partner;
}

export async function getPartnerByAuthUserId(userId: string): Promise<PartnerRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("partners")
    .select("id, name, email, referral_code, status, commission_percent, auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return data;
}

export async function createPartnerApplication(input: {
  authUserId: string;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  social?: string;
  followerCount?: number | null;
  preferredReferralCode?: string;
}) {
  const { data: existingPartner, error: existingPartnerError } = await supabaseAdmin
    .from("partners")
    .select("id, status, referral_code")
    .eq("auth_user_id", input.authUserId)
    .maybeSingle();

  if (existingPartnerError) {
    assertNoSupabaseError("partners.select(existing by auth_user_id)", existingPartnerError);
  }

  if (existingPartner) {
    return {
      partnerId: existingPartner.id,
      status: existingPartner.status,
      referralCode: existingPartner.referral_code,
    };
  }

  const partnerId = randomUUID();
  const now = new Date().toISOString();

  // Honor the applicant's preferred referral code when it's provided and not
  // already taken; otherwise fall back to an auto-generated one. The admin can
  // still override it at approval.
  const preferred = (input.preferredReferralCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  let referralCode = generateReferralCode(input.name);
  // A7: validate the applicant's preferred code the same way self-service code
  // changes are (reserved words like ADMIN/PAYOUT, profanity, length). An
  // invalid preferred code silently falls back to the auto-generated one rather
  // than letting an applicant claim a reserved word or slur as their code.
  if (preferred && validateReferralCodeFormat(preferred).ok) {
    const { data: codeTaken } = await supabaseAdmin
      .from("partners")
      .select("id")
      .eq("referral_code", preferred)
      .maybeSingle();
    if (!codeTaken) {
      referralCode = preferred;
    }
  }

  const applicantFields = {
    first_name: input.firstName?.trim() || null,
    last_name: input.lastName?.trim() || null,
    phone: input.phone?.trim() || null,
    social: input.social?.trim() || null,
    follower_count: typeof input.followerCount === "number" && Number.isFinite(input.followerCount) ? Math.max(0, Math.round(input.followerCount)) : null,
    preferred_referral_code: preferred || null,
  };

  // New applicants get the admin's configured default commission rate (so the
  // "default commission %" control in the admin is authoritative), instead of a
  // hardcoded number. Admins can still set a per-ambassador rate on approval.
  const defaultCommission = await getReferralProgramConfig()
    .then((cfg) => Number(cfg.defaultCommissionPercent))
    .catch(() => 15);

  // BOTH ROWS OR NEITHER.
  //
  // These used to be two sequential inserts: partners, then ambassadors. The
  // first commits on its own, so a failure of the second — or a process death
  // between them — left an applicant with a partners row and no ambassadors
  // row. Every referral read uses ambassadors, so their code silently never
  // resolved: approved in the admin, dead link in the wild. BRUTUS has been in
  // exactly that state since 2026-08-02.
  //
  // create_partner_application does both inside one plpgsql body, which is one
  // transaction. It is also idempotent by auth user: a retry or double-submit
  // returns the existing partner untouched rather than minting a second
  // identity or overwriting rates an admin has since configured.
  const { data: created, error: createError } = await supabaseAdmin.rpc("create_partner_application", {
    p_id: partnerId,
    p_auth_user_id: input.authUserId,
    p_name: input.name,
    p_email: input.email,
    p_referral_code: referralCode,
    p_commission_percent: defaultCommission,
    p_applicant: applicantFields,
  });

  if (createError) {
    assertNoSupabaseError("rpc(create_partner_application)", createError);
  }

  const createdRow = (created ?? {}) as {
    partner_id?: string; status?: string; referral_code?: string;
    created?: boolean; adopted?: boolean;
  };

  // Always answer with the identity the FUNCTION settled on, never the ids this
  // function generated. When an admin pre-added this person, the surviving row
  // is theirs: its id, its status, and the referral code the admin issued —
  // which may already be in circulation. Returning the locally generated ones
  // would tell the applicant their code is something it is not.
  const resolved = {
    partnerId: String(createdRow.partner_id ?? partnerId),
    status: String(createdRow.status ?? "pending"),
    referralCode: String(createdRow.referral_code ?? referralCode),
  };

  // An application that already existed is returned as-is, so the caller sees
  // the same shape as the early-return above and nothing downstream re-notifies.
  //
  // Adoption is NOT that case. The row existed only because an admin pre-added
  // this person; they have just completed their first application, so it
  // notifies like any other. A later re-submit cannot double-send: by then they
  // have a partners row and the early return at the top of this function
  // short-circuits before the RPC is ever reached.
  if (createdRow.created === false && !createdRow.adopted) {
    return resolved;
  }

  try {
    const template = ambassadorApplicationReceivedTemplate({ name: input.name });
    await sendEmail({ to: input.email, ...template });
  } catch {
    // Non-critical notification; the application itself already succeeded above.
  }

  // Notify the admin: queue a dashboard notification AND email the owner so a
  // new application is never missed. Best-effort — never blocks the application.
  try {
    const applicationQueueRowId = await enqueueNotification("partner_application_received", input.email, {
      partnerId: resolved.partnerId,
      name: input.name,
      email: input.email,
    });

    const { supportEmail } = await getBusinessSettings();
    if (supportEmail) {
      const ownerAlert = newAmbassadorApplicationTemplate({
        applicantName: input.name,
        applicantEmail: input.email,
        adminUrl: `${getSiteUrl().replace(/\/$/, "")}/admin/partners`,
      });
      await sendEmail({ to: supportEmail, ...ownerAlert });
    }

    // Mark the queued notification handled once the owner alert has been sent,
    // so the admin "pending notifications" count reflects real unsent work
    // instead of growing forever — this kind previously had no consumer.
    if (applicationQueueRowId) {
      const { error: markSentError } = await supabaseAdmin
        .from("notification_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", applicationQueueRowId);
      if (markSentError && !isMissingRelationError(markSentError, "notification_queue")) {
        assertNoSupabaseError("notification_queue.update(application received sent)", markSentError);
      }
    }
  } catch {
    // Admin alert is best-effort; the application itself already succeeded.
  }

  return resolved;
}

export async function getPartnerProgramStats(): Promise<PartnerProgramStats> {
  // NOTE: the commission auto-approval sweep is intentionally NOT run here.
  // This stats read is served by the UNAUTHENTICATED /api/partner/program-stats
  // endpoint, and money-state transitions must not be drivable (or DoS-able) by
  // anonymous traffic. The scheduled cron (/api/cron/sweep) owns the sweep.
  const [
    { data: payoutRows, error: payoutError },
    { data: partnerRows, error: partnerError },
    { data: programStatsRows, error: statsError },
  ] = await Promise.all([
    supabaseAdmin.from("partner_payouts").select("amount"),
    supabaseAdmin.from("partners").select("id, invited_at, approved_at"),
    supabaseAdmin.from("partner_program_stats").select("key, value_numeric"),
  ]);

  assertNoSupabaseError("partner_payouts.select(program payouts)", payoutError);
  assertNoSupabaseError("partners.select(program partner approvals)", partnerError);
  assertNoSupabaseError("partner_program_stats.select(configurable stats)", statsError);

  const overrides = new Map((programStatsRows ?? []).map((row) => [row.key, Number(row.value_numeric ?? 0)]));

  const totalCommissionsPaid = roundMoney((payoutRows ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0));

  const commissionByPartner = new Map<string, number>();
  const { data: partnerCommissionRows, error: partnerCommissionError } = await supabaseAdmin
    .from("referral_orders")
    .select("ambassador_id, commission_amount, payment_status");

  assertNoSupabaseError("referral_orders.select(program partner commission totals)", partnerCommissionError);

  for (const row of partnerCommissionRows ?? []) {
    const partnerId = row.ambassador_id;
    // Canonical earned-commission rule (excludes reversed/voided/manual_review)
    // so program stats reconcile exactly with the ambassador + admin surfaces.
    if (!partnerId || !isEarnedCommission(row.payment_status)) continue;
    commissionByPartner.set(partnerId, (commissionByPartner.get(partnerId) ?? 0) + Number(row.commission_amount ?? 0));
  }

  const earningsValues = Array.from(commissionByPartner.values());
  const averagePartnerEarnings = earningsValues.length > 0
    ? roundMoney(earningsValues.reduce((sum, value) => sum + value, 0) / earningsValues.length)
    : 0;
  const topPartnerPayout = earningsValues.length > 0 ? roundMoney(Math.max(...earningsValues)) : 0;

  const approvalDurations = (partnerRows ?? [])
    .filter((row) => row.invited_at && row.approved_at)
    .map((row) => {
      const invitedAt = new Date(row.invited_at as string).getTime();
      const approvedAt = new Date(row.approved_at as string).getTime();
      return Math.max(0, (approvedAt - invitedAt) / (1000 * 60 * 60));
    });

  const averageApprovalTimeHours = approvalDurations.length > 0
    ? roundMoney(approvalDurations.reduce((sum, value) => sum + value, 0) / approvalDurations.length)
    : 24;

  const hasApprovalData = approvalDurations.length > 0;

  // partner_program_stats holds an admin-configured baseline (set once,
  // e.g. before launch, to avoid showing a discouraging "$0 everything" to
  // prospective partners). It is a FLOOR that real tracked activity builds
  // on top of, not a static override that would hide genuine growth:
  //   - money-sum metrics (total paid, average earnings) ADD the real
  //     tracked total/average on top of the baseline, so every real payout
  //     is still accurately reflected in what's displayed.
  //   - "top payout" is a MAX against the baseline, since it represents a
  //     single real high-water mark, not a running sum.
  //   - approval time uses the real average once any real approval has
  //     happened (faster or slower than the baseline), since averaging a
  //     baseline duration with real durations wouldn't be meaningful.
  const baselineTotalCommissionsPaid = overrides.get("total_commissions_paid_base") ?? 0;
  const baselineAveragePartnerEarnings = overrides.get("average_partner_earnings_base") ?? 0;
  const baselineTopPartnerPayout = overrides.get("top_partner_payout_base") ?? 0;
  const baselineAverageApprovalTimeHours = overrides.get("average_approval_time_hours_base") ?? PRELAUNCH_PARTNER_PROGRAM_STATS.averageApprovalTimeHours;

  return {
    totalCommissionsPaid: roundMoney(baselineTotalCommissionsPaid + totalCommissionsPaid),
    averagePartnerEarnings: roundMoney(baselineAveragePartnerEarnings + averagePartnerEarnings),
    averageApprovalTimeHours: hasApprovalData ? averageApprovalTimeHours : baselineAverageApprovalTimeHours,
    topPartnerPayout: roundMoney(Math.max(baselineTopPartnerPayout, topPartnerPayout)),
  };
}

function buildRevenueSeriesByMonth(orderRows: Array<{ created_at: string; amount_paid: number }>, monthsBack = 12) {
  const totals = new Map<string, number>();
  for (const row of orderRows) {
    const key = toMonthKey(row.created_at);
    totals.set(key, (totals.get(key) ?? 0) + Number(row.amount_paid ?? 0));
  }

  const now = new Date();
  const labels: Array<{ label: string; value: number }> = [];

  for (let i = monthsBack - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    labels.push({ label: monthLabel(key), value: roundMoney(totals.get(key) ?? 0) });
  }

  return labels;
}

function buildLifetimeSeries(orderRows: Array<{ created_at: string; amount_paid: number }>, points = 20) {
  const sorted = [...orderRows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let running = 0;
  const allPoints = sorted.map((row) => {
    running += Number(row.amount_paid ?? 0);
    return {
      label: toDateLabel(row.created_at),
      value: roundMoney(running),
    };
  });

  if (allPoints.length <= points) {
    return allPoints;
  }

  const step = Math.max(1, Math.floor(allPoints.length / points));
  return allPoints.filter((_, index) => index % step === 0 || index === allPoints.length - 1);
}

// How the business pays an ambassador (not a customer payment method).
export const AMBASSADOR_PAYOUT_METHODS = ["paypal", "venmo", "cashapp"] as const;
export type AmbassadorPayoutMethod = (typeof AMBASSADOR_PAYOUT_METHODS)[number];

export const AMBASSADOR_PAYOUT_METHOD_LABELS: Record<AmbassadorPayoutMethod, string> = {
  paypal: "PayPal",
  venmo: "Venmo",
  cashapp: "Cash App",
};

export function isValidPayoutMethod(value: string): value is AmbassadorPayoutMethod {
  return (AMBASSADOR_PAYOUT_METHODS as readonly string[]).includes(value);
}

// Set/update the signed-in ambassador's preferred payout destination. Validates
// the method and handle, and mirrors to both partners + ambassadors tables.
// Keyed by auth_user_id so a user can only ever set their OWN payout info.
export async function updatePartnerPayoutMethod(authUserId: string, method: string, handle: string): Promise<void> {
  const normalizedMethod = method.trim().toLowerCase();
  if (!isValidPayoutMethod(normalizedMethod)) {
    throw new Error("Choose a valid payout method: PayPal, Venmo, or Cash App.");
  }
  const normalizedHandle = handle.trim().slice(0, 200);
  if (!normalizedHandle) {
    throw new Error("Enter your payout username, email, or handle.");
  }

  // Capture the prior destination for the audit trail before overwriting it.
  const { data: prior } = await supabaseAdmin
    .from("partners")
    .select("id, payout_method, payout_handle")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  const now = new Date().toISOString();
  const payload = {
    payout_method: normalizedMethod,
    payout_handle: normalizedHandle,
    payout_updated_at: now,
    updated_at: now,
  };

  const { error } = await supabaseAdmin.from("partners").update(payload).eq("auth_user_id", authUserId);
  if (error) {
    throw error;
  }
  // Mirror to the ambassadors table (best-effort — never block the save).
  await supabaseAdmin.from("ambassadors").update(payload).eq("auth_user_id", authUserId).then(() => {}, () => {});

  // A11: audit the change. A payout handle changed right before a payout is a
  // classic fraud signal, so the prior + new destination must be traceable.
  // Best-effort — never block the ambassador's save on the audit write.
  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: authUserId,
    action: "partner_payout_method_changed",
    target_table: "partners",
    target_id: prior?.id ? String(prior.id) : null,
    metadata: {
      self_service: true,
      previous: { method: prior?.payout_method ?? null, handle: prior?.payout_handle ?? null },
      next: { method: normalizedMethod, handle: normalizedHandle },
    },
  }).then(() => {}, () => {});
}

export interface PayoutQueueRow {
  partnerId: string;
  name: string;
  amountOwed: number;
  approvedOrderCount: number;
  payoutMethod: string | null;
  payoutHandle: string | null;
  eligibleSince: string | null; // earliest approved_for_payout_at
  meetsMinimum: boolean;
  onHold: boolean; // ambassador not currently approved — balance is held, not payable
}

export interface PayoutQueue {
  rows: PayoutQueueRow[];
  readyCount: number; // ambassadors whose approved balance meets the minimum payout
  totalOwed: number;
  minimumPayoutThreshold: number;
}

// Builds the admin payout queue: every ambassador with commissions that have
// cleared the hold period (approved_for_payout) and are awaiting the next
// payout, with the amount owed, order count, when they became eligible, and
// their chosen payout method + handle. `readyCount` drives the "N ambassadors
// ready for payout" notification badge.
export async function getPayoutQueue(): Promise<PayoutQueue> {
  // AGGREGATED IN THE DATABASE, NOT HERE.
  //
  // This used to select every approved_for_payout row and sum them in JS. That
  // is right only while the row count stays under the project's db-max-rows:
  // above it PostgREST returns a truncated page with no error and no signal,
  // and the owner is shown LESS affiliate liability than they actually owe.
  // Silently under-reporting what you owe someone is the worst direction for
  // this particular number to be wrong in.
  //
  // affiliate_balances() returns ONE ROW PER PARTNER whatever the commission
  // count behind it, so a cap cannot bite until there are more partners than
  // the cap — and it computes pending, approved, paid and lifetime in the same
  // pass, from the same rows, with the same excluded-status rule as ledger.ts.
  const [{ data: balanceRows, error }, ambassadorSettings] = await Promise.all([
    supabaseAdmin.rpc("affiliate_balances"),
    getAmbassadorProgramSettings(),
  ]);

  if (error) {
    assertNoSupabaseError("rpc(affiliate_balances)", error);
  }

  const minimum = ambassadorSettings.minimumPayoutThreshold;
  const byPartner = new Map<string, { amount: number; count: number; earliest: string | null }>();
  for (const row of (balanceRows ?? []) as Array<{
    ambassador_id: string; approved_amount: number | string;
    approved_count: number | string; earliest_approved_at: string | null;
  }>) {
    const id = String(row.ambassador_id ?? "");
    if (!id) continue;
    const amount = Number(row.approved_amount ?? 0);
    // A partner with nothing approved is not in the queue at all.
    if (!(amount > 0)) continue;
    byPartner.set(id, {
      amount,
      count: Number(row.approved_count ?? 0),
      earliest: row.earliest_approved_at ? String(row.earliest_approved_at) : null,
    });
  }

  const partnerIds = Array.from(byPartner.keys());
  const partnerInfo = new Map<string, { name: string; payout_method: string | null; payout_handle: string | null; status: string }>();
  if (partnerIds.length > 0) {
    const { data: partners } = await supabaseAdmin
      .from("partners")
      .select("id, name, payout_method, payout_handle, status")
      .in("id", partnerIds);
    for (const p of partners ?? []) {
      partnerInfo.set(String(p.id), {
        name: String(p.name ?? ""),
        payout_method: p.payout_method ? String(p.payout_method) : null,
        payout_handle: p.payout_handle ? String(p.payout_handle) : null,
        status: String(p.status ?? "").toLowerCase(),
      });
    }
  }

  const queueRows: PayoutQueueRow[] = partnerIds.map((id) => {
    const agg = byPartner.get(id)!;
    const info = partnerInfo.get(id);
    const amountOwed = roundMoney(agg.amount);
    const onHold = (info?.status ?? "") !== "approved";
    return {
      partnerId: id,
      name: info?.name ?? "Unknown",
      amountOwed,
      approvedOrderCount: agg.count,
      payoutMethod: info?.payout_method ?? null,
      payoutHandle: info?.payout_handle ?? null,
      eligibleSince: agg.earliest,
      meetsMinimum: amountOwed >= minimum,
      onHold,
    };
  }).sort((a, b) => b.amountOwed - a.amountOwed);

  return {
    rows: queueRows,
    // A disabled ambassador's balance is held (markCommissionsPaid refuses it),
    // so it must not inflate the "ready for payout" badge.
    readyCount: queueRows.filter((r) => r.meetsMinimum && !r.onHold).length,
    totalOwed: roundMoney(queueRows.reduce((sum, r) => sum + r.amountOwed, 0)),
    minimumPayoutThreshold: minimum,
  };
}

export async function getPartnerSummary(partnerId: string, siteUrl: string): Promise<PartnerSummary> {
  const [{ data: partner, error: partnerError }, { data: commissionRows, error: commissionError }, { data: orderRows, error: orderError }, { data: clickRows, error: clickError }, { data: payoutRows, error: payoutError }] = await Promise.all([
    supabaseAdmin
      .from("partners")
      .select("id, name, referral_code, commission_percent, customer_discount_percent, status, payout_method, payout_handle")
      .eq("id", partnerId)
      .single(),
    supabaseAdmin
      .from("referral_orders")
      .select("order_id, commission_amount, payment_status, created_at")
      .eq("ambassador_id", partnerId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, amount_paid, payment_status, created_at")
      .eq("ambassador_id", partnerId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("partner_clicks")
      .select("created_at")
      .eq("ambassador_id", partnerId),
    supabaseAdmin
      .from("partner_payouts")
      .select("id, amount, note, created_at")
      .eq("ambassador_id", partnerId)
      .order("created_at", { ascending: false }),
  ]);

  assertNoSupabaseError("partners.select(partner summary)", partnerError);
  assertNoSupabaseError("referral_orders.select(partner summary commissions)", commissionError);
  assertNoSupabaseError("orders.select(partner summary orders)", orderError);
  assertNoSupabaseError("partner_clicks.select(partner summary clicks)", clickError);
  assertNoSupabaseError("partner_payouts.select(partner summary payouts)", payoutError);

  if (!partner) {
    throw new Error(`Partner not found for id ${partnerId}`);
  }

  const commissions = commissionRows ?? [];
  const orders = orderRows ?? [];
  const clicks = clickRows ?? [];

  // Reversed/refunded (and under-review) commissions must NOT inflate the
  // ambassador's displayed lifetime earnings — only genuinely earned
  // commissions count.
  const earnedCommissions = commissions.filter((row) => isEarnedCommission(row.payment_status));
  const totalEarnings = roundMoney(earnedCommissions.reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0));
  // Unpaid balance = commissions still owed to the partner. This must exclude
  // already-paid commissions (previously "paid" was wrongly counted here, so
  // the partner's dashboard showed paid money as still-pending).
  const pendingCommissions = roundMoney(commissions
    .filter((row) => row.payment_status === "pending" || row.payment_status === "approved_for_payout")
    .reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0));
  // Pending (still in the 14-day hold) vs Approved (hold cleared, awaiting the
  // next payout) shown as distinct buckets per the spec.
  const pendingOnlyCommissions = roundMoney(commissions
    .filter((row) => row.payment_status === "pending")
    .reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0));
  const approvedCommissions = roundMoney(commissions
    .filter((row) => row.payment_status === "approved_for_payout")
    .reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0));
  const paidCommissions = roundMoney(commissions
    .filter((row) => row.payment_status === "commission_paid" || row.payment_status === "paid")
    .reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0));

  const paidOrders = orders.filter((order) => order.payment_status === "paid");
  const totalRevenue = roundMoney(paidOrders.reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0));
  const totalOrders = paidOrders.length;
  const averageOrderValue = totalOrders > 0 ? roundMoney(totalRevenue / totalOrders) : 0;

  const customerOrderCounts = new Map<string, number>();
  for (const order of paidOrders) {
    if (!order.customer_email) continue;
    customerOrderCounts.set(order.customer_email, (customerOrderCounts.get(order.customer_email) ?? 0) + 1);
  }

  const returningCustomers = Array.from(customerOrderCounts.values()).filter((count) => count > 1).length;
  const returningCustomerRate = customerOrderCounts.size > 0
    ? roundMoney((returningCustomers / customerOrderCounts.size) * 100)
    : 0;

  const conversions = totalOrders;
  const totalClicks = clicks.length;
  const conversionRate = totalClicks > 0 ? roundMoney((conversions / totalClicks) * 100) : 0;

  // This calendar month's earned commissions (excludes clawed-back rows).
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthlyCommissions = roundMoney(
    commissions
      .filter((c) => new Date(c.created_at).getTime() >= monthStart.getTime() && !["reversed", "voided"].includes(String(c.payment_status)))
      .reduce((sum, c) => sum + Number(c.commission_amount ?? 0), 0),
  );

  const recentOrders = commissions.slice(0, 50).map((commission) => {
    const order = orders.find((row) => row.order_id === commission.order_id);
    return {
      orderId: commission.order_id,
      createdAt: commission.created_at,
      customerEmail: order?.customer_email ?? null,
      amountPaid: roundMoney(Number(order?.amount_paid ?? 0)),
      // A commission row only exists for a PAID order, so an order we can't
      // re-load (rare) is "paid", not "pending_payment" — the old default
      // mislabeled real paid orders as pending on the ambassador dashboard.
      paymentStatus: order?.payment_status ?? "paid",
      commissionAmount: roundMoney(Number(commission.commission_amount ?? 0)),
      commissionStatus: commission.payment_status,
    };
  });

  const marketingResources = await getAmbassadorMarketingResources().catch(() => []);

  // Resolved with the same rule checkout uses, so the dashboard tells the
  // ambassador what their code gives rather than what their row stores. A
  // failure to read the program config must not blank the dashboard, so the
  // resolver's own fallback path (an unusable override) is the worst case.
  const referralProgram = await getReferralProgramConfig().catch(() => null);
  // Read the rate from the table checkout reads, so an ambassador is never
  // shown a discount their own code would not give.
  const liveRates = (await fetchAuthoritativeRates([String(partner.id)])).get(String(partner.id));
  const customerDiscountPercent = resolveAmbassadorCustomerDiscount(
    liveRates ? liveRates.customerDiscountPercent : partner.customer_discount_percent,
    referralProgram?.discountPercent ?? DEFAULT_REFERRAL_DISCOUNT_PERCENT,
  );

  return {
    partnerId: partner.id,
    partnerName: partner.name,
    referralCode: partner.referral_code,
    referralLink: `${siteUrl.replace(/\/$/, "")}/r/${partner.referral_code}`,
    commissionPercent: liveRates?.commissionPercent ?? Number(partner.commission_percent ?? 15),
    customerDiscountPercent,
    totalEarnings,
    pendingCommissions,
    pendingOnlyCommissions,
    approvedCommissions,
    paidCommissions,
    payoutMethod: partner.payout_method ? String(partner.payout_method) : null,
    payoutHandle: partner.payout_handle ? String(partner.payout_handle) : null,
    totalOrders,
    averageOrderValue,
    returningCustomerRate,
    totalRevenue,
    totalClicks,
    conversions,
    conversionRate,
    monthlyCommissions,
    recentOrders,
    monthlyRevenueSeries: buildRevenueSeriesByMonth(paidOrders.map((row) => ({ created_at: row.created_at, amount_paid: Number(row.amount_paid ?? 0) }))),
    lifetimeRevenueSeries: buildLifetimeSeries(paidOrders.map((row) => ({ created_at: row.created_at, amount_paid: Number(row.amount_paid ?? 0) }))),
    marketingResources,
    accountStatus: String(partner.status ?? "approved"),
    payoutHistory: (payoutRows ?? []).map((row) => ({
      id: String(row.id),
      amount: roundMoney(Number(row.amount ?? 0)),
      note: row.note ? String(row.note) : null,
      createdAt: String(row.created_at),
    })),
  };
}

/**
 * The rates that ACTUALLY decide money, read from the table that decides it.
 *
 * An ambassador exists as two rows sharing one id. Checkout (quote-order) and
 * the payment webhook read `ambassadors`; the admin roster and the ambassador's
 * own dashboard used to read `partners`. So the number the owner saw and the
 * number the shopper was charged came from different places, and a partial
 * write could leave them disagreeing -- confirmed in production, where the
 * admin showed a 20% discount that checkout would never have applied.
 *
 * Every display now reads the money side. The two tables can still drift, but
 * a drift can no longer show the owner a rate that is not the one charged: at
 * worst `partners` holds a stale copy nothing reads for pricing.
 */
async function fetchAuthoritativeRates(
  partnerIds: string[],
): Promise<Map<string, { customerDiscountPercent: number | null; commissionPercent: number | null; commissionPercentLocked: boolean }>> {
  const rates = new Map<string, { customerDiscountPercent: number | null; commissionPercent: number | null; commissionPercentLocked: boolean }>();
  if (partnerIds.length === 0) return rates;

  const { data, error } = await supabaseAdmin
    .from("ambassadors")
    .select("id, customer_discount_percent, commission_percent, commission_percent_locked")
    .in("id", partnerIds);

  // A failure here must not blank the admin: the caller falls back to the
  // partners copy, which is the previous behaviour rather than a regression.
  if (error) return rates;

  for (const row of data ?? []) {
    rates.set(String(row.id), {
      customerDiscountPercent: row.customer_discount_percent != null ? Number(row.customer_discount_percent) : null,
      commissionPercent: row.commission_percent != null ? Number(row.commission_percent) : null,
      commissionPercentLocked: Boolean(row.commission_percent_locked),
    });
  }
  return rates;
}

export async function getAdminPartnerRows(input?: { search?: string; status?: string; payoutStatus?: string }): Promise<AdminPartnerRow[]> {
  // select("*") (rather than an explicit column list) so this keeps working
  // whether or not the ambassador-application-fields.sql migration has been
  // applied yet — a missing column would otherwise error the whole query.
  let query = supabaseAdmin
    .from("partners")
    .select("*")
    .order("updated_at", { ascending: false });

  if (input?.status && input.status !== "all") {
    query = query.eq("status", input.status);
  }

  if (input?.search) {
    // Sanitize before interpolating into PostgREST's comma-delimited .or()
    // (same allowlist as admin-orders.ts) so a search term can't break out of
    // the filter clause.
    const normalizedSearch = input.search.trim().replace(/[^a-zA-Z0-9@._\- ]/g, "").slice(0, 100);
    if (normalizedSearch) {
      query = query.or(`name.ilike.%${normalizedSearch}%,email.ilike.%${normalizedSearch}%,referral_code.ilike.%${normalizedSearch}%`);
    }
  }

  const [{ data: partners, error: partnerError }, rollup] = await Promise.all([
    query,
    // Aggregate the three growth tables in Postgres (one grouped pass each)
    // instead of scanning every row into the app. Falls back below if the RPC
    // isn't migrated yet — see src/lib/sql/admin-partner-rollups.sql.
    supabaseAdmin.rpc("admin_partner_rollups"),
  ]);
  assertNoSupabaseError("partners.select(admin partner rows)", partnerError);

  const commissionByPartner = new Map<string, { total: number; pending: number; approvedForPayout: number; paid: number; reversed: number }>();
  const ordersByPartner = new Map<string, { totalRevenue: number; totalOrders: number }>();
  const clickCounts = new Map<string, number>();

  if (!rollup.error && Array.isArray(rollup.data)) {
    for (const row of rollup.data as Array<Record<string, unknown>>) {
      const partnerId = row.ambassador_id ? String(row.ambassador_id) : "";
      if (!partnerId) continue;
      commissionByPartner.set(partnerId, {
        total: Number(row.commission_total ?? 0),
        pending: Number(row.commission_pending ?? 0),
        approvedForPayout: Number(row.commission_approved ?? 0),
        paid: Number(row.commission_paid ?? 0),
        reversed: Number(row.commission_reversed ?? 0),
      });
      ordersByPartner.set(partnerId, {
        totalRevenue: Number(row.order_revenue ?? 0),
        totalOrders: Number(row.order_count ?? 0),
      });
      clickCounts.set(partnerId, Number(row.click_count ?? 0));
    }
  } else {
    // Fallback: the rollup RPC isn't present — legacy full-table scan + JS
    // aggregation (identical bucket logic). Slower, but keeps the page working
    // before the migration is applied.
    const [{ data: commissionRows, error: commissionError }, { data: orderRows, error: orderError }, { data: clickRows, error: clickError }] = await Promise.all([
      supabaseAdmin.from("referral_orders").select("ambassador_id, commission_amount, payment_status"),
      supabaseAdmin.from("orders").select("ambassador_id, amount_paid, payment_status"),
      supabaseAdmin.from("partner_clicks").select("ambassador_id"),
    ]);
    assertNoSupabaseError("referral_orders.select(admin commission rows)", commissionError);
    assertNoSupabaseError("orders.select(admin order rows)", orderError);
    assertNoSupabaseError("partner_clicks.select(admin click rows)", clickError);

    for (const row of commissionRows ?? []) {
      const partnerId = row.ambassador_id;
      if (!partnerId) continue;
      const current = commissionByPartner.get(partnerId) ?? { total: 0, pending: 0, approvedForPayout: 0, paid: 0, reversed: 0 };
      const amount = Number(row.commission_amount ?? 0);
      if (isEarnedCommission(row.payment_status)) current.total += amount;
      if (row.payment_status === "commission_paid" || row.payment_status === "paid") {
        current.paid += amount;
      } else if (row.payment_status === "approved_for_payout") {
        current.approvedForPayout += amount;
      } else if (row.payment_status === "reversed" || row.payment_status === "voided") {
        current.reversed += amount;
      } else if (row.payment_status !== "reversed" && row.payment_status !== "voided") {
        current.pending += amount;
      }
      commissionByPartner.set(partnerId, current);
    }
    for (const row of orderRows ?? []) {
      const partnerId = row.ambassador_id;
      if (!partnerId || row.payment_status !== "paid") continue;
      const current = ordersByPartner.get(partnerId) ?? { totalRevenue: 0, totalOrders: 0 };
      current.totalRevenue += Number(row.amount_paid ?? 0);
      current.totalOrders += 1;
      ordersByPartner.set(partnerId, current);
    }
    for (const row of clickRows ?? []) {
      const partnerId = row.ambassador_id;
      if (!partnerId) continue;
      clickCounts.set(partnerId, (clickCounts.get(partnerId) ?? 0) + 1);
    }
  }

  const authoritativeRates = await fetchAuthoritativeRates((partners ?? []).map((p) => String(p.id)));

  const mappedRows = (partners ?? []).map((partner) => {
    const liveRates = authoritativeRates.get(String(partner.id));
    const commission = commissionByPartner.get(partner.id) ?? { total: 0, pending: 0, approvedForPayout: 0, paid: 0, reversed: 0 };
    const order = ordersByPartner.get(partner.id) ?? { totalRevenue: 0, totalOrders: 0 };
    const clicks = clickCounts.get(partner.id) ?? 0;
    const conversionRate = clicks > 0 ? roundMoney((order.totalOrders / clicks) * 100) : 0;

    return {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      referralCode: partner.referral_code,
      status: partner.status,
      commissionPercent: liveRates?.commissionPercent ?? Number(partner.commission_percent ?? 15),
      commissionPercentLocked: liveRates?.commissionPercentLocked ?? Boolean(partner.commission_percent_locked),
      customerDiscountPercent:
        liveRates
          ? liveRates.customerDiscountPercent
          : partner.customer_discount_percent != null ? Number(partner.customer_discount_percent) : null,
      totalRevenue: roundMoney(order.totalRevenue),
      totalOrders: order.totalOrders,
      totalCommissions: roundMoney(commission.total),
      pendingCommissions: roundMoney(commission.pending),
      approvedForPayoutCommissions: roundMoney(commission.approvedForPayout),
      paidCommissions: roundMoney(commission.paid),
      reversedCommissions: roundMoney(commission.reversed),
      clicks,
      conversionRate,
      updatedAt: partner.updated_at,
      phone: partner.phone ? String(partner.phone) : null,
      social: partner.social ? String(partner.social) : null,
      followerCount: partner.follower_count != null ? Number(partner.follower_count) : null,
      preferredReferralCode: partner.preferred_referral_code ? String(partner.preferred_referral_code) : null,
    };
  });

  if (!input?.payoutStatus || input.payoutStatus === "all") {
    return mappedRows;
  }

  return mappedRows.filter((row) => {
    if (input.payoutStatus === "pending") {
      return row.pendingCommissions > 0;
    }

    if (input.payoutStatus === "approved_for_payout") {
      return row.approvedForPayoutCommissions > 0;
    }

    if (input.payoutStatus === "paid") {
      return row.paidCommissions > 0;
    }

    if (input.payoutStatus === "reversed") {
      return row.reversedCommissions > 0;
    }

    return true;
  });
}

export async function getAdminOperationsSummary(): Promise<AdminOperationsSummary> {
  const today = new Date();
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString();

  const [
    opsRpc,
    { data: inventoryRows, error: inventoryError },
    { data: shipmentRows, error: shipmentError },
    { data: couponRows, error: couponError },
    { data: notificationRows, error: notificationError },
  ] = await Promise.all([
    // Live sales + new/returning customer counts aggregated in Postgres (no
    // unbounded scan of every paid order into the app). Falls back below if the
    // RPC isn't migrated yet — see src/lib/sql/admin-dashboard-rollups.sql.
    supabaseAdmin.rpc("admin_ops_summary", { p_today_start: todayStart, p_month_start: monthStart }),
    supabaseAdmin.from("products").select("inventory_quantity, stock_status, low_stock_threshold").eq("is_archived", false),
    supabaseAdmin.from("order_shipments").select("shipping_status").neq("shipping_status", "delivered"),
    supabaseAdmin.from("coupons").select("id").eq("active", true),
    supabaseAdmin.from("notification_queue").select("id").eq("status", "pending"),
  ]);

  let liveSalesToday: number;
  let liveSalesMonth: number;
  let newCustomers: number;
  let returningCustomers: number;
  let totalCustomers: number;

  const opsRow = Array.isArray(opsRpc.data) ? (opsRpc.data[0] as Record<string, unknown> | undefined) : undefined;
  if (!opsRpc.error && opsRow) {
    liveSalesToday = roundMoney(Number(opsRow.live_sales_today ?? 0));
    liveSalesMonth = roundMoney(Number(opsRow.live_sales_month ?? 0));
    newCustomers = Number(opsRow.new_customers ?? 0);
    returningCustomers = Number(opsRow.returning_customers ?? 0);
    totalCustomers = Number(opsRow.total_customers ?? 0);
  } else {
    // Fallback: RPC not present — legacy scans + JS aggregation (identical math).
    const [
      { data: todayOrders, error: todayError },
      { data: monthOrders, error: monthError },
      { data: allPaidOrders, error: paidError },
    ] = await Promise.all([
      supabaseAdmin.from("orders").select("amount_paid").eq("payment_status", "paid").gte("created_at", todayStart),
      supabaseAdmin.from("orders").select("amount_paid").eq("payment_status", "paid").gte("created_at", monthStart),
      supabaseAdmin.from("orders").select("customer_email").eq("payment_status", "paid"),
    ]);
    assertNoSupabaseError("orders.select(live sales today)", todayError);
    assertNoSupabaseError("orders.select(live sales month)", monthError);
    assertNoSupabaseError("orders.select(customer analytics)", paidError);

    liveSalesToday = roundMoney((todayOrders ?? []).reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0));
    liveSalesMonth = roundMoney((monthOrders ?? []).reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0));

    const customerOrderCount = new Map<string, number>();
    for (const row of allPaidOrders ?? []) {
      const email = row.customer_email;
      if (!email) continue;
      customerOrderCount.set(email, (customerOrderCount.get(email) ?? 0) + 1);
    }
    newCustomers = Array.from(customerOrderCount.values()).filter((count) => count === 1).length;
    returningCustomers = Array.from(customerOrderCount.values()).filter((count) => count > 1).length;
    totalCustomers = customerOrderCount.size;
  }

  // Low stock is computed from the products table — the real source of stock
  // (the inventory_items table exists but nothing populates it, so reading it
  // always reported 0 low-stock items and the dashboard never flagged a
  // stockout). Uses each product's own low_stock_threshold.
  assertNoSupabaseError("products.select(ops summary inventory)", inventoryError);
  const lowStockItems = (inventoryRows ?? []).filter((row) => {
    const qty = Number(row.inventory_quantity ?? 0);
    const threshold = Number(row.low_stock_threshold ?? 5);
    const status = String(row.stock_status ?? "").toLowerCase();
    return qty <= threshold || status === "out of stock" || status === "limited";
  }).length;

  if (shipmentError && !isMissingRelationError(shipmentError, "order_shipments")) {
    assertNoSupabaseError("order_shipments.select(ops summary)", shipmentError);
  }

  if (couponError && !isMissingRelationError(couponError, "coupons")) {
    assertNoSupabaseError("coupons.select(ops summary)", couponError);
  }

  if (notificationError && !isMissingRelationError(notificationError, "notification_queue")) {
    assertNoSupabaseError("notification_queue.select(ops summary)", notificationError);
  }

  const pendingShipments = shipmentError ? 0 : (shipmentRows ?? []).length;
  const activeCoupons = couponError ? 0 : (couponRows ?? []).length;
  const pendingNotifications = notificationError ? 0 : (notificationRows ?? []).length;

  return {
    liveSalesToday,
    liveSalesMonth,
    newCustomers,
    returningCustomers,
    returningCustomerRate: totalCustomers > 0 ? roundMoney((returningCustomers / totalCustomers) * 100) : 0,
    lowStockItems,
    pendingShipments,
    activeCoupons,
    pendingNotifications,
  };
}

export async function createPartnerInvite(input: {
  name: string;
  email: string;
  commissionPercent: number;
  createdByUserId?: string;
  actorUsername?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const referralCode = generateReferralCode(input.name);
  const actorUserId = input.createdByUserId ?? null;
  const { data: invitedUser, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(input.email, {
    data: { role: "partner", invited_by: actorUserId },
  });

  if (inviteError) {
    assertNoSupabaseError("auth.admin.inviteUserByEmail", inviteError);
  }

  const partnerId = randomUUID();

  // BOTH ROWS OR NEITHER, and identity is the person rather than the auth row.
  //
  // These used to be two separate inserts. Two PostgREST statements are two
  // transactions, and `partners` has no unique email while `ambassadors` does --
  // so inviting an address an admin had already pre-added committed the partners
  // row and then failed on ambassadors_email_key, leaving an orphan partner
  // holding a referral code that checkout would never honour. That orphan also
  // defeated the F-009 adoption repair, because it matches on auth_user_id.
  // See src/lib/sql/partner-invite-convergence.sql (audit finding F-013).
  const { data: invited, error } = await supabaseAdmin.rpc("create_partner_invite", {
    p_id: partnerId,
    p_auth_user_id: invitedUser.user?.id ?? null,
    p_name: input.name,
    p_email: input.email,
    p_referral_code: referralCode,
    p_commission_percent: input.commissionPercent,
    p_created_by: actorUserId,
  });

  if (error) {
    assertNoSupabaseError("rpc.create_partner_invite", error);
  }

  const result = (invited ?? {}) as {
    partner_id?: string;
    referral_code?: string;
    commission_percent?: number | string;
    adopted?: boolean;
  };

  // Answer with the identity the database settled on, not the one generated
  // here. On adoption the surviving row is the admin's -- with the referral code
  // they already issued, which may be in circulation, and the rate they set.
  const settledPartnerId = result.partner_id ?? partnerId;
  const settledReferralCode = result.referral_code ?? referralCode;
  const adopted = result.adopted === true;

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: actorUserId,
    action: adopted ? "partner_invite_adopted" : "partner_invited",
    target_table: "ambassadors",
    target_id: settledPartnerId,
    metadata: {
      email: input.email,
      commissionPercent: adopted ? Number(result.commission_percent) : input.commissionPercent,
      referralCode: settledReferralCode,
      // An adopted invite linked an ambassador the admin had already configured;
      // the rate and code they see are that row's, not the ones typed into the
      // invite form.
      adopted,
      actorUsername: input.actorUsername ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  return {
    partnerId: settledPartnerId,
    referralCode: settledReferralCode,
    adopted,
  };
}

export async function updatePartnerStatus(input: {
  partnerId: string;
  status: "approved" | "disabled" | "pending" | "rejected" | "info_requested";
  actorUserId?: string;
  commissionPercent?: number;
  commissionPercentLocked?: boolean;
  // Tri-state, and the three states mean different things:
  //   undefined -> leave the ambassador's discount exactly as it is
  //   null      -> clear the override, so they follow the program default again
  //   number    -> this ambassador's own rate
  // Collapsing null into undefined would make an emptied field un-clearable.
  customerDiscountPercent?: number | null;
  referralCode?: string;
  actorUsername?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const { data: existingPartner, error: partnerLookupError } = await supabaseAdmin
    .from("partners")
    .select("id, name, email, referral_code, commission_percent, status")
    .eq("id", input.partnerId)
    .maybeSingle();

  assertNoSupabaseError("partners.select(status update lookup)", partnerLookupError);

  if (!existingPartner) {
    throw new Error("Partner not found");
  }

  // Whether this call is an actual status TRANSITION or merely a rate edit that
  // has to carry the current status along to preserve it. Every status side
  // effect below is gated on it: without that, adjusting a commission re-sent
  // the approval email and rewrote the date an ambassador was disabled.
  const statusChanged = String(existingPartner.status ?? "") !== input.status;

  const normalizedReferralCode = input.referralCode
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");

  if (normalizedReferralCode) {
    const { data: conflictPartner, error: conflictError } = await supabaseAdmin
      .from("partners")
      .select("id")
      .eq("referral_code", normalizedReferralCode)
      .neq("id", input.partnerId)
      .maybeSingle();

    assertNoSupabaseError("partners.select(referral code conflict)", conflictError);

    if (conflictPartner) {
      throw new Error("Referral code is already in use");
    }
  }

  // Status is written ONLY when it actually changes.
  //
  // A rate edit has to send the ambassador's current status along to preserve
  // it, which meant every discount save re-wrote status onto both tables. The
  // ambassadors mirror carries a stricter check constraint than partners --
  // "info_requested" is in the app's vocabulary but not in that constraint --
  // so saving a rate for such an ambassador failed with 23514.
  //
  // Worse than the error: the two updates run concurrently, so partners had
  // already accepted the new rate when the ambassadors write was rejected.
  // Checkout reads ambassadors, so the admin could show a discount the
  // storefront would never apply. Not writing an unchanged status removes the
  // whole class of failure -- a rates-only save now touches only the rate.
  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // ALWAYS write the status, even when it looks unchanged.
  //
  // This was gated on statusChanged, which is computed by comparing against
  // PARTNERS alone. The payload is then written to ambassadors AND partners, so
  // the moment the two tables disagree the gate reads "no change" from the
  // mirror and omits status entirely — and ambassadors, the table the MONEY
  // reads, keeps whatever stale value it had. Saving again cannot repair it,
  // because the comparison still sees no change.
  //
  // ELIJAH-AB78AE is that state in production: partners says info_requested,
  // ambassadors says approved, so the code still resolves for shoppers and the
  // commission gate still passes. An ambassador the owner put on hold stayed
  // live, and three separate admin saves could not bring them back in line.
  //
  // Writing it unconditionally converges the two tables on every save. The
  // SIDE EFFECTS stay gated on statusChanged exactly as before — the approval
  // email, approved_at and disabled_at all still fire only on a real
  // transition, which is what stopped a rate edit re-sending an approval.
  updatePayload.status = input.status;

  // Same rule for the approval timestamps: only on a real transition into
  // approved. A rate edit on an already-approved ambassador used to re-clear
  // disabled_at on every save.
  if (statusChanged && input.status === "approved") {
    const { data: approvalRow } = await supabaseAdmin
      .from("partners")
      .select("status, approved_at")
      .eq("id", input.partnerId)
      .maybeSingle();

    if (approvalRow?.status !== "approved" || !approvalRow?.approved_at) {
      updatePayload.approved_at = new Date().toISOString();
    }
    updatePayload.disabled_at = null;
  }

  // Only stamp the disable date when they are actually BEING disabled. Editing
  // a disabled ambassador's commission used to reset this to today, erasing the
  // record of when the disable happened.
  if (statusChanged && (input.status === "disabled" || input.status === "rejected")) {
    updatePayload.disabled_at = new Date().toISOString();
  }

  if (typeof input.commissionPercent === "number") {
    updatePayload.commission_percent = input.commissionPercent;
    // Manually setting a flat percent opts the ambassador out of automatic
    // performance-tier commissions, unless the caller explicitly says
    // otherwise (used by the "re-enable automatic tiers" admin action).
    updatePayload.commission_percent_locked = input.commissionPercentLocked ?? true;
  } else if (typeof input.commissionPercentLocked === "boolean") {
    updatePayload.commission_percent_locked = input.commissionPercentLocked;
  }

  // Written in its own branch, never inside the commission branch above: the
  // owner asked for two rates that cannot move each other, and the only way to
  // guarantee that is for neither write to be reachable from the other.
  if (input.customerDiscountPercent !== undefined) {
    updatePayload.customer_discount_percent = input.customerDiscountPercent;
  }

  if (normalizedReferralCode) {
    updatePayload.referral_code = normalizedReferralCode;
  }

  // SEQUENTIAL, AND THE MONEY SIDE FIRST.
  //
  // These ran concurrently, so a rejected write on one table arrived after the
  // other had already committed -- the exact shape of the production drift:
  // partners took a 20% discount, ambassadors rejected the payload, and the
  // storefront kept charging the old rate while the admin showed the new one.
  //
  // ambassadors is what checkout reads, so it goes first. If it fails, nothing
  // is written anywhere and the owner sees an honest error. If the partners
  // mirror then fails, the rate that governs money is already correct and only
  // a display copy is stale -- the safe direction to fail in.
  const { error: ambassadorUpdateError } = await supabaseAdmin
    .from("ambassadors")
    .update(updatePayload)
    .eq("id", input.partnerId);
  assertNoSupabaseError("ambassadors.update(authoritative rates)", ambassadorUpdateError);

  const { error: partnerUpdateError } = await supabaseAdmin
    .from("partners")
    .update(updatePayload)
    .eq("id", input.partnerId);
  assertNoSupabaseError("partners.update(mirror)", partnerUpdateError);

  const finalReferralCode = normalizedReferralCode ?? existingPartner.referral_code;
  const referralCodeChanged = Boolean(normalizedReferralCode) && normalizedReferralCode !== existingPartner.referral_code;

  // Email/notification-queue side effects must never block the status
  // update itself or the audit log entry below — isolated in its own
  // try/catch so a failed send (or an unconfigured provider) can't leave
  // the admin action half-finished or skip the audit trail.
  // Gated on a real transition (see statusChanged above): an approved
  // ambassador used to receive a fresh "your application was approved" email
  // every time the owner adjusted their rates.
  if (statusChanged && (input.status === "approved" || input.status === "rejected") && existingPartner.email) {
    try {
      const queueRowId = await enqueueNotification(
        input.status === "approved" ? "partner_application_approved" : "partner_application_rejected",
        existingPartner.email,
        {
          partnerId: input.partnerId,
          name: existingPartner.name,
          status: input.status,
          referralCode: finalReferralCode,
        },
      );

      const emailSent = await sendPartnerStatusEmail({
        to: existingPartner.email,
        name: existingPartner.name,
        status: input.status,
        referralCode: finalReferralCode,
        commissionPercent: existingPartner.commission_percent != null ? Number(existingPartner.commission_percent) : undefined,
      });

      if (emailSent && queueRowId) {
        const { error: queueUpdateError } = await supabaseAdmin
          .from("notification_queue")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", queueRowId);

        if (queueUpdateError && !isMissingRelationError(queueUpdateError, "notification_queue")) {
          assertNoSupabaseError("notification_queue.update(sent)", queueUpdateError);
        }
      }
    } catch {
      // Keep pending queue row for retry workflows.
    }
  }

  if (referralCodeChanged && existingPartner.email) {
    try {
      await sendReferralCodeAssignedEmail({
        to: existingPartner.email,
        name: existingPartner.name,
        referralCode: finalReferralCode,
        // The rate this request set, if any — otherwise the one already stored,
        // which is what checkout will actually pay them. Never a bare 0.
        commissionPercent: input.commissionPercent,
        storedCommissionPercent: existingPartner.commission_percent,
      });
    } catch {
      // Non-critical notification; the referral code change itself already succeeded above.
    }
  }

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: input.actorUserId ?? null,
    action: "partner_status_updated",
    target_table: "ambassadors",
    target_id: input.partnerId,
    metadata: {
      status: input.status,
      commissionPercent: input.commissionPercent ?? null,
      customerDiscountPercent: input.customerDiscountPercent === undefined ? "unchanged" : input.customerDiscountPercent,
      referralCode: finalReferralCode,
      actorUsername: input.actorUsername ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

// Permanently removes an ambassador so they disappear from the admin list.
// Guarded: an ambassador who has generated referral orders is NOT deleted -
// that would erase commission/revenue history. Those should be Disabled
// instead. Deletion is for test entries, spam, or rejected applicants with no
// financial history. Removes the click rows and both profile mirrors
// (ambassadors + partners); their auth login (if any) is left untouched.
export async function deleteAmbassador(input: {
  partnerId: string;
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("partners")
    .select("id, name, email")
    .eq("id", input.partnerId)
    .maybeSingle();
  assertNoSupabaseError("partners.select(delete lookup)", existingError);
  if (!existing) {
    throw new Error("Ambassador not found.");
  }

  const { data: orders, error: ordersError } = await supabaseAdmin
    .from("referral_orders")
    .select("id")
    .eq("ambassador_id", input.partnerId)
    .limit(1);
  assertNoSupabaseError("referral_orders.select(delete guard)", ordersError);
  if ((orders ?? []).length > 0) {
    throw new Error("This ambassador has recorded orders. Disable them instead of deleting, so their commission and revenue history is preserved.");
  }

  // No financial history - safe to remove. Clear click rows first, then both
  // profile mirrors.
  await supabaseAdmin.from("partner_clicks").delete().eq("ambassador_id", input.partnerId);
  await supabaseAdmin.from("referrals").delete().eq("partner_id", input.partnerId);

  const { error: ambassadorDeleteError } = await supabaseAdmin.from("ambassadors").delete().eq("id", input.partnerId);
  assertNoSupabaseError("ambassadors.delete", ambassadorDeleteError);

  const { error: partnerDeleteError } = await supabaseAdmin.from("partners").delete().eq("id", input.partnerId);
  assertNoSupabaseError("partners.delete", partnerDeleteError);

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: input.actorUserId ?? null,
    action: "partner_deleted",
    target_table: "partners",
    target_id: input.partnerId,
    metadata: {
      name: existing.name ?? null,
      email: existing.email ?? null,
      actorUsername: input.actorUsername ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

export async function markCommissionsPaid(input: {
  partnerId: string;
  actorUserId?: string;
  amount: number;
  note?: string;
  actorUsername?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  overrideMinimumThreshold?: boolean;
  // The admin must affirm the money has ACTUALLY been transferred before this
  // flips commissions to paid and emails the ambassador "we sent $X". Marking
  // paid is a record of a real transfer, not the transfer itself.
  confirmedTransferred?: boolean;
  // Optional external transfer/transaction reference (e.g. PayPal txn id),
  // recorded on the immutable payout row + audit log.
  transactionReference?: string | null;
}) {
  // Require explicit confirmation that funds were sent — never mark paid (or
  // email the ambassador) off a click alone.
  if (input.confirmedTransferred !== true) {
    throw new Error("Before marking this payout paid, send the funds to the ambassador, then confirm the transfer. This step only RECORDS a payment you've already made.");
  }
  const transactionReference = typeof input.transactionReference === "string"
    ? input.transactionReference.trim().slice(0, 200) || null
    : null;
  // Fold the transfer reference into the payout note so it lives on the
  // immutable payout record without a schema change.
  const payoutNote = [input.note, transactionReference ? `Transfer ref: ${transactionReference}` : null]
    .filter(Boolean)
    .join(" — ") || null;
  // A1: never release a payout for an ambassador who isn't CURRENTLY approved.
  // Commissions that reached approved_for_payout before the ambassador was
  // disabled (e.g. for fraud) must be held until an admin re-approves them —
  // otherwise a disabled ambassador keeps getting paid off their old balance.
  const { data: partnerStatusRow } = await supabaseAdmin
    .from("partners")
    .select("status")
    .eq("id", input.partnerId)
    .maybeSingle();
  const partnerStatus = String(partnerStatusRow?.status ?? "").toLowerCase();
  if (partnerStatus !== "approved") {
    throw new Error(`This ambassador is not currently approved (status: ${partnerStatus || "unknown"}). Re-approve them before releasing a payout, or handle the held balance manually.`);
  }

  const { data: pendingRows, error: pendingError } = await supabaseAdmin
    .from("referral_orders")
    .select("id, commission_amount")
    .eq("ambassador_id", input.partnerId)
    .in("payment_status", ["approved_for_payout"]);

  if (pendingError) {
    assertNoSupabaseError("referral_orders.select(pending payouts)", pendingError);
  }

  const ids = (pendingRows ?? []).map((row) => row.id);
  if (ids.length === 0) {
    return { payoutId: null, orderCount: 0, amount: 0 };
  }

  // The payout amount is ALWAYS the sum of the commissions actually owed, never
  // a caller-supplied number. Trusting `input.amount` let an admin under- or
  // over-pay an ambassador (e.g. flip $500 of commissions to "paid" while
  // recording a $50 payout). We keep the param only for the threshold display.
  const pendingTotal = roundMoney(
    (pendingRows ?? []).reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0),
  );

  if (!input.overrideMinimumThreshold) {
    const ambassadorSettings = await getAmbassadorProgramSettings();
    if (pendingTotal < ambassadorSettings.minimumPayoutThreshold) {
      throw new Error(`Payout amount ($${pendingTotal.toFixed(2)}) is below the $${ambassadorSettings.minimumPayoutThreshold.toFixed(2)} minimum payout threshold. Wait for more commissions to accrue, or explicitly override the threshold to pay out anyway.`);
    }
  }

  // Claim the rows atomically: the `.eq("payment_status", "approved_for_payout")`
  // guard means a concurrent second call (double-click / two admins) claims ZERO
  // rows because they are already "paid", so it inserts no duplicate payout.
  // `.select()` returns exactly the rows this call claimed, which is what we pay.
  const { data: claimedRows, error: updateError } = await supabaseAdmin
    .from("referral_orders")
    .update({ payment_status: "paid", commission_paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("payment_status", "approved_for_payout")
    .select("id, commission_amount, order_id");

  if (updateError) {
    assertNoSupabaseError("referral_orders.update(mark paid)", updateError);
  }

  const claimed = claimedRows ?? [];
  if (claimed.length === 0) {
    // Another concurrent payout already claimed these commissions.
    return { payoutId: null, orderCount: 0, amount: 0 };
  }

  const payoutAmount = roundMoney(
    claimed.reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0),
  );

  // Load the ambassador's recorded payout destination so we can stamp it on the
  // payout record (accounting history) and confirm it in the email.
  const { data: partner } = await supabaseAdmin
    .from("partners")
    .select("name, email, payout_method, payout_handle")
    .eq("id", input.partnerId)
    .maybeSingle();
  const payoutMethod = partner?.payout_method ? String(partner.payout_method) : null;
  const payoutHandle = partner?.payout_handle ? String(partner.payout_handle) : null;

  // A8: flip the mirror by the EXACT order_ids the authoritative update just
  // claimed — not by partner_id+status. A concurrent payout or a partial claim
  // could leave other approved_for_payout rows for this partner that were NOT
  // paid in THIS run; the old partner_id+status filter would flip those too and
  // drift the two ledgers. Keying on the claimed order_ids keeps them exact.
  const claimedOrderIds = claimed.map((row) => row.order_id).filter(Boolean);
  if (claimedOrderIds.length > 0) {
    const { error: commissionMirrorError } = await supabaseAdmin
      .from("commissions")
      .update({ status: "paid", updated_at: new Date().toISOString() })
      .eq("partner_id", input.partnerId)
      .in("order_id", claimedOrderIds);

    if (commissionMirrorError) {
      assertNoSupabaseError("commissions.update(mark paid mirror)", commissionMirrorError);
    }
  }

  const payoutId = randomUUID();

  // Link the just-paid commissions to this payout so it can be reversed later
  // (best-effort — pre-migration the payout_id column doesn't exist and this
  // update simply no-ops without affecting the payout).
  await supabaseAdmin
    .from("referral_orders")
    .update({ payout_id: payoutId })
    .in("id", claimed.map((row) => String(row.id)));

  const { error: payoutError } = await supabaseAdmin
    .from("partner_payouts")
    .insert({
      id: payoutId,
      ambassador_id: input.partnerId,
      amount: payoutAmount,
      note: payoutNote,
      processed_by: input.actorUserId ?? null,
      payout_method: payoutMethod,
      payout_handle: payoutHandle,
    });

  if (payoutError) {
    assertNoSupabaseError("partner_payouts.insert", payoutError);
  }

  const { error: payoutsMirrorError } = await supabaseAdmin
    .from("payouts")
    .insert({
      id: payoutId,
      partner_id: input.partnerId,
      amount: payoutAmount,
      note: payoutNote,
      processed_by: input.actorUserId ?? null,
      payout_method: payoutMethod,
      payout_handle: payoutHandle,
    });

  if (payoutsMirrorError) {
    assertNoSupabaseError("payouts.insert(mirror)", payoutsMirrorError);
  }

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: input.actorUserId ?? null,
    action: "partner_commission_paid",
    target_table: "partner_payouts",
    target_id: payoutId,
    metadata: {
      partnerId: input.partnerId,
      amount: payoutAmount,
      orderCount: claimed.length,
      transactionReference,
      confirmedTransferred: true,
      actorUsername: input.actorUsername ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  // Confirm the payment to the ambassador (best-effort — a failed email must
  // never undo a completed payout).
  if (partner?.email) {
    try {
      const methodLabel = payoutMethod && isValidPayoutMethod(payoutMethod)
        ? AMBASSADOR_PAYOUT_METHOD_LABELS[payoutMethod]
        : (payoutMethod ?? "your chosen method");
      await sendEmail({
        to: String(partner.email),
        ...ambassadorPayoutSentTemplate({
          name: String(partner.name ?? ""),
          amount: payoutAmount,
          method: methodLabel,
          handle: payoutHandle,
          orderCount: claimed.length,
          dashboardUrl: `${getSiteUrl().replace(/\/$/, "")}/account/ambassador`,
        }),
      });
    } catch {
      // Payout already recorded; email is non-critical.
    }
  }

  return {
    payoutId,
    orderCount: claimed.length,
    amount: payoutAmount,
  };
}

// Reverse a mistaken ambassador payout. The payout row is KEPT as an immutable
// record and stamped reversed (who/when/why); the commissions it paid are reset
// to "approved_for_payout" so they re-enter the next payout run. Records an
// audit row. Requires the payout-reversal.sql migration (payout_id link +
// reversal columns); pre-migration a payout has no linked commissions to reset.
export async function reversePayout(input: {
  payoutId: string;
  actorUserId?: string | null;
  actorUsername?: string | null;
  reason?: string | null;
}): Promise<{ reversedCommissions: number; amount: number }> {
  const nowIso = new Date().toISOString();

  const { data: payout, error: loadError } = await supabaseAdmin
    .from("partner_payouts")
    .select("id, ambassador_id, amount, reversed_at")
    .eq("id", input.payoutId)
    .maybeSingle();
  if (loadError) assertNoSupabaseError("partner_payouts.select(reverse)", loadError);
  if (!payout) throw new Error("Payout not found.");
  if (payout.reversed_at) throw new Error("This payout has already been reversed.");

  // Reset the commissions this payout paid. The atomic guard on
  // payment_status='paid' means a concurrent reversal claims zero rows.
  const { data: reset } = await supabaseAdmin
    .from("referral_orders")
    .update({ payment_status: "approved_for_payout", commission_paid_at: null, payout_id: null, updated_at: nowIso })
    .eq("payout_id", input.payoutId)
    .eq("payment_status", "paid")
    .select("id, order_id");
  const reversedCommissions = (reset ?? []).length;

  // Mirror ONLY the reversed commissions back on the commissions ledger.
  const resetOrderIds = (reset ?? []).map((row) => row.order_id).filter(Boolean) as string[];
  if (resetOrderIds.length > 0) {
    await supabaseAdmin
      .from("commissions")
      .update({ status: "approved_for_payout", updated_at: nowIso })
      .in("order_id", resetOrderIds)
      .eq("status", "paid");
  }

  // Stamp both payout tables reversed (records retained, never deleted).
  const reversalPatch = { reversed_at: nowIso, reversed_by: input.actorUsername ?? null, reversal_reason: input.reason ?? null };
  await supabaseAdmin.from("partner_payouts").update(reversalPatch).eq("id", input.payoutId);
  await supabaseAdmin.from("payouts").update(reversalPatch).eq("id", input.payoutId);

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: input.actorUserId ?? null,
    action: "partner_payout_reversed",
    target_table: "partner_payouts",
    target_id: input.payoutId,
    metadata: {
      ambassadorId: payout.ambassador_id,
      amount: Number(payout.amount ?? 0),
      reversedCommissions,
      reason: input.reason ?? null,
      actorUsername: input.actorUsername ?? null,
    },
  });

  return { reversedCommissions, amount: Number(payout.amount ?? 0) };
}
