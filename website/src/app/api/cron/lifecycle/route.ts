import { runAbandonedCartSweep } from "@/lib/cart-recovery";
import { runCampaignSweep } from "@/lib/email/campaign-sender";
import { runAutomationSweep } from "@/lib/email/automations";
import { drainMarketingSendQueue } from "@/lib/email/marketing-queue";
import { retryPendingEmails } from "@/lib/email/retry-queue";
import { reapStrandedOrderEmails } from "@/lib/email/order-email-reaper";
import { reapStrandedMarketingSends } from "@/lib/email/marketing-send-reaper";
import { MARKETING_OWNED_BY_OMNISEND, marketingSendBlockedByOmnisend } from "@/lib/marketing/omnisend/ownership";
import { handleCronRequest, type CronJobMap } from "@/lib/cron-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * LIFECYCLE EMAIL HAS ITS OWN BUDGET NOW.
 *
 * WHY THIS ROUTE EXISTS. Every time-based job in the app used to run in one
 * 30-minute function with a 60-second ceiling — 28 of them sharing it. On
 * 2026-09-08 production recorded a `cron_sweep_timeout`, with four
 * `cron_sweep_failed` criticals beside it, and the timeout alert de-duplicates
 * for hours, so consecutive missed ticks hide behind a single notification.
 *
 * That is more expensive for recovery mail than for anything else in the
 * sweep, and for a reason specific to it: a stage is due inside a WINDOW
 * (STAGE_WINDOWS in cart-recovery.ts), and a window that closes during an
 * outage is not sent late — it is skipped for ever. Payment reconciliation
 * catches up when it next runs. A t72h that was due while the function was
 * being killed at sixty seconds never goes at all, and the shopper is simply
 * never reminded.
 *
 * So these seven jobs run here, on their own schedule, and the sweep keeps
 * the rest. Nothing is duplicated: each job appears in exactly one of the two
 * routes, and both share one runner (cron-runner.ts) so the watchdog, the
 * once-only auth retry and the alerting cannot drift apart.
 *
 * WHY THESE SEVEN. They are the jobs that put a message in front of a customer,
 * and nothing else. Payments, fulfilment, inventory, commissions and every
 * other job stay in the sweep — this route is deliberately not a second place
 * for "whatever needs running".
 *
 * WHY THREE OF THEM ASK OMNISEND FIRST. Recovery, the automations and the
 * campaign sender are the marketing sends Omnisend's flows replace, and the
 * 24-hour frequency guard cannot see an Omnisend send — so while
 * OMNISEND_MARKETING_OWNER is set they stand down rather than race it
 * (spec §3.1, ownership.ts). They stand down INSIDE the job, not by leaving
 * the map: the tick still reports each under its own key with the logged
 * reason, so a skipped job reads as "skipped, and here is why" and not as a
 * job that quietly stopped being scheduled. The other four are transactional
 * mail, retries and reapers, which Omnisend does not replace, so they never
 * ask.
 */
const JOBS: CronJobMap = {
  // The recovery ladder. First because it is the one with a closing window.
  cartRecovery: {
    label: "cart_recovery",
    run: () => (marketingSendBlockedByOmnisend() ? Promise.resolve({ skipped: MARKETING_OWNED_BY_OMNISEND }) : runAbandonedCartSweep()),
  },
  // Retention sequences: welcome, post-purchase, win-back, reorder.
  emailAutomations: {
    label: "email_automations",
    run: () => (marketingSendBlockedByOmnisend() ? Promise.resolve({ skipped: MARKETING_OWNED_BY_OMNISEND }) : runAutomationSweep()),
  },
  // Advance any in-flight broadcast by one batch, and start any that is due.
  emailCampaigns: {
    label: "email_campaigns",
    run: () => (marketingSendBlockedByOmnisend() ? Promise.resolve({ skipped: MARKETING_OWNED_BY_OMNISEND }) : runCampaignSweep()),
  },
  // Event mail the frequency guard held back, once the quiet window passes.
  marketingQueue: { label: "marketing_queue", run: drainMarketingSendQueue },
  // Transactional retries (receipts, shipping) — customer-facing mail, and it
  // belongs with the other mail rather than behind twenty-seven other jobs.
  emailRetry: { label: "email_retry", run: retryPendingEmails },
  // Release send-once slots stranded at 'sending' by a send that never
  // finished. A stranded claim holds the unique index for ever and blocks that
  // order's confirmation permanently, so it travels with the retry above.
  orderEmailReaper: { label: "order_email_reaper", run: reapStrandedOrderEmails },
  // The same hole in the other log. A marketing claim stranded at 'sending'
  // holds email_send_log_automation_once for ever, so that recipient's win-back
  // is blocked permanently — and invisibly, because the ledger hides 'sending'.
  marketingSendReaper: { label: "marketing_send_reaper", run: reapStrandedMarketingSends },
};

/** Ten seconds short of maxDuration: enough to still report an overrun. */
const DEADLINE_MS = 50_000;

/**
 * CART RECOVERY RUNS ALONE, FIRST, AND THE REST FOLLOW.
 *
 * The comment above says the recovery ladder is "first because it is the one
 * with a closing window". Until now that was only true of the order of the keys
 * in this object: runCronGroup started every job in the same tick, so they
 * all raced. The one resource they genuinely contend for is the 24-hour quiet
 * period held per recipient by marketing_send_claim, and the loser of that race
 * is deferred.
 *
 * Deferral costs the automations nothing — a welcome email goes tomorrow. It
 * costs recovery the send entirely, because a stage is due inside a window that
 * closes when the next one opens. Measured on 2026-09-12: four real carts
 * reached t72h, were deferred every tick for the whole 24-hour window, and none
 * of the four ever received the message.
 *
 * So the priority is now enforced rather than described.
 */
const RUN_FIRST = ["cartRecovery"] as const;

export async function GET(request: Request) {
  return handleCronRequest(request, {
    jobs: JOBS,
    group: "lifecycle",
    maxDurationSeconds: maxDuration,
    deadlineMs: DEADLINE_MS,
    runFirst: RUN_FIRST,
  });
}
