import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateReferralCode } from "@/lib/referral-code-utils";
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
import { getBusinessSettings, getReferralProgramConfig } from "@/lib/admin-control";
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

async function sendReferralCodeAssignedEmail(input: {
  to: string;
  name: string;
  referralCode: string;
  commissionPercent: number;
}) {
  const template = referralCodeAssignedTemplate({
    name: input.name,
    referralCode: input.referralCode,
    referralLink: `${getSiteUrl()}/r/${input.referralCode}`,
    commissionPercent: input.commissionPercent,
  });

  const result = await sendEmail({ to: input.to, ...template });
  return result.success;
}

async function autoApproveEligibleCommissions() {
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
  if (preferred) {
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

  const partnerInsert = await supabaseAdmin
    .from("partners")
    .insert({
      id: partnerId,
      name: input.name,
      email: input.email,
      referral_code: referralCode,
      status: "pending",
      commission_percent: 15,
      auth_user_id: input.authUserId,
      invited_at: now,
      updated_at: now,
      ...applicantFields,
    });

  if (partnerInsert.error) {
    assertNoSupabaseError("partners.insert(create application)", partnerInsert.error);
  }

  const ambassadorInsert = await supabaseAdmin
    .from("ambassadors")
    .insert({
      id: partnerId,
      name: input.name,
      email: input.email,
      referral_code: referralCode,
      status: "pending",
      commission_percent: 15,
      auth_user_id: input.authUserId,
      invited_at: now,
      updated_at: now,
      ...applicantFields,
    });

  if (ambassadorInsert.error) {
    assertNoSupabaseError("ambassadors.insert(create application mirror)", ambassadorInsert.error);
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
    await enqueueNotification("partner_application_received", input.email, {
      partnerId,
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
  } catch {
    // Admin alert is best-effort; the application itself already succeeded.
  }

  return {
    partnerId,
    status: "pending",
    referralCode,
  };
}

export async function getPartnerProgramStats(): Promise<PartnerProgramStats> {
  await autoApproveEligibleCommissions();

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
    .select("ambassador_id, commission_amount");

  assertNoSupabaseError("referral_orders.select(program partner commission totals)", partnerCommissionError);

  for (const row of partnerCommissionRows ?? []) {
    const partnerId = row.ambassador_id;
    if (!partnerId) continue;
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
  const [{ data: rows, error }, ambassadorSettings] = await Promise.all([
    supabaseAdmin
      .from("referral_orders")
      .select("ambassador_id, commission_amount, approved_for_payout_at")
      .eq("payment_status", "approved_for_payout"),
    getAmbassadorProgramSettings(),
  ]);

  if (error) {
    assertNoSupabaseError("referral_orders.select(payout queue)", error);
  }

  const minimum = ambassadorSettings.minimumPayoutThreshold;
  const byPartner = new Map<string, { amount: number; count: number; earliest: string | null }>();
  for (const row of rows ?? []) {
    const id = String(row.ambassador_id);
    if (!id) continue;
    const agg = byPartner.get(id) ?? { amount: 0, count: 0, earliest: null };
    agg.amount += Number(row.commission_amount ?? 0);
    agg.count += 1;
    const at = row.approved_for_payout_at ? String(row.approved_for_payout_at) : null;
    if (at && (!agg.earliest || at < agg.earliest)) {
      agg.earliest = at;
    }
    byPartner.set(id, agg);
  }

  const partnerIds = Array.from(byPartner.keys());
  const partnerInfo = new Map<string, { name: string; payout_method: string | null; payout_handle: string | null }>();
  if (partnerIds.length > 0) {
    const { data: partners } = await supabaseAdmin
      .from("partners")
      .select("id, name, payout_method, payout_handle")
      .in("id", partnerIds);
    for (const p of partners ?? []) {
      partnerInfo.set(String(p.id), {
        name: String(p.name ?? ""),
        payout_method: p.payout_method ? String(p.payout_method) : null,
        payout_handle: p.payout_handle ? String(p.payout_handle) : null,
      });
    }
  }

  const queueRows: PayoutQueueRow[] = partnerIds.map((id) => {
    const agg = byPartner.get(id)!;
    const info = partnerInfo.get(id);
    const amountOwed = roundMoney(agg.amount);
    return {
      partnerId: id,
      name: info?.name ?? "Unknown",
      amountOwed,
      approvedOrderCount: agg.count,
      payoutMethod: info?.payout_method ?? null,
      payoutHandle: info?.payout_handle ?? null,
      eligibleSince: agg.earliest,
      meetsMinimum: amountOwed >= minimum,
    };
  }).sort((a, b) => b.amountOwed - a.amountOwed);

  return {
    rows: queueRows,
    readyCount: queueRows.filter((r) => r.meetsMinimum).length,
    totalOwed: roundMoney(queueRows.reduce((sum, r) => sum + r.amountOwed, 0)),
    minimumPayoutThreshold: minimum,
  };
}

export async function getPartnerSummary(partnerId: string, siteUrl: string): Promise<PartnerSummary> {
  const [{ data: partner, error: partnerError }, { data: commissionRows, error: commissionError }, { data: orderRows, error: orderError }, { data: clickRows, error: clickError }, { data: payoutRows, error: payoutError }] = await Promise.all([
    supabaseAdmin
      .from("partners")
      .select("id, name, referral_code, commission_percent, status, payout_method, payout_handle")
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
  const REVERSED_COMMISSION_STATUSES = new Set(["reversed", "voided", "manual_review"]);
  const earnedCommissions = commissions.filter((row) => !REVERSED_COMMISSION_STATUSES.has(String(row.payment_status)));
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

  const recentOrders = commissions.slice(0, 8).map((commission) => {
    const order = orders.find((row) => row.order_id === commission.order_id);
    return {
      orderId: commission.order_id,
      createdAt: commission.created_at,
      customerEmail: order?.customer_email ?? null,
      amountPaid: roundMoney(Number(order?.amount_paid ?? 0)),
      paymentStatus: order?.payment_status ?? "pending_payment",
      commissionAmount: roundMoney(Number(commission.commission_amount ?? 0)),
      commissionStatus: commission.payment_status,
    };
  });

  const marketingResources = await getAmbassadorMarketingResources().catch(() => []);

  return {
    partnerId: partner.id,
    partnerName: partner.name,
    referralCode: partner.referral_code,
    referralLink: `${siteUrl.replace(/\/$/, "")}/r/${partner.referral_code}`,
    commissionPercent: Number(partner.commission_percent ?? 15),
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

  const [{ data: partners, error: partnerError }, { data: commissionRows, error: commissionError }, { data: orderRows, error: orderError }, { data: clickRows, error: clickError }] = await Promise.all([
    query,
    supabaseAdmin.from("referral_orders").select("ambassador_id, commission_amount, payment_status"),
    supabaseAdmin.from("orders").select("ambassador_id, amount_paid, payment_status"),
    supabaseAdmin.from("partner_clicks").select("ambassador_id"),
  ]);

  assertNoSupabaseError("partners.select(admin partner rows)", partnerError);
  assertNoSupabaseError("referral_orders.select(admin commission rows)", commissionError);
  assertNoSupabaseError("orders.select(admin order rows)", orderError);
  assertNoSupabaseError("partner_clicks.select(admin click rows)", clickError);

  const commissionByPartner = new Map<string, { total: number; pending: number; approvedForPayout: number; paid: number; reversed: number }>();
  for (const row of commissionRows ?? []) {
    const partnerId = row.ambassador_id;
    if (!partnerId) continue;
    const current = commissionByPartner.get(partnerId) ?? { total: 0, pending: 0, approvedForPayout: 0, paid: 0, reversed: 0 };
    const amount = Number(row.commission_amount ?? 0);
    current.total += amount;
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

  const ordersByPartner = new Map<string, { totalRevenue: number; totalOrders: number }>();
  for (const row of orderRows ?? []) {
    const partnerId = row.ambassador_id;
    if (!partnerId || row.payment_status !== "paid") continue;
    const current = ordersByPartner.get(partnerId) ?? { totalRevenue: 0, totalOrders: 0 };
    current.totalRevenue += Number(row.amount_paid ?? 0);
    current.totalOrders += 1;
    ordersByPartner.set(partnerId, current);
  }

  const clickCounts = new Map<string, number>();
  for (const row of clickRows ?? []) {
    const partnerId = row.ambassador_id;
    if (!partnerId) continue;
    clickCounts.set(partnerId, (clickCounts.get(partnerId) ?? 0) + 1);
  }

  const mappedRows = (partners ?? []).map((partner) => {
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
      commissionPercent: Number(partner.commission_percent ?? 15),
      commissionPercentLocked: Boolean(partner.commission_percent_locked),
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
    { data: todayOrders, error: todayError },
    { data: monthOrders, error: monthError },
    { data: allPaidOrders, error: paidError },
    { data: inventoryRows, error: inventoryError },
    { data: shipmentRows, error: shipmentError },
    { data: couponRows, error: couponError },
    { data: notificationRows, error: notificationError },
  ] = await Promise.all([
    supabaseAdmin.from("orders").select("amount_paid").eq("payment_status", "paid").gte("created_at", todayStart),
    supabaseAdmin.from("orders").select("amount_paid").eq("payment_status", "paid").gte("created_at", monthStart),
    supabaseAdmin.from("orders").select("customer_email").eq("payment_status", "paid"),
    supabaseAdmin.from("products").select("inventory_quantity, stock_status, low_stock_threshold").eq("is_archived", false),
    supabaseAdmin.from("order_shipments").select("shipping_status").neq("shipping_status", "delivered"),
    supabaseAdmin.from("coupons").select("id").eq("active", true),
    supabaseAdmin.from("notification_queue").select("id").eq("status", "pending"),
  ]);

  assertNoSupabaseError("orders.select(live sales today)", todayError);
  assertNoSupabaseError("orders.select(live sales month)", monthError);
  assertNoSupabaseError("orders.select(customer analytics)", paidError);

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

  const liveSalesToday = roundMoney((todayOrders ?? []).reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0));
  const liveSalesMonth = roundMoney((monthOrders ?? []).reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0));

  const customerOrderCount = new Map<string, number>();
  for (const row of allPaidOrders ?? []) {
    const email = row.customer_email;
    if (!email) continue;
    customerOrderCount.set(email, (customerOrderCount.get(email) ?? 0) + 1);
  }

  const newCustomers = Array.from(customerOrderCount.values()).filter((count) => count === 1).length;
  const returningCustomers = Array.from(customerOrderCount.values()).filter((count) => count > 1).length;
  const totalCustomers = customerOrderCount.size;

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
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("partners")
    .insert({
      id: partnerId,
      name: input.name,
      email: input.email,
      referral_code: referralCode,
      status: "pending",
      commission_percent: input.commissionPercent,
      auth_user_id: invitedUser.user?.id ?? null,
      invited_at: now,
      created_by: actorUserId,
      updated_at: now,
    });

  if (error) {
    assertNoSupabaseError("partners.insert(create invite)", error);
  }

  const { error: ambassadorInsertError } = await supabaseAdmin
    .from("ambassadors")
    .insert({
      id: partnerId,
      name: input.name,
      email: input.email,
      referral_code: referralCode,
      status: "pending",
      commission_percent: input.commissionPercent,
      auth_user_id: invitedUser.user?.id ?? null,
      invited_at: now,
      created_by: actorUserId,
      updated_at: now,
    });

  if (ambassadorInsertError) {
    assertNoSupabaseError("ambassadors.insert(create invite mirror)", ambassadorInsertError);
  }

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: actorUserId,
    action: "partner_invited",
    target_table: "ambassadors",
    target_id: partnerId,
    metadata: {
      email: input.email,
      commissionPercent: input.commissionPercent,
      referralCode,
      actorUsername: input.actorUsername ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  return {
    partnerId,
    referralCode,
  };
}

export async function updatePartnerStatus(input: {
  partnerId: string;
  status: "approved" | "disabled" | "pending" | "rejected" | "info_requested";
  actorUserId?: string;
  commissionPercent?: number;
  commissionPercentLocked?: boolean;
  referralCode?: string;
  actorUsername?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const { data: existingPartner, error: partnerLookupError } = await supabaseAdmin
    .from("partners")
    .select("id, name, email, referral_code, commission_percent")
    .eq("id", input.partnerId)
    .maybeSingle();

  assertNoSupabaseError("partners.select(status update lookup)", partnerLookupError);

  if (!existingPartner) {
    throw new Error("Partner not found");
  }

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

  const updatePayload: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };

  if (input.status === "approved") {
    const { data: existingPartner } = await supabaseAdmin
      .from("partners")
      .select("status, approved_at")
      .eq("id", input.partnerId)
      .maybeSingle();

    if (existingPartner?.status !== "approved" || !existingPartner?.approved_at) {
      updatePayload.approved_at = new Date().toISOString();
    }
    updatePayload.disabled_at = null;
  }

  if (input.status === "disabled") {
    updatePayload.disabled_at = new Date().toISOString();
  }

  if (input.status === "rejected") {
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

  if (normalizedReferralCode) {
    updatePayload.referral_code = normalizedReferralCode;
  }

  const [{ error: partnerUpdateError }, { error: ambassadorUpdateError }] = await Promise.all([
    supabaseAdmin.from("partners").update(updatePayload).eq("id", input.partnerId),
    supabaseAdmin.from("ambassadors").update(updatePayload).eq("id", input.partnerId),
  ]);

  assertNoSupabaseError("partners.update(status)", partnerUpdateError);
  assertNoSupabaseError("ambassadors.update(status mirror)", ambassadorUpdateError);

  const finalReferralCode = normalizedReferralCode ?? existingPartner.referral_code;
  const referralCodeChanged = Boolean(normalizedReferralCode) && normalizedReferralCode !== existingPartner.referral_code;

  // Email/notification-queue side effects must never block the status
  // update itself or the audit log entry below — isolated in its own
  // try/catch so a failed send (or an unconfigured provider) can't leave
  // the admin action half-finished or skip the audit trail.
  if ((input.status === "approved" || input.status === "rejected") && existingPartner.email) {
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
        commissionPercent: input.commissionPercent ?? 0,
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
}) {
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
    .select("id, commission_amount");

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

  const { error: commissionMirrorError } = await supabaseAdmin
    .from("commissions")
    .update({ status: "paid", updated_at: new Date().toISOString() })
    .eq("partner_id", input.partnerId)
    // Mirror only what the authoritative referral_orders update above actually
    // pays (approved_for_payout). Previously this also flipped "pending" rows,
    // so the two ledgers drifted - pending commissions that were never paid out
    // showed as paid in the mirror.
    .in("status", ["approved_for_payout"]);

  if (commissionMirrorError) {
    assertNoSupabaseError("commissions.update(mark paid mirror)", commissionMirrorError);
  }

  const payoutId = randomUUID();

  const { error: payoutError } = await supabaseAdmin
    .from("partner_payouts")
    .insert({
      id: payoutId,
      ambassador_id: input.partnerId,
      amount: payoutAmount,
      note: input.note ?? null,
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
      note: input.note ?? null,
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
