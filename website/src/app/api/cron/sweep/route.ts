import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { grantMonthlyStoreCreditSweep, runMembershipBillingSweep } from "@/lib/membership-billing";
import { runAbandonedCartSweep } from "@/lib/cart-recovery";
import { autoApproveEligibleCommissions } from "@/lib/partner-portal";
import { repairMissingCommissionAccruals } from "@/lib/commission-accrual-repair";
import { expireStaleReservations } from "@/lib/inventory-reservation";
import { releaseAbandonedTenderHolds } from "@/lib/tender-reservation";
import { retryPendingEmails } from "@/lib/email/retry-queue";
import { reapStrandedOrderEmails } from "@/lib/email/order-email-reaper";
import { expireStaleExpressIntents, reconcileVeyraPendingPayments } from "@/lib/express-reconcile";
import { sweepMissingShipments, sweepUnsyncedOrders } from "@/lib/shippo/order-sync";
import { runCampaignSweep } from "@/lib/email/campaign-sender";
import { runAutomationSweep } from "@/lib/email/automations";
import { repairMissingShippingCosts } from "@/lib/shipping-cost-repair";
import { repairIncompleteRefunds } from "@/lib/refund-effect-repair";
import { recordSystemAlert } from "@/lib/monitoring";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Single scheduled entry point for every time-based job in the app. Protected
// by CRON_SECRET rather than a user session, since nothing human-driven calls
// this - see vercel.json for the schedule. Every job is individually
// idempotent, so running this more often than necessary is always safe, and
// running it less often just means coarser timing, not incorrect behavior.
//
// JOBS ARE KEYED, NOT POSITIONAL. This used to be a bare array whose results
// were destructured into a matching list of names, with nothing tying one to
// the other — inserting a job in the middle silently shifted every result after
// it onto the wrong name, which had already happened once to the last two
// entries. The response key, the alert label, and the function now travel
// together in one object, so adding a job cannot mislabel an existing one.
// The object key is the JSON response field; `label` is the operator-facing
// name used in alerts. Both are contracts with something outside this file —
// the response keys with anything reading the sweep output, the labels with the
// alert an operator reads at 2am — so they are stated rather than derived from
// each other.
const JOBS = {
  membershipBilling: { label: "membership_billing", run: runMembershipBillingSweep },
  cartRecovery: { label: "cart_recovery", run: runAbandonedCartSweep },
  storeCredit: { label: "store_credit", run: grantMonthlyStoreCreditSweep },
  // Advance ambassador commissions past the CONFIGURED hold automatically
  // (referral.commission_hold_days, 30 in production), instead
  // of only when someone happens to load the partner page. Idempotent.
  commissionApproval: { label: "commission_approval", run: autoApproveEligibleCommissions },
  // Re-derive commissions whose accrual failed after the paid claim was already
  // consumed. Both paid lanes give the accrual exactly one attempt and nothing
  // else retries it, so without this a single failed insert lost an
  // ambassador's commission permanently. Idempotent: it looks for ABSENCE.
  commissionAccrualRepair: { label: "commission_accrual_repair", run: repairMissingCommissionAccruals },
  // Record the postage actually paid for any label whose cost never landed.
  // Same absence-based shape as commissionAccrualRepair: idempotent, and it
  // clears the existing backlog rather than only protecting future orders.
  shippingCostRepair: { label: "shipping_cost_repair", run: repairMissingShippingCosts },
  // Finish the refund side-effects that the webhook's swallow-and-continue
  // error handling left half-applied: revenue reversal, points, store credit.
  refundEffectRepair: { label: "refund_effect_repair", run: repairIncompleteRefunds },
  // Reclaim inventory held by abandoned checkouts past their expiry window.
  reservationsExpired: { label: "reservation_expiry", run: expireStaleReservations },
  // Release send-once slots stranded at 'sending' by a send that never
  // finished (E-03). A stranded claim holds the partial unique index for ever
  // and blocks that order's confirmation permanently. Jobs here run
  // concurrently, so the release and the retry below may land in either order;
  // whichever way, the next sweep pass delivers what this one unblocked.
  orderEmailReaper: { label: "order_email_reaper", run: reapStrandedOrderEmails },
  // The same reclaim for money-like balances: store credit and points held by a
  // checkout that was cancelled, declined, or simply walked away from. Without
  // it a shopper's own credit stays locked to an order that will never settle.
  // Idempotent, and it never touches an order that has been paid.
  tenderHoldsReleased: { label: "tender_hold_release", run: releaseAbandonedTenderHolds },
  // Retry transactional emails (receipts/shipping) that failed to send.
  emailRetry: { label: "email_retry", run: retryPendingEmails },
  // Settle charges whose confirmation webhook was lost. This is the only thing
  // standing between a charged card and an order that reads unpaid forever, so
  // a failure here is genuinely critical.
  paymentReconcile: { label: "payment_reconcile", run: reconcileVeyraPendingPayments },
  // Push paid orders into Shippo. Deliberately NOT done in the payment webhook:
  // a Shippo call can take 15s and delayed the webhook response past the
  // provider's timeout, leaving shoppers on "Processing…" for a paid order.
  shippoSync: { label: "shippo_sync", run: sweepUnsyncedOrders },
  // Hygiene: retire wallet sessions that were armed and never used.
  expressIntentsExpired: { label: "express_intent_expiry", run: expireStaleExpressIntents },
  // Repair orders that reached Shippo without their parcel. Nothing else
  // retries these -- every other path keys off shippo_order_id being NULL.
  shipmentRepair: { label: "shipment_repair", run: sweepMissingShipments },
  // Marketing: advance any in-flight campaign by one batch, and start any
  // campaign whose scheduled time has arrived. Self-limiting to a time budget
  // so it cannot consume the whole 60s window.
  emailCampaigns: { label: "email_campaigns", run: runCampaignSweep },
  // Marketing: retention sequences (welcome, post-purchase, win-back).
  emailAutomations: { label: "email_automations", run: runAutomationSweep },
} as const;

type JobName = keyof typeof JOBS;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret ?? ""}`;
  // Constant-time compare (consistent with admin-auth) so the secret can't be
  // recovered by response-timing analysis.
  const authorized = Boolean(secret)
    && authHeader.length === expected.length
    && timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  if (!authorized) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const names = Object.keys(JOBS) as JobName[];
  const settled = await Promise.allSettled(names.map((name) => JOBS[name].run()));

  // zip by index against the SAME array the calls were built from, so the
  // pairing is derived rather than hand-maintained.
  const results = names.map((name, index) => [name, settled[index]] as const);

  // Surface any failed job as a durable, operator-visible alert (critical =
  // emails the operator). Without this a rejected sweep only appeared in the
  // HTTP response body that nobody reads, so renewals/recovery could silently
  // stall. Best-effort and never throws.
  const failed = results.filter(([, result]) => result.status === "rejected");
  if (failed.length > 0) {
    await recordSystemAlert({
      type: "cron_sweep_failed",
      severity: "critical",
      message: `Scheduled sweep had ${failed.length} failing job(s): ${failed.map(([name]) => JOBS[name].label).join(", ")}. Renewals, cart recovery, reservation expiry, or email retries may be stalled.`,
      context: Object.fromEntries(
        failed.map(([name, result]) => [JOBS[name].label, String((result as PromiseRejectedResult).reason)]),
      ),
    });
  }

  return NextResponse.json({
    success: true,
    ...Object.fromEntries(
      results.map(([name, result]) => [
        name,
        result.status === "fulfilled" ? result.value : { error: String(result.reason) },
      ]),
    ),
  });
}
