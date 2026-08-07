import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { grantMonthlyStoreCreditSweep, runMembershipBillingSweep } from "@/lib/membership-billing";
import { runAbandonedCartSweep } from "@/lib/cart-recovery";
import { autoApproveEligibleCommissions } from "@/lib/partner-portal";
import { expireStaleReservations } from "@/lib/inventory-reservation";
import { retryPendingEmails } from "@/lib/email/retry-queue";
import { expireStaleExpressIntents, reconcileVeyraPendingPayments } from "@/lib/express-reconcile";
import { sweepUnsyncedOrders } from "@/lib/shippo/order-sync";
import { recordSystemAlert } from "@/lib/monitoring";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Single scheduled entry point for every time-based job in the app
// (membership billing dates + the abandoned-cart-recovery email sequence).
// Protected by CRON_SECRET rather than a user session, since nothing
// human-driven calls this - see vercel.json for the schedule. Both sweeps
// are individually idempotent (see their own doc comments), so calling
// this more often than strictly necessary is always safe, and calling it
// less often than the "ideal" cadence just means coarser timing, not
// incorrect behavior.
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

  const [membershipResult, cartRecoveryResult, storeCreditResult, commissionApprovalResult, reservationExpiryResult, emailRetryResult, paymentReconcileResult, expressIntentResult, shippoSyncResult] = await Promise.allSettled([
    runMembershipBillingSweep(),
    runAbandonedCartSweep(),
    grantMonthlyStoreCreditSweep(),
    // Advance ambassador commissions past the 14-day hold automatically, instead
    // of only when someone happens to load the partner page. Idempotent.
    autoApproveEligibleCommissions(),
    // Reclaim inventory held by abandoned checkouts past their expiry window.
    expireStaleReservations(),
    // Retry transactional emails (receipts/shipping) that failed to send.
    retryPendingEmails(),
    // Settle charges whose confirmation webhook was lost. This is the only
    // thing standing between a charged card and an order that reads unpaid
    // forever, so a failure here is genuinely critical.
    reconcileVeyraPendingPayments(),
    // Push paid orders into Shippo. Deliberately NOT done in the payment
    // webhook: a Shippo call can take 15s and delayed the webhook response past
    // the provider's timeout, leaving shoppers on "Processing…" for an order
    // that was already paid.
    sweepUnsyncedOrders(),
    // Hygiene: retire wallet sessions that were armed and never used.
    expireStaleExpressIntents(),
  ]);

  // Surface any failed job as a durable, operator-visible alert (critical =
  // emails the operator). Without this a rejected sweep only appeared in the
  // HTTP response body that nobody reads, so renewals/recovery could silently
  // stall. Best-effort and never throws.
  const jobs: Array<[string, PromiseSettledResult<unknown>]> = [
    ["membership_billing", membershipResult],
    ["cart_recovery", cartRecoveryResult],
    ["store_credit", storeCreditResult],
    ["commission_approval", commissionApprovalResult],
    ["reservation_expiry", reservationExpiryResult],
    ["email_retry", emailRetryResult],
    ["payment_reconcile", paymentReconcileResult],
    ["express_intent_expiry", expressIntentResult],
  ];
  const failed = jobs.filter(([, r]) => r.status === "rejected");
  if (failed.length > 0) {
    await recordSystemAlert({
      type: "cron_sweep_failed",
      severity: "critical",
      message: `Scheduled sweep had ${failed.length} failing job(s): ${failed.map(([name]) => name).join(", ")}. Renewals, cart recovery, reservation expiry, or email retries may be stalled.`,
      context: Object.fromEntries(failed.map(([name, r]) => [name, String((r as PromiseRejectedResult).reason)])),
    });
  }

  return NextResponse.json({
    success: true,
    membershipBilling: membershipResult.status === "fulfilled" ? membershipResult.value : { error: String(membershipResult.reason) },
    cartRecovery: cartRecoveryResult.status === "fulfilled" ? cartRecoveryResult.value : { error: String(cartRecoveryResult.reason) },
    storeCredit: storeCreditResult.status === "fulfilled" ? storeCreditResult.value : { error: String(storeCreditResult.reason) },
    commissionApproval: commissionApprovalResult.status === "fulfilled" ? commissionApprovalResult.value : { error: String(commissionApprovalResult.reason) },
    reservationsExpired: reservationExpiryResult.status === "fulfilled" ? reservationExpiryResult.value : { error: String(reservationExpiryResult.reason) },
    emailRetry: emailRetryResult.status === "fulfilled" ? emailRetryResult.value : { error: String(emailRetryResult.reason) },
    paymentReconcile: paymentReconcileResult.status === "fulfilled" ? paymentReconcileResult.value : { error: String(paymentReconcileResult.reason) },
    expressIntentsExpired: expressIntentResult.status === "fulfilled" ? expressIntentResult.value : { error: String(expressIntentResult.reason) },
    shippoSync: shippoSyncResult.status === "fulfilled" ? shippoSyncResult.value : { error: String(shippoSyncResult.reason) },
  });
}
