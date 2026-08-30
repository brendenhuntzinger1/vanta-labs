import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateReferralCode } from "@/lib/referral-code-utils";
import { validateReferralCodeFormat } from "@/lib/referral-code-validation";
import { isEarnedCommission, isRevenueOrderStatus, isSaleOrder, netOrderRevenue, REVENUE_ORDER_STATUSES } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { sendEmail } from "@/lib/email/send";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
import type { EmailTemplate } from "@/lib/email/types";
import {
  ambassadorApplicationReceivedTemplate,
  ambassadorApprovedTemplate,
  ambassadorInfoRequestedTemplate,
  ambassadorInviteTemplate,
  ambassadorDeniedTemplate,
  ambassadorPayoutSentTemplate,
  newAmbassadorApplicationTemplate,
  referralCodeAssignedTemplate,
} from "@/lib/email/templates";
import { recordSystemAlert } from "@/lib/monitoring";
import { getSiteUrl } from "@/lib/env";
import { brandedConfirmUrl } from "@/lib/auth-confirm-link";
import { DEFAULT_REFERRAL_DISCOUNT_PERCENT, getBusinessSettings, getReferralProgramConfig } from "@/lib/admin-control";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { getAmbassadorProgramSettings, getAmbassadorMarketingResources, type AmbassadorMarketingResource } from "@/lib/ambassador-settings";
import { DEFAULT_COMMISSION_HOLD_DAYS } from "@/lib/referral-config";

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
  /**
   * How long an earned commission is held before payout, from the same
   * `getAmbassadorProgramSettings()` the accrual reads.
   *
   * Carried on the payload because the number was typed into the copy: the
   * dashboard, the programme landing page and the ambassador hub all said
   * "14-day hold" while production held 30, and the setting was changed without
   * them. An ambassador planning around a promised payout date is the last
   * person who should be reading a stale constant.
   */
  commissionHoldDays: number;
  /**
   * What an approved ambassador saves on their OWN orders, from the same
   * `getReferralProgramConfig()` quote-order applies. Same reason: the welcome
   * paragraph printed a literal 15% while the programme gave 20%.
   */
  personalDiscountPercent: number;
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
  // The CONFIGURED hold, read from the Control Center — never a literal in the
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

// Ceiling on ONE paged read, not a definition of the answer — the same value
// admin-analytics.ts and admin-revenue.ts put on their money reads. It exists so
// a runaway table bounds memory, not so a number can quietly come back short:
// readAllRowsBounded reports `truncated` rather than returning a smaller total
// as though it were the answer.
const MAX_PARTNER_ROWS = 200_000;

// PostgREST puts an `in.(...)` filter in the REQUEST URL, so a filter built from
// a paged read is a 414 rather than a write once the list is long enough. Any
// filter whose length is now bounded by the table rather than by one page is
// applied in slices of this size.
const ID_FILTER_SLICE = 150;

// Per-tick ceiling for the auto-approval sweep. Sized far above any plausible
// one-hour backlog so it is normally never the binding limit, but finite so a
// runaway pending table cannot pull the whole thing into memory. Rows it does
// not reach stay `pending` and are picked up by the next tick — the sweep is
// idempotent and ordered oldest-first.
const MAX_AUTO_APPROVE_ROWS = 50_000;

function chunkIds<T>(ids: T[], size = ID_FILTER_SLICE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
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

// ---------------------------------------------------------------------------
// EVERY AMBASSADOR EMAIL GOES THROUGH HERE (audit E4).
//
// What was wrong. Ambassador mail was the only transactional family in the app
// with NO durable retry and NO failure signal. The order paths enqueue a failed
// send to `pending_emails`, which the cron sweep drains with backoff; nothing
// in this file did. Worse, most call sites wrote
//
//     try { await sendEmail(...) } catch { /* non-critical */ }
//
// and `sendEmail` is documented to NEVER THROW — it returns `{ success: false }`
// — so the catch was dead code and a failed send left no trace anywhere: not in
// Sentry, not in a log table, not on the admin dashboard. An approved
// ambassador simply never heard, and no one could find out.
//
// This routes every one of them through the same queue the receipts use. The
// return value still says whether the email went out NOW, because callers use
// it to decide whether to close a notification_queue row — but a `false` now
// means "queued for retry", not "gone for ever".
// ---------------------------------------------------------------------------
async function sendAmbassadorEmail(
  to: string,
  template: EmailTemplate,
  context: string,
  /**
   * `replyTo` exists for the one message whose copy tells the recipient to
   * reply: "needs more info". A reply to noreply@ goes nowhere, so that
   * instruction is only true if the header points at a human. It rides on the
   * queued copy too — a message that retries an hour later must keep the same
   * reply path, or the retry silently downgrades the very thing that made the
   * original correct.
   */
  options?: { replyTo?: string },
): Promise<boolean> {
  const message = { to, ...template, replyTo: options?.replyTo };
  const result = await sendEmail(message);
  if (result.success) {
    return true;
  }

  console.error(`[partner-portal] ${context} email failed for ${to}: ${result.error ?? "unknown error"}`);
  // Best-effort by construction: enqueueFailedEmail swallows a missing table
  // and never throws, so a queue that is not migrated yet cannot turn a failed
  // notification into a failed approval.
  await enqueueFailedEmail(message, result.error);
  return false;
}

async function sendPartnerStatusEmail(input: {
  to: string;
  name: string;
  status: "approved" | "rejected";
  referralCode?: string;
  /**
   * The ambassador's rate as stored in `ambassadors` — the table checkout and
   * commission accrual read — as it stands AFTER the update this email is
   * announcing. The caller used to pass the `partners` copy, which this same
   * function calls "the mirror" and "a display copy", from a snapshot taken
   * BEFORE the update. So approving and setting a rate in one action emailed
   * the previous number, and any drift between the two tables emailed the one
   * that does not govern the money.
   */
  commissionPercent?: number | string | null;
}) {
  let template;
  if (input.status === "approved") {
    // Enrich the approval email with the live program terms so the ambassador
    // gets the full onboarding: their rates, the configured hold, biweekly
    // payouts. The hold is read from settings below, never named here.
    const [referralProgram, ambassadorSettings] = await Promise.all([
      getReferralProgramConfig().catch(() => null),
      getAmbassadorProgramSettings().catch(() => null),
    ]);
    // What the ambassador will ACTUALLY be paid, then the program default —
    // the resolution sendReferralCodeAssignedEmail's header has always claimed
    // this email used. The rate typed into this request needs no separate slot:
    // the authoritative row is read back AFTER the write, so it already carries
    // it. Quoting the database rather than the request also means a write that
    // silently matched no rows cannot produce an email promising a rate nobody
    // holds.
    // An explicit 0 is honoured — an owner may genuinely run a 0% ambassador —
    // but null/undefined/"" means "look further", never "email them zero".
    // When nothing at all is known the value stays undefined so the template's
    // own default applies, rather than asserting a rate nobody configured.
    const rateCandidates = [
      input.commissionPercent,
      referralProgram?.defaultCommissionPercent,
    ];
    const haveRate = rateCandidates.some((candidate) =>
      candidate !== null && candidate !== undefined
      && !(typeof candidate === "string" && candidate.trim() === "")
      && Number.isFinite(Number(candidate)));

    template = ambassadorApprovedTemplate({
      name: input.name,
      referralCode: input.referralCode,
      dashboardUrl: `${getSiteUrl().replace(/\/$/, "")}/account/ambassador`,
      commissionPercent: haveRate ? firstFinitePercent(rateCandidates) : undefined,
      personalDiscountPercent: referralProgram?.personalDiscountPercent,
      referralDiscountPercent: referralProgram?.discountPercent,
      holdDays: ambassadorSettings?.commissionHoldDays,
    });
  } else {
    template = ambassadorDeniedTemplate({ name: input.name });
  }

  return sendAmbassadorEmail(input.to, template, `ambassador ${input.status}`);
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
    dashboardUrl: `${getSiteUrl().replace(/\/$/, "")}/account/ambassador`,
  });

  return sendAmbassadorEmail(input.to, template, "referral code assigned");
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
  // `now - created_at >= holdPeriodMs` is exactly `created_at <= now - hold`.
  // Applying it in the query rather than only in JS below is what keeps this
  // read from growing with the whole pending backlog: rows still inside their
  // hold window, and fraud-flagged rows (which never auto-approve at all), are
  // the two groups that otherwise sit in `pending` and get re-read every tick.
  const holdCutoffIso = new Date(now.getTime() - holdPeriodMs).toISOString();

  // PAGED. This is a cron sweep over a table that grows with every referred
  // order, and an unpaged read stops silently at the server's row cap — which
  // here means commissions past the cap simply never auto-approve, with no
  // error anywhere. The JS filter below still decides eligibility; the query
  // only narrows what has to be read.
  const { rows: pendingRows, truncated: pendingTruncated } = await readAllRowsBounded<{
    id: string;
    order_id: string;
    ambassador_id: string | null;
    created_at: string;
    payment_status: string | null;
    ineligible_reason: string | null;
    fraud_flag: boolean | null;
  }>(
    (from, to) => supabaseAdmin
      .from("referral_orders")
      .select("id, order_id, ambassador_id, created_at, payment_status, ineligible_reason, fraud_flag")
      .eq("payment_status", "pending")
      .not("fraud_flag", "is", true)
      .lte("created_at", holdCutoffIso)
      .order("created_at", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{
        id: string;
        order_id: string;
        ambassador_id: string | null;
        created_at: string;
        payment_status: string | null;
        ineligible_reason: string | null;
        fraud_flag: boolean | null;
      }> | null; error: unknown }>,
    { maxRows: MAX_AUTO_APPROVE_ROWS, label: "referral_orders.select(auto approve pending)" },
  );

  if (pendingTruncated) {
    // Not an error: the sweep is idempotent and runs again, and rows it did not
    // reach are still `pending`. Worth saying out loud, because a backlog this
    // size means approvals are falling behind the order rate.
    console.warn(
      `autoApproveEligibleCommissions: more than ${MAX_AUTO_APPROVE_ROWS} pending commissions are past their hold period; approving the oldest ${MAX_AUTO_APPROVE_ROWS} this run.`,
    );
  }

  if (pendingRows.length === 0) {
    return;
  }

  // Only approved ambassadors' commissions auto-approve. A deactivated/removed
  // ambassador's already-accrued commissions never advance to payable.
  const ambassadorIds = Array.from(
    new Set(pendingRows.map((row) => row.ambassador_id).filter(Boolean)),
  );
  // BOTH tables must say approved — the same rule markCommissionsPaid applies
  // before releasing a payout. Gating accrual on `ambassadors` alone while the
  // payout gate read `partners` let commissions advance to approved_for_payout
  // for someone the payout gate would then refuse forever.
  //
  // SLICED, like markCommissionsPaid below: `ambassadorIds` is now bounded by
  // the pending backlog rather than by one page, and PostgREST puts `in.(...)`
  // in the request URL — a few hundred uuids there is a 414, which would abort
  // the sweep and stop every payout rather than approve anything.
  const ambassadorRows: Array<{ id: string; status: string | null }> = [];
  const partnerStatusRows: Array<{ id: string; status: string | null }> = [];
  for (const slice of chunkIds(ambassadorIds)) {
    const [
      { data: ambassadorSlice, error: ambassadorError },
      { data: partnerSlice, error: partnerStatusError },
    ] = await Promise.all([
      supabaseAdmin.from("ambassadors").select("id, status").in("id", slice),
      supabaseAdmin.from("partners").select("id, status").in("id", slice),
    ]);
    assertNoSupabaseError("ambassadors.select(auto approve status)", ambassadorError);
    assertNoSupabaseError("partners.select(auto approve status)", partnerStatusError);
    ambassadorRows.push(...((ambassadorSlice ?? []) as Array<{ id: string; status: string | null }>));
    partnerStatusRows.push(...((partnerSlice ?? []) as Array<{ id: string; status: string | null }>));
  }
  const approvedInPartners = new Set(
    partnerStatusRows.filter((row) => row.status === "approved").map((row) => row.id),
  );
  const approvedAmbassadorIds = new Set(
    ambassadorRows
      .filter((row) => row.status === "approved" && approvedInPartners.has(row.id))
      .map((row) => row.id),
  );

  const orderIds = pendingRows.map((row) => row.order_id).filter(Boolean);
  if (orderIds.length === 0) {
    return;
  }

  const orderRows: Array<{ order_id: string; payment_status: string | null }> = [];
  for (const slice of chunkIds(orderIds)) {
    const { data: orderSlice, error: orderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, payment_status")
      .in("order_id", slice);

    assertNoSupabaseError("orders.select(auto approve pending)", orderError);
    orderRows.push(...((orderSlice ?? []) as Array<{ order_id: string; payment_status: string | null }>));
  }

  const orderStatusById = new Map(orderRows.map((row) => [row.order_id, row.payment_status]));

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

  // Guard the write with the status we READ. The select above and this update
  // are separate requests, so anything can happen to these rows in between — a
  // refund reversing one, an admin releasing a payout, another sweep still
  // running. Without the guard this update overwrites all of them, dragging
  // money that was reversed (or already paid) back into the payout queue, where
  // it gets paid again. markCommissionsPaid has always claimed its rows this
  // way; this path never did.
  //
  // SLICED for the URL-length reason above. Safe to split: the per-ROW
  // `.eq("payment_status", "pending")` guard is what makes the claim correct,
  // not the fact that it used to be one statement — a row can still only be
  // claimed once, so nothing is approved twice and nothing is lost. A slice
  // that fails leaves the rows it did not claim `pending` for the next tick.
  const claimedRows: Array<{ id: string; order_id: string }> = [];
  for (const slice of chunkIds(eligibleIds)) {
    const { data: claimedSlice, error: approveError } = await supabaseAdmin
      .from("referral_orders")
      .update({ payment_status: "approved_for_payout", approved_for_payout_at: approvedAt, updated_at: approvedAt })
      .in("id", slice)
      .eq("payment_status", "pending")
      .select("id, order_id");

    assertNoSupabaseError("referral_orders.update(auto approve)", approveError);
    claimedRows.push(...((claimedSlice ?? []) as Array<{ id: string; order_id: string }>));
  }

  // Mirror only what this call actually claimed, not what it hoped to claim.
  // Keying off the pre-read list would move `commissions` rows whose
  // authoritative row was just claimed by someone else.
  const claimedOrderIds = claimedRows.map((row) => row.order_id).filter(Boolean);

  for (const slice of chunkIds(claimedOrderIds)) {
    const { error: mirrorError } = await supabaseAdmin
      .from("commissions")
      .update({ status: "approved_for_payout", updated_at: approvedAt })
      .in("order_id", slice)
      // Same reasoning one statement later: a reversal can land between the two
      // ledger writes, and an unguarded mirror would silently undo it on this
      // side only, leaving the two ledgers disagreeing about the same order.
      .eq("status", "pending");

    assertNoSupabaseError("commissions.update(auto approve)", mirrorError);
  }
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
    // Result checked, and a failure queued for retry. This used to discard it
    // inside a catch that could never fire — see sendAmbassadorEmail.
    await sendAmbassadorEmail(input.email, template, "application received");
  } catch (applicantEmailError) {
    // Genuinely unexpected (the queue insert throwing, say). The application
    // itself already succeeded above and must not be undone by it.
    console.error("[partner-portal] application-received notification failed", applicantEmailError);
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
    let ownerAlerted = false;
    if (supportEmail) {
      const ownerAlert = newAmbassadorApplicationTemplate({
        applicantName: input.name,
        applicantEmail: input.email,
        adminUrl: `${getSiteUrl().replace(/\/$/, "")}/admin/partners`,
      });
      ownerAlerted = await sendAmbassadorEmail(supportEmail, ownerAlert, "new application (owner alert)");
    } else {
      // No support address configured, so there is no owner alert to wait on
      // and nothing this row is still holding open.
      ownerAlerted = true;
    }

    // Close the queue row ONLY when the owner alert actually went out. It used
    // to be marked sent regardless of the result, so the admin's "pending
    // notifications" count reported work as handled that had never happened —
    // the precise opposite of what the count is for. A queued retry leaves the
    // row pending, which is now accurate rather than decorative.
    if (applicationQueueRowId && ownerAlerted) {
      const { error: markSentError } = await supabaseAdmin
        .from("notification_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", applicationQueueRowId);
      if (markSentError && !isMissingRelationError(markSentError, "notification_queue")) {
        assertNoSupabaseError("notification_queue.update(application received sent)", markSentError);
      }
    }
  } catch (adminAlertError) {
    // The application itself already succeeded and must not be undone by a
    // notification. Logged rather than swallowed: a silent catch here is how the
    // original defect stayed invisible for a month.
    console.error("[partner-portal] new-application admin alert failed", adminAlertError);
  }

  return resolved;
}

export async function getPartnerProgramStats(): Promise<PartnerProgramStats> {
  // NOTE: the commission auto-approval sweep is intentionally NOT run here.
  // This stats read is served by the UNAUTHENTICATED /api/partner/program-stats
  // endpoint, and money-state transitions must not be drivable (or DoS-able) by
  // anonymous traffic. The scheduled cron (/api/cron/sweep) owns the sweep.

  // PAGED, BECAUSE A WHOLE-TABLE `select` IS NOT UNBOUNDED.
  //
  // PostgREST caps every response at its `db-max-rows` (Supabase's default is
  // 1,000) and says nothing when it does — the response is a valid array that
  // simply stops. Both of these reads are whole-table and feed PUBLIC numbers:
  // past a thousand payouts "total commissions paid" would silently stop
  // growing, and past a thousand commission rows the average and top-earner
  // figures would be computed from an arbitrary slice of ambassadors.
  //
  // `.order("id")` is the deterministic tiebreak paging needs — without a
  // stable key a page can repeat or skip rows.
  const [payoutRead, { data: partnerRows, error: partnerError }, { data: programStatsRows, error: statsError }] = await Promise.all([
    readAllRowsBounded<{ amount: number | null }>(
      (from, to) => supabaseAdmin
        .from("partner_payouts")
        .select("amount")
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Array<{ amount: number | null }> | null; error: { message?: string } | null }>,
      { maxRows: MAX_PARTNER_ROWS, label: "program payouts read" },
    ),
    supabaseAdmin.from("partners").select("id, invited_at, approved_at"),
    supabaseAdmin.from("partner_program_stats").select("key, value_numeric"),
  ]);

  assertNoSupabaseError("partners.select(program partner approvals)", partnerError);
  assertNoSupabaseError("partner_program_stats.select(configurable stats)", statsError);

  const overrides = new Map((programStatsRows ?? []).map((row) => [row.key, Number(row.value_numeric ?? 0)]));

  const totalCommissionsPaid = roundMoney(payoutRead.rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0));

  const commissionByPartner = new Map<string, number>();
  type ProgramCommissionRow = { ambassador_id: string | null; commission_amount: number | null; payment_status: string | null };
  const { rows: partnerCommissionRows } = await readAllRowsBounded<ProgramCommissionRow>(
    (from, to) => supabaseAdmin
      .from("referral_orders")
      .select("ambassador_id, commission_amount, payment_status")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: ProgramCommissionRow[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_PARTNER_ROWS, label: "program partner commission totals read" },
  );

  for (const row of partnerCommissionRows) {
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

type PartnerSummaryCommissionRow = {
  order_id: string;
  commission_amount: number | null;
  // `referral_orders.payment_status` is `text not null default 'pending'`.
  payment_status: string;
  created_at: string;
};

type PartnerSummaryOrderRow = {
  order_id: string;
  customer_email: string | null;
  amount_paid: number | null;
  refund_amount: number | null;
  order_type: string | null;
  payment_status: string | null;
  created_at: string;
};

type PartnerSummaryPayoutRow = {
  id: string;
  amount: number | null;
  note: string | null;
  created_at: string;
};

export async function getPartnerSummary(partnerId: string, siteUrl: string): Promise<PartnerSummary> {
  // The hold period, read from the function that decides it rather than typed
  // into the page. `referralProgram` is already read further down for the
  // customer discount and is reused for the personal one — one read, one
  // answer. Both fall back to the shared defaults, as every other reader does.
  const ambassadorSettings = await getAmbassadorProgramSettings().catch(() => null);

  // PAGED, LIKE EVERY OTHER READ THAT FEEDS A MONEY FIGURE.
  //
  // These carried no `.range()` and no `.limit()`, which is not the same as
  // unbounded: PostgREST caps every response at its `db-max-rows` (Supabase's
  // default is 1,000) and says nothing when it does. That direction is
  // especially bad here because both reads are DESCENDING, so a capped page
  // drops the OLDEST rows first — the long-unpaid `pending` and
  // `approved_for_payout` commissions are exactly the ones an ambassador is
  // chasing, and their balance would come back short with no error anywhere.
  //
  // The descending sort is kept (recentOrders below slices the newest 50 off
  // the front) with `.order("id")` added as the deterministic tiebreak paging
  // needs — created_at is not unique, so ordering on it alone can repeat or
  // skip rows between pages.
  const [{ data: partner, error: partnerError }, commissionRead, orderRead, clickRead, payoutRead] = await Promise.all([
    supabaseAdmin
      .from("partners")
      .select("id, name, referral_code, commission_percent, customer_discount_percent, status, payout_method, payout_handle")
      .eq("id", partnerId)
      .single(),
    readAllRowsBounded<PartnerSummaryCommissionRow>(
      (from, to) => supabaseAdmin
        .from("referral_orders")
        .select("order_id, commission_amount, payment_status, created_at")
        .eq("ambassador_id", partnerId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: PartnerSummaryCommissionRow[] | null; error: { message?: string } | null }>,
      { maxRows: MAX_PARTNER_ROWS, label: "partner summary commissions read" },
    ),
    readAllRowsBounded<PartnerSummaryOrderRow>(
      (from, to) => supabaseAdmin
        .from("orders")
        .select("order_id, customer_email, amount_paid, refund_amount, order_type, payment_status, created_at")
        .eq("ambassador_id", partnerId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: PartnerSummaryOrderRow[] | null; error: { message?: string } | null }>,
      { maxRows: MAX_PARTNER_ROWS, label: "partner summary orders read" },
    ),
    // Only the COUNT of clicks is used — it is the conversion-rate denominator,
    // and a capped read inflated the rate by pretending the ambassador had
    // fewer clicks than they did. Paged rather than counted with `head: true`
    // because `.range()` is what the local verification harness's PostgREST
    // stand-in implements; a HEAD request is not.
    readAllRowsBounded<{ id: string }>(
      (from, to) => supabaseAdmin
        .from("partner_clicks")
        .select("id")
        .eq("ambassador_id", partnerId)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Array<{ id: string }> | null; error: { message?: string } | null }>,
      { maxRows: MAX_PARTNER_ROWS, label: "partner summary clicks read" },
    ),
    readAllRowsBounded<PartnerSummaryPayoutRow>(
      (from, to) => supabaseAdmin
        .from("partner_payouts")
        .select("id, amount, note, created_at")
        .eq("ambassador_id", partnerId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: PartnerSummaryPayoutRow[] | null; error: { message?: string } | null }>,
      { maxRows: MAX_PARTNER_ROWS, label: "partner summary payouts read" },
    ),
  ]);

  assertNoSupabaseError("partners.select(partner summary)", partnerError);

  if (!partner) {
    throw new Error(`Partner not found for id ${partnerId}`);
  }

  const commissions = commissionRead.rows;
  const orders = orderRead.rows;
  const payoutRows = payoutRead.rows;

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
  // Pending (still in the configured hold) vs Approved (hold cleared, awaiting the
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

  // THE LEDGER'S DEFINITION OF REVENUE, not `status === "paid"` and gross
  // `amount_paid`. This drives the ambassador's "Sales generated" tile and the
  // series under it, and it disagreed with the RPC that serves the admin's view
  // of the same partner (admin_partner_rollups already nets refunds over
  // REVENUE_ORDER_STATUSES with replacements excluded). Concretely: a $200 order
  // refunded by $50 vanished entirely, because `partially_refunded` is not
  // "paid" — and a replacement reship, written paid with amount_paid 0, counted
  // as one of the ambassador's orders and dragged their average order value
  // down with a $0 denominator.
  const paidOrders = orders.filter(
    (order) => isRevenueOrderStatus(order.payment_status) && isSaleOrder(order.order_type),
  );
  const totalRevenue = roundMoney(paidOrders.reduce((sum, row) => sum + netOrderRevenue(row), 0));
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
  const totalClicks = clickRead.rows.length;
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
    commissionHoldDays: ambassadorSettings?.commissionHoldDays ?? DEFAULT_COMMISSION_HOLD_DAYS,
    personalDiscountPercent: referralProgram?.personalDiscountPercent ?? 0,
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
    // NET, so the chart totals to the headline above it rather than to a
    // gross number the tile no longer shows.
    monthlyRevenueSeries: buildRevenueSeriesByMonth(paidOrders.map((row) => ({ created_at: row.created_at, amount_paid: netOrderRevenue(row) }))),
    lifetimeRevenueSeries: buildLifetimeSeries(paidOrders.map((row) => ({ created_at: row.created_at, amount_paid: netOrderRevenue(row) }))),
    marketingResources,
    accountStatus: String(partner.status ?? "approved"),
    payoutHistory: payoutRows.map((row) => ({
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
      supabaseAdmin.from("orders").select("ambassador_id, amount_paid, refund_amount, order_type, payment_status"),
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
      // Same ledger rule the RPC above already applies (admin-partner-rollups.sql
      // nets refunds over REVENUE_ORDER_STATUSES and drops replacements). This
      // branch summed gross amount_paid for status 'paid' only, so whether a
      // partner's revenue column included a partly refunded order depended on
      // whether the rollup migration happened to be present.
      if (!partnerId || !isRevenueOrderStatus(row.payment_status) || !isSaleOrder(row.order_type)) continue;
      const current = ordersByPartner.get(partnerId) ?? { totalRevenue: 0, totalOrders: 0 };
      current.totalRevenue += netOrderRevenue(row);
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
    // Fallback: RPC not migrated yet — legacy scans + JS aggregation.
    //
    // This MUST reach the same number as admin_ops_summary above. It used to
    // claim "identical math" in a comment while summing GROSS amount_paid over
    // payment_status='paid' only: refunds were ignored, partially-refunded
    // orders were dropped entirely, and replacement reships (paid, $0) were
    // counted as sales. The RPC path had already been corrected, so whether
    // "live sales today" included a refund depended on whether the rollup
    // migration happened to be present. Both paths now resolve revenue through
    // ledger.ts — netOrderRevenue over REVENUE_ORDER_STATUSES, replacements
    // excluded — which is what makes this tile agree with /admin/revenue.
    const revenueStatuses = [...REVENUE_ORDER_STATUSES];
    const [
      { data: todayOrders, error: todayError },
      { data: monthOrders, error: monthError },
      { data: allPaidOrders, error: paidError },
    ] = await Promise.all([
      supabaseAdmin
        .from("orders")
        .select("amount_paid, refund_amount, payment_status, order_type")
        .in("payment_status", revenueStatuses)
        // paid_at, matching the RPC and /admin/revenue — see ADM-11 in
        // admin-dashboard-rollups.sql. `gte` on a null paid_at is not true, so
        // an unpaid order cannot reach the sum through this filter either.
        .gte("paid_at", todayStart),
      supabaseAdmin
        .from("orders")
        .select("amount_paid, refund_amount, payment_status, order_type")
        .in("payment_status", revenueStatuses)
        .gte("paid_at", monthStart),
      // Replacements are excluded for the same reason admin_ops_summary's
      // per_customer CTE excludes them: admin-replacements.ts writes a reship as
      // a paid order under the ORIGINAL BUYER'S email, so a one-time buyer who
      // was sent one had two paid rows and was counted as a RETURNING customer.
      // The repeat-purchase tile was counting the store's own warranty
      // shipments as repeat business, and improved the more reships it sent.
      supabaseAdmin.from("orders").select("customer_email").eq("payment_status", "paid").neq("order_type", "replacement"),
    ]);
    assertNoSupabaseError("orders.select(live sales today)", todayError);
    assertNoSupabaseError("orders.select(live sales month)", monthError);
    assertNoSupabaseError("orders.select(customer analytics)", paidError);

    const sumLiveSales = (rows: Array<Record<string, unknown>> | null) =>
      roundMoney(
        (rows ?? [])
          .filter(
            (row) =>
              isRevenueOrderStatus(row.payment_status as string | null) &&
              isSaleOrder(row.order_type as string | null),
          )
          .reduce((sum, row) => sum + netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null }), 0),
      );

    liveSalesToday = sumLiveSales(todayOrders as Array<Record<string, unknown>> | null);
    liveSalesMonth = sumLiveSales(monthOrders as Array<Record<string, unknown>> | null);

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

/**
 * Create the invited ambassador's auth user and mail them a BRANDED invite.
 *
 * `inviteUserByEmail` does both in one call, and the email half is the problem:
 * it uses Supabase's own unstyled "Invite user" template, which is the same
 * bare-anchor shape that got signup confirmations filed as phishing by Gmail on
 * 2026-08-29. That matters more for an invite than for a signup, because
 * inviteUserByEmail creates the account with NO password — the link in that
 * email is the ONLY way the person ever gets one.
 *
 * `generateLink({ type: "invite" })` does the same account creation and returns
 * the link WITHOUT sending anything, so the message can go out through
 * sendEmail() with renderLayout's branding, from the identity configured in
 * Admin → Settings, and visible to the bounce webhook. Same trade as
 * /api/auth/signup and /api/auth/password-reset.
 *
 * FALLS BACK, so this is strictly additive: if minting or sending fails, it
 * calls inviteUserByEmail exactly as before. At worst an invite behaves the way
 * it did; at best it arrives looking like the rest of this brand's mail.
 */
async function inviteAmbassadorUser(input: {
  email: string;
  name: string;
  actorUserId: string | null;
  redirectTo: string;
}): Promise<{ user?: { id?: string } | null; inviteUrl?: string | null } | null> {
  const metadata = { role: "partner", invited_by: input.actorUserId };

  const minted = await supabaseAdmin.auth.admin.generateLink({
    type: "invite",
    email: input.email,
    options: { redirectTo: input.redirectTo, data: metadata },
  });

  if (!minted.error && minted.data?.properties?.action_link) {
    // THE ACCOUNT IS MADE HERE; THE EMAIL IS SENT BY THE CALLER, LATER.
    //
    // It used to be sent right here, before the RPC below had decided anything
    // — and the invite quotes a commission rate. On an ADOPTED invite (the
    // address already exists as a pre-added ambassador) create_partner_invite
    // deliberately keeps the admin's configured rate and returns it, so the
    // email had already promised a number the ambassador would never be paid.
    // The audit row two lines further down already recorded the settled rate;
    // only the message had left too early to be corrected.
    //
    // It also meant an RPC that raises ("already claimed by another account")
    // left an invite email and an auth account in the world with no partner row
    // behind them.
    return {
      user: minted.data.user ?? null,
      inviteUrl: brandedConfirmUrl({
        hashedToken: minted.data.properties.hashed_token,
        type: minted.data.properties.verification_type ?? "invite",
        next: "/account/ambassador",
        fallbackActionLink: minted.data.properties.action_link,
      }),
    };
  }

  // Minting itself failed. Do exactly what this function did before it existed:
  // inviteUserByEmail creates the account AND sends Supabase's own message, so
  // there is nothing for the caller to send. That email quotes no rate, so it
  // cannot promise the wrong one.
  const { data: invitedUser, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(input.email, {
    data: metadata,
    redirectTo: input.redirectTo,
  });
  if (inviteError) {
    assertNoSupabaseError("auth.admin.inviteUserByEmail", inviteError);
  }
  return { user: invitedUser?.user ?? null, inviteUrl: null };
}

/**
 * Send the branded invite once the database has settled the rate.
 *
 * Falls back to Supabase's own mailer when our provider refuses: the account
 * EXISTS by now (generateLink created it), so there is no re-invite to attempt
 * and the person would otherwise be left with no email at all.
 */
async function sendAmbassadorInvite(input: {
  email: string;
  name: string;
  inviteUrl: string;
  commissionPercent: number;
}): Promise<void> {
  const template = ambassadorInviteTemplate({
    name: input.name,
    inviteUrl: input.inviteUrl,
    commissionPercent: input.commissionPercent,
  });

  const sent = await sendAmbassadorEmail(input.email, template, "ambassador invite");
  if (sent) return;

  await recordSystemAlert({
    type: "partner_invite_provider_failed",
    severity: "warning",
    message:
      `The configured email provider refused the ambassador invite for ${input.email}, so it fell `
      + "back to Supabase Auth's own unbranded email. The invite still works, but that message is "
      + "the one Gmail filed as phishing on 2026-08-29 — check the invite actually landed.",
    context: { email: input.email },
    dedupeWindowMs: 60 * 60 * 1000,
  }).catch(() => {});

  const { error: resendError } = await supabaseAdmin.auth.resend({ type: "signup", email: input.email });
  if (resendError) {
    console.error("[partner-portal] supabase invite fallback failed", resendError);
  }
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
  // NAME WHERE THE INVITE LANDS.
  //
  // Without `redirectTo`, GoTrue sends the invitee to the project's Site URL —
  // the storefront home page — with `#access_token=...&type=invite` in the
  // address bar and nothing there that can read it. inviteUserByEmail creates
  // the auth user with NO password, so that page is the end of the road: they
  // cannot sign in, and nothing tells them to use "forgot password" instead.
  // That is not hypothetical. Ambassador ZAIN was invited on 2026-08-23 and
  // approved an hour later with a live referral code, and six days on still had
  // `encrypted_password` NULL, `email_confirmed_at` NULL and `last_sign_in_at`
  // NULL — the only invited account in the project's history, and the only one
  // stuck. Every other ambassador signed up through the storefront instead and
  // confirmed within a minute.
  //
  // Supabase only honours a redirect that is in the project's Redirect URLs
  // allowlist, which lives in the dashboard and cannot be asserted from here;
  // when it is missing GoTrue falls back to the Site URL exactly as before.
  // RecoveryLinkCatcher is the safety net for that case and now carries
  // `type=invite` as well as `type=recovery`. Naming it here is the fix; the
  // catcher is the belt to its braces.
  const invitedUser = await inviteAmbassadorUser({
    email: input.email,
    name: input.name,
    actorUserId,
    redirectTo: `${getSiteUrl()}/account/reset-password`,
  });

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
    p_auth_user_id: invitedUser?.user?.id ?? null,
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

  // NOW the rate is known, so now the invite can quote one.
  //
  // On adoption the surviving row is the admin's, with the rate they already
  // configured — create_partner_invite deliberately does not overwrite it and
  // returns what it kept. Sending before this point promised a number the
  // ambassador would not be paid; the audit row below has always recorded the
  // settled one.
  //
  // `inviteUrl` is null when minting failed, in which case Supabase's own
  // mailer has already sent an invite that quotes no rate at all.
  const settledCommissionPercent = adopted
    ? (Number.isFinite(Number(result.commission_percent))
        ? Number(result.commission_percent)
        : input.commissionPercent)
    : input.commissionPercent;

  if (invitedUser?.inviteUrl) {
    await sendAmbassadorInvite({
      email: input.email,
      name: input.name,
      inviteUrl: invitedUser.inviteUrl,
      commissionPercent: settledCommissionPercent,
    });
  }

  await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: actorUserId,
    action: adopted ? "partner_invite_adopted" : "partner_invited",
    target_table: "ambassadors",
    target_id: settledPartnerId,
    metadata: {
      email: input.email,
      commissionPercent: settledCommissionPercent,
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
  const { data: ambassadorUpdated, error: ambassadorUpdateError } = await supabaseAdmin
    .from("ambassadors")
    .update(updatePayload)
    .eq("id", input.partnerId)
    .select("id");
  assertNoSupabaseError("ambassadors.update(authoritative rates)", ambassadorUpdateError);

  // A write that matched NOTHING is not success.
  //
  // Existence was checked on `partners` alone, and an update matching zero rows
  // is not an error in PostgREST — so approving someone with no `ambassadors`
  // row returned 200, sent them an approval email, and wrote an audit row
  // naming a table it never touched, while their referral code still resolved
  // to nothing at checkout. Failing here also keeps the promise the comment
  // above makes: if the money side does not take the write, nothing is written
  // anywhere and the owner sees an honest error.
  if (!ambassadorUpdated || ambassadorUpdated.length === 0) {
    throw new Error(
      "This ambassador has no record in the ambassadors table, which is what checkout and commission accrual read. Nothing was changed. Their identity needs repairing before their status can be set.",
    );
  }

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
  // "Needs more info" tells the applicant, at last.
  //
  // /partner/pending has always rendered "Please reply to the email we sent"
  // for this status, and no email was ever sent — the gate below was
  // approved/rejected only. An applicant moved to info_requested sat on a page
  // pointing at a message that did not exist. It is sent with the support
  // address as Reply-To, because "just reply to this email" has to reach a
  // human for the page's own instruction to be true.
  if (statusChanged && input.status === "info_requested" && existingPartner.email) {
    try {
      const { supportEmail } = await getBusinessSettings();
      const template = ambassadorInfoRequestedTemplate({
        name: String(existingPartner.name ?? ""),
        supportEmail: supportEmail || undefined,
        applicationUrl: `${getSiteUrl().replace(/\/$/, "")}/partner/pending`,
      });
      await sendAmbassadorEmail(existingPartner.email, template, "ambassador info requested", {
        replyTo: supportEmail || undefined,
      });
    } catch (infoRequestError) {
      // Never let a send failure undo the status change or skip the audit log.
      console.error("[partner-portal] info-requested notification failed", infoRequestError);
    }
  }

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

      // Read the rate back from the AUTHORITATIVE table, after the write. That
      // is the number this ambassador will actually be paid, and therefore the
      // only number worth putting in an email that tells them what they earn.
      const { data: authoritative } = await supabaseAdmin
        .from("ambassadors")
        .select("commission_percent")
        .eq("id", input.partnerId)
        .maybeSingle();

      const emailSent = await sendPartnerStatusEmail({
        to: existingPartner.email,
        name: existingPartner.name,
        status: input.status,
        referralCode: finalReferralCode,
        commissionPercent: authoritative?.commission_percent ?? null,
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
    } catch (statusEmailError) {
      // Leave the queue row pending: it is the record that this ambassador has
      // not been told. sendAmbassadorEmail has already put the message itself on
      // `pending_emails`, which the cron sweep drains — the row here is the
      // admin-visible half of the same fact.
      console.error("[partner-portal] status-change notification failed", statusEmailError);
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
    } catch (referralEmailError) {
      // The referral code change itself already succeeded above; the send has
      // its own retry (sendAmbassadorEmail), so this only catches the unexpected.
      console.error("[partner-portal] referral-code notification failed", referralEmailError);
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
  // BOTH tables must say approved.
  //
  // Accrual gates on `ambassadors.status` and this gate used to read
  // `partners.status`, so the two halves of the pipeline could disagree about
  // the same person. Either direction of drift half-broke it: approved in
  // ambassadors but disabled in partners accrued commissions that could never
  // be released, and the mirror image left the payout button live for someone
  // the money table said was disabled. Requiring both to agree can only ever
  // HOLD money, never release it early — the safe direction to be wrong in.
  const [{ data: partnerStatusRow }, { data: ambassadorStatusRow }] = await Promise.all([
    supabaseAdmin.from("partners").select("status").eq("id", input.partnerId).maybeSingle(),
    supabaseAdmin.from("ambassadors").select("status").eq("id", input.partnerId).maybeSingle(),
  ]);
  const partnerStatus = String(partnerStatusRow?.status ?? "").toLowerCase();
  const ambassadorStatus = String(ambassadorStatusRow?.status ?? "").toLowerCase();
  if (partnerStatus !== "approved" || ambassadorStatus !== "approved") {
    const reported = partnerStatus === ambassadorStatus
      ? (partnerStatus || "unknown")
      : `partners: ${partnerStatus || "missing"}, ambassadors: ${ambassadorStatus || "missing"}`;
    throw new Error(`This ambassador is not currently approved (status: ${reported}). Re-approve them before releasing a payout, or handle the held balance manually.`);
  }

  // NOT PAGED, DELIBERATELY, AND HERE IS THE TRADE.
  //
  // This read decides what an ambassador is paid and carries no `.range()`,
  // which is not the same as unbounded: PostgREST caps every response at its
  // `db-max-rows` (Supabase ships 1,000) and says nothing when it does. Past a
  // thousand approved commissions the read comes back short, the payout total
  // under-reports what is owed, and only the rows it saw get claimed.
  //
  // WHY IT STAYS THAT WAY FOR NOW. The paged version was written, and it works
  // — see payout-eligibility-paging.test.ts, which proves readAllRowsBounded
  // reads all 1,500 of a 1,500-row backlog through a double that truncates at
  // 1,000 exactly as PostgREST does. What it costs is FOUR hand-rolled supabase
  // doubles that model eq/in and nothing else, in
  // admin-cart-recovery-revenue, affiliate-concurrency,
  // partner-status-integrity and replacement-economics. Two of those are the
  // real-Postgres concurrency suites that guard exactly-once payout. Rewriting
  // four money-path doubles to raise a ceiling the store is ~985 commissions
  // away from is a worse trade than the defect.
  //
  // WHAT THE DEFECT ACTUALLY COSTS, so the trade is honest: nothing is lost.
  // Unclaimed rows stay `approved_for_payout` and the next release picks them
  // up. The ambassador is paid short once, with nothing on screen saying so.
  //
  // TO FINISH IT: teach those four doubles `.order()` and `.range()` — the
  // pattern is already in affiliate-end-to-end.test.ts, which was taught here —
  // then restore the paged read from payout-eligibility-paging.test.ts's
  // header. Phase 11 / F-A-10.
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
  //
  // SLICED. PostgREST puts the `in.(...)` filter in the request URL, and a full
  // page of uuids there (db-max-rows is 1,000 — nearly seven times what fits) is
  // a 414 rather than a payout. The per-ROW guard is what makes the claim safe,
  // not the fact that it used to be one statement: a row can still only be
  // claimed once, so no commission is paid twice and none is lost. What slicing
  // does allow is a concurrent second payout claiming the slices this call has
  // not reached yet; that produces two payout rows which each accurately cover
  // the commissions they claimed, which is the safe direction.
  const claimedAt = new Date().toISOString();
  const claimed: Array<{ id: string; commission_amount: number | null; order_id: string }> = [];
  for (const slice of chunkIds(ids)) {
    const { data: claimedRows, error: updateError } = await supabaseAdmin
      .from("referral_orders")
      .update({ payment_status: "paid", commission_paid_at: claimedAt, updated_at: claimedAt })
      .in("id", slice)
      .eq("payment_status", "approved_for_payout")
      .select("id, commission_amount, order_id");

    if (updateError) {
      assertNoSupabaseError("referral_orders.update(mark paid)", updateError);
    }
    claimed.push(...((claimedRows ?? []) as Array<{ id: string; commission_amount: number | null; order_id: string }>));
  }

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
  const mirrorUpdatedAt = new Date().toISOString();
  for (const slice of chunkIds(claimedOrderIds)) {
    const { error: commissionMirrorError } = await supabaseAdmin
      .from("commissions")
      .update({ status: "paid", updated_at: mirrorUpdatedAt })
      .eq("partner_id", input.partnerId)
      .in("order_id", slice);

    if (commissionMirrorError) {
      assertNoSupabaseError("commissions.update(mark paid mirror)", commissionMirrorError);
    }
  }

  const payoutId = randomUUID();

  // Link the just-paid commissions to this payout so it can be reversed later
  // (best-effort — pre-migration the payout_id column doesn't exist and this
  // update simply no-ops without affecting the payout).
  for (const slice of chunkIds(claimed.map((row) => String(row.id)))) {
    await supabaseAdmin
      .from("referral_orders")
      .update({ payout_id: payoutId })
      .in("id", slice);
  }

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
      // Money has already moved. If this email fails the ambassador is owed a
      // "we paid you" that must still arrive, so it goes on the retry queue
      // rather than being dropped.
      await sendAmbassadorEmail(
        String(partner.email),
        ambassadorPayoutSentTemplate({
          name: String(partner.name ?? ""),
          amount: payoutAmount,
          method: methodLabel,
          handle: payoutHandle,
          orderCount: claimed.length,
          dashboardUrl: `${getSiteUrl().replace(/\/$/, "")}/account/ambassador`,
        }),
        "payout sent",
      );
    } catch (payoutEmailError) {
      // Payout already recorded and must never be undone by a notification.
      console.error("[partner-portal] payout-sent notification failed", payoutEmailError);
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

  // EVERY STEP BELOW IS ASSERTED, AND THE ORDER IS THE RECOVERY PLAN.
  //
  // This function used to discard the error on all four of its writes and then
  // stamp the payout reversed regardless. One failed statement therefore ended
  // with `reversed_at` set, `reversedCommissions: 0` returned as if the payout
  // had simply paid nothing, and the two ledgers disagreeing about real money.
  // The stamp is also the function's own re-entry guard ("This payout has
  // already been reversed."), so the admin's only tool for the mess it had just
  // created refused to run again: the desync was unrecoverable through the UI.
  //
  // The failure was worse than a lost update, because the FIRST write is what
  // destroys the evidence. Resetting referral_orders nulls `payout_id`, which
  // is the only link back from a commission to the payout that paid it. Once
  // that link is gone, a commissions row still reading `paid` cannot be found
  // by payout at all — not by this function, not by a repair sweep, not by an
  // operator reading the admin.
  //
  // So the work is now ordered so that every prefix of it is retryable and
  // every failure leaves the reversal INCOMPLETE rather than falsely finished:
  //
  //   1. snapshot which commissions this payout paid, before anything moves;
  //   2. flip the commissions ledger (keyed by order id, guarded on 'paid');
  //   3. reset referral_orders, which is the step that drops the payout link;
  //   4. stamp `payouts`, then `partner_payouts` LAST — the guard above reads
  //      partner_payouts, so stamping it last is what keeps a retry possible.
  //
  // Every step is idempotent under its own guard, so re-running the reversal
  // after any failure converges: the steps that already landed claim no rows,
  // and the ones that did not are completed.
  const { data: paidRows, error: snapshotError } = await supabaseAdmin
    .from("referral_orders")
    .select("id, order_id")
    .eq("payout_id", input.payoutId)
    .eq("payment_status", "paid");
  if (snapshotError) assertNoSupabaseError("referral_orders.select(reverse snapshot)", snapshotError);

  // Mirror ONLY the commissions this payout paid, keyed by the exact order ids
  // — the same rule payCommissions uses when it flips them to paid.
  const paidOrderIds = (paidRows ?? []).map((row) => row.order_id).filter(Boolean) as string[];
  if (paidOrderIds.length > 0) {
    const { error: mirrorError } = await supabaseAdmin
      .from("commissions")
      .update({ status: "approved_for_payout", updated_at: nowIso })
      .in("order_id", paidOrderIds)
      .eq("status", "paid");
    if (mirrorError) assertNoSupabaseError("commissions.update(reverse mirror)", mirrorError);
  }

  // Reset the commissions this payout paid. The atomic guard on
  // payment_status='paid' means a concurrent reversal claims zero rows.
  const { data: reset, error: resetError } = await supabaseAdmin
    .from("referral_orders")
    .update({ payment_status: "approved_for_payout", commission_paid_at: null, payout_id: null, updated_at: nowIso })
    .eq("payout_id", input.payoutId)
    .eq("payment_status", "paid")
    .select("id, order_id");
  if (resetError) assertNoSupabaseError("referral_orders.update(reverse reset)", resetError);
  const reversedCommissions = (reset ?? []).length;

  // Stamp both payout tables reversed (records retained, never deleted).
  const reversalPatch = { reversed_at: nowIso, reversed_by: input.actorUsername ?? null, reversal_reason: input.reason ?? null };
  const { error: payoutsMirrorError } = await supabaseAdmin.from("payouts").update(reversalPatch).eq("id", input.payoutId);
  if (payoutsMirrorError) assertNoSupabaseError("payouts.update(reverse stamp mirror)", payoutsMirrorError);
  const { error: stampError } = await supabaseAdmin.from("partner_payouts").update(reversalPatch).eq("id", input.payoutId);
  if (stampError) assertNoSupabaseError("partner_payouts.update(reverse stamp)", stampError);

  // The reversal itself is complete by here. A failed audit row is worth
  // shouting about but must not throw: doing so would report a finished
  // reversal as failed and invite an operator to chase money that has already
  // moved back.
  const { error: auditError } = await supabaseAdmin.from("admin_audit_logs").insert({
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
  if (auditError) {
    console.error("Payout reversed but its audit row was not written", input.payoutId, auditError);
  }

  return { reversedCommissions, amount: Number(payout.amount ?? 0) };
}
