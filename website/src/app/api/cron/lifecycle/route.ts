import { runAbandonedCartSweep } from "@/lib/cart-recovery";
import { runCampaignSweep } from "@/lib/email/campaign-sender";
import { runAutomationSweep } from "@/lib/email/automations";
import { drainMarketingSendQueue } from "@/lib/email/marketing-queue";
import { retryPendingEmails } from "@/lib/email/retry-queue";
import { reapStrandedOrderEmails } from "@/lib/email/order-email-reaper";
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
 * So these six jobs run here, on their own schedule, and the sweep keeps the
 * rest. Nothing is duplicated: each job appears in exactly one of the two
 * routes, and both share one runner (cron-runner.ts) so the watchdog, the
 * once-only auth retry and the alerting cannot drift apart.
 *
 * WHY THESE SIX. They are the jobs that put a message in front of a customer,
 * and nothing else. Payments, fulfilment, inventory, commissions and every
 * other job stay in the sweep — this route is deliberately not a second place
 * for "whatever needs running".
 */
const JOBS: CronJobMap = {
  // The recovery ladder. First because it is the one with a closing window.
  cartRecovery: { label: "cart_recovery", run: runAbandonedCartSweep },
  // Retention sequences: welcome, post-purchase, win-back, reorder.
  emailAutomations: { label: "email_automations", run: runAutomationSweep },
  // Advance any in-flight broadcast by one batch, and start any that is due.
  emailCampaigns: { label: "email_campaigns", run: runCampaignSweep },
  // Event mail the frequency guard held back, once the quiet window passes.
  marketingQueue: { label: "marketing_queue", run: drainMarketingSendQueue },
  // Transactional retries (receipts, shipping) — customer-facing mail, and it
  // belongs with the other mail rather than behind twenty-seven other jobs.
  emailRetry: { label: "email_retry", run: retryPendingEmails },
  // Release send-once slots stranded at 'sending' by a send that never
  // finished. A stranded claim holds the unique index for ever and blocks that
  // order's confirmation permanently, so it travels with the retry above.
  orderEmailReaper: { label: "order_email_reaper", run: reapStrandedOrderEmails },
};

/** Ten seconds short of maxDuration: enough to still report an overrun. */
const DEADLINE_MS = 50_000;

export async function GET(request: Request) {
  return handleCronRequest(request, {
    jobs: JOBS,
    group: "lifecycle",
    maxDurationSeconds: maxDuration,
    deadlineMs: DEADLINE_MS,
  });
}
