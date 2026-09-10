import { grantMonthlyStoreCreditSweep, runMembershipBillingSweep } from "@/lib/membership-billing";
import { autoApproveEligibleCommissions } from "@/lib/partner-portal";
import { repairMissingCommissionAccruals } from "@/lib/commission-accrual-repair";
import { repairMissingInventoryCommits } from "@/lib/inventory-commit-repair";
import { expireStaleReservations } from "@/lib/inventory-reservation";
import { releaseAbandonedTenderHolds } from "@/lib/tender-reservation";
import { alertOnPartnersLockedOut, alertOnStalledSignups } from "@/lib/auth-health";
import { expireStaleExpressIntents, reconcileVeyraPendingPayments } from "@/lib/express-reconcile";
import { sweepMissingShipments, sweepUnsyncedOrders } from "@/lib/shippo/order-sync";
import { repairMissingShippingCosts } from "@/lib/shipping-cost-repair";
import { repairIncompleteRefunds } from "@/lib/refund-effect-repair";
import { runOrderPushHealthCheck } from "@/lib/order-push-notification";
import { runBirthdayBonusSweep } from "@/lib/membership";
import { runCouponHygiene } from "@/lib/coupon-hygiene";
import { resealPlaintextControlSecrets } from "@/lib/admin-control";
import { repairUnredeemedPaidOffers } from "@/lib/offers/customer-offer-repair";
import { ingestAdSpend } from "@/lib/ads/spend-ingest";
import { handleCronRequest, type CronJobMap } from "@/lib/cron-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The scheduled entry point for the app's time-based jobs, EXCEPT the ones
// that put a message in front of a customer — those moved to
// /api/cron/lifecycle so a closing recovery window is never lost to a sweep
// that ran out of budget. See that route's header for why lifecycle mail is
// the case that could not tolerate sharing. Protected by CRON_SECRET rather
// than a user session, since nothing human-driven calls this; see vercel.json
// for the schedule.
//
// Every job is individually idempotent, so running this more often than
// necessary is always safe, and running it less often just means coarser
// timing, not incorrect behavior.
//
// JOBS ARE KEYED, NOT POSITIONAL. This used to be a bare array whose results
// were destructured into a matching list of names, with nothing tying one to
// the other — inserting a job in the middle silently shifted every result
// after it onto the wrong name, which had already happened once to the last
// two entries. The response key, the alert label, and the function travel
// together in one object, so adding a job cannot mislabel an existing one. The
// object key is the JSON response field; `label` is the operator-facing name
// used in alerts. Both are contracts with something outside this file — the
// response keys with anything reading the sweep output, the labels with the
// alert an operator reads at 2am — so they are stated rather than derived from
// each other.
//
// The watchdog, the once-only retry after a transient PostgREST auth
// rejection, and the alerting all live in cron-runner.ts, shared with the
// lifecycle route so the two cannot drift apart.
const JOBS: CronJobMap = {
  membershipBilling: { label: "membership_billing", run: runMembershipBillingSweep },
  storeCredit: { label: "store_credit", run: grantMonthlyStoreCreditSweep },
  // Advance ambassador commissions past the CONFIGURED hold automatically
  // (ambassador.commission_hold_days, 30 in production), instead
  // of only when someone happens to load the partner page. Idempotent.
  commissionApproval: { label: "commission_approval", run: autoApproveEligibleCommissions },
  // Re-derive commissions whose accrual failed after the paid claim was already
  // consumed. Both paid lanes give the accrual exactly one attempt and nothing
  // else retries it, so without this a single failed insert lost an
  // ambassador's commission permanently. Idempotent: it looks for ABSENCE.
  commissionAccrualRepair: { label: "commission_accrual_repair", run: repairMissingCommissionAccruals },
  // Re-run the inventory commit for paid orders that never got one. The paid
  // side-effects claim is taken BEFORE the effects run (so a redelivery cannot
  // pay an ambassador twice) and nothing marks it complete, so an invocation
  // killed mid-run leaves the order paid with its stock never decremented and
  // the processor's retry finding the claim spent. Three of the four effects
  // behind that claim already had a repair here; inventory did not, and it is
  // the one that oversells in one direction and under-restocks in the other.
  // Absence-keyed and idempotent, like the accrual repair above.
  // Re-run the inventory commit for paid orders that never got one. The paid
  // side-effects claim is taken BEFORE the effects run (so a redelivery cannot
  // pay an ambassador twice) and nothing marks it complete, so an invocation
  // killed mid-run leaves the order paid with its stock never decremented and
  // the processor's retry finding the claim spent. Three of the four effects
  // behind that claim already had a repair here; inventory did not, and it is
  // the one that oversells in one direction and under-restocks in the other.
  // Absence-keyed and idempotent, like the accrual repair above.
  inventoryCommitRepair: { label: "inventory_commit_repair", run: repairMissingInventoryCommits },
  // Record the postage actually paid for any label whose cost never landed.
  // Same absence-based shape as commissionAccrualRepair: idempotent, and it
  // clears the existing backlog rather than only protecting future orders.
  shippingCostRepair: { label: "shipping_cost_repair", run: repairMissingShippingCosts },
  // Finish the refund side-effects that the webhook's swallow-and-continue
  // error handling left half-applied: revenue reversal, points, store credit.
  refundEffectRepair: { label: "refund_effect_repair", run: repairIncompleteRefunds },
  // Reclaim inventory held by abandoned checkouts past their expiry window.
  reservationsExpired: { label: "reservation_expiry", run: expireStaleReservations },
  // The same reclaim for money-like balances: store credit and points held by a
  // checkout that was cancelled, declined, or simply walked away from. Without
  // it a shopper's own credit stays locked to an order that will never settle.
  // Idempotent, and it never touches an order that has been paid.
  tenderHoldsReleased: { label: "tender_hold_release", run: releaseAbandonedTenderHolds },
  // Grant and announce birthday bonuses. The settings page promises "we'll send
  // a bonus on your next one", and the only thing that could grant one was a
  // dashboard page render on the exact UTC day — so in the ordinary case the
  // customer got neither the points nor an email. Idempotent per year.
  birthdayBonus: { label: "birthday_bonus", run: runBirthdayBonusSweep },
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
  // Watch for signups stuck unconfirmed. The confirmation email is sent by
  // Supabase Auth rather than this app, so it appears in NONE of the email
  // machinery -- no retry row, no bounce event, no send log. An unconfirmed
  // auth.users row is the only evidence a delivery problem leaves, and this is
  // the only thing that looks at it.
  signupConfirmations: { label: "signup_confirmation_watch", run: alertOnStalledSignups },
  couponHygiene: { label: "coupon_hygiene", run: runCouponHygiene },
  controlSecretReseal: { label: "control_secret_reseal", run: resealPlaintextControlSecrets },
  // A paid order that held a customer offer but whose redeem call died: mark
  // it redeemed so the token can never be spent twice and reporting is true.
  customerOfferRepair: { label: "customer_offer_repair", run: repairUnredeemedPaidOffers },
  // Watch for APPROVED ambassadors who have never signed in. The job above is
  // time-boxed on purpose -- past its lookback an unconfirmed signup is someone
  // who changed their mind -- and that is exactly wrong for an ambassador whose
  // referral code is already live and earning. This one does not expire, so a
  // partner who cannot reach their portal stays reported until they get in.
  partnerAccess: { label: "partner_access_watch", run: alertOnPartnersLockedOut },
  // Watch the phone-notification path itself. A $94.96 order was paid and
  // announced to nothing: the destination had stopped accepting deliveries and
  // the only evidence was the absence of a notification, which looks exactly
  // like a quiet day. Pushover's validate endpoint confirms the credentials and
  // SENDS NOTHING, so this can run every tick without becoming the thing that
  // gets muted. Alerts at most once a day, and never throws.
  orderPushHealth: { label: "order_push_health", run: runOrderPushHealthCheck },
  // Pull ad spend from Meta, TikTok, Reddit and Snapchat into ad_spend_daily,
  // which is the only thing that lets revenue be compared against cost. Two
  // reasons it is safe on a 30-minute sweep: it re-fetches a trailing window and
  // UPSERTS on the platform's own (platform, ad_id, date) key, so a re-run
  // cannot double a day's spend; and it self-limits to one real fetch every six
  // hours, because the platforms restate a few times a day and 192 requests
  // daily would buy nothing.
  adSpendIngest: { label: "ad_spend_ingest", run: ingestAdSpend },
};

/**
 * When the watchdog gives up waiting, INSIDE the function budget.
 *
 * Ten seconds short of maxDuration: enough to write a system_alerts row and
 * send the operator email before the platform pulls the plug, which is the
 * whole point of not simply awaiting the jobs.
 */
const SWEEP_DEADLINE_MS = 50_000;

export async function GET(request: Request) {
  return handleCronRequest(request, {
    jobs: JOBS,
    group: "sweep",
    maxDurationSeconds: maxDuration,
    deadlineMs: SWEEP_DEADLINE_MS,
  });
}
