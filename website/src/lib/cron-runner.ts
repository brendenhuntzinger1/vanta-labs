import "server-only";
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { recordSystemAlert } from "@/lib/monitoring";
import { describeError } from "@/lib/operator-error";
import { isTransientAuthRejection } from "@/lib/inventory-reservation";

/**
 * THE SHARED SCHEDULED-JOB RUNNER.
 *
 * WHY IT WAS EXTRACTED. Every time-based job in the app ran in ONE 30-minute
 * function with a 60-second ceiling — 28 of them, sharing that budget. On
 * 2026-09-08 production recorded a `cron_sweep_timeout`, and the alert
 * de-duplicates for six hours, so up to twelve consecutive ticks can hide
 * behind a single notification. Four `cron_sweep_failed` criticals sit beside
 * it.
 *
 * That is expensive for cart recovery specifically, and not for the reason it
 * first appears. A stage is due inside a WINDOW (STAGE_WINDOWS), and a window
 * that closes during an outage is not sent late — it is skipped for ever. So a
 * sweep that overran spent its budget on twenty-seven other jobs and silently
 * cost a shopper their reminder, permanently, with one deduplicated alert to
 * show for it.
 *
 * The fix is a budget of its own, not louder alerting: lifecycle email runs on
 * its own schedule, and payment reconciliation, fulfilment and the rest keep
 * theirs. This module is what lets two entry points share one watchdog rather
 * than growing two copies of it that drift.
 *
 * WHAT IS DELIBERATELY UNCHANGED. The semantics are the ones the original
 * sweep established and are load-bearing: jobs are KEYED rather than
 * positional so inserting one cannot mislabel another's result; each is
 * individually idempotent, so a re-run is always safe and a job that misses a
 * tick is simply picked up by the next; a transient PostgREST auth rejection,
 * or a request the Supabase edge timed out, is retried exactly once; and the
 * watchdog fires INSIDE the function budget so a run that overruns can still
 * report that it did.
 */

/** One scheduled job: the response key travels with its operator-facing name. */
export interface CronJob {
  /** The operator-facing name used in alerts. */
  label: string;
  run: () => Promise<unknown>;
}

export type CronJobMap = Record<string, CronJob>;

/** One retry after a momentary auth refusal, before the job counts as failed. */
const JOB_AUTH_RETRY_DELAY_MS = 250;

/**
 * One retry after the Supabase edge gives up on a request, before the job
 * counts as failed.
 *
 * WHAT WAS SEEN. On 2026-09-10 the edge returned twenty-seven 504s in ten
 * hours. Every one had an origin time of 5.0–5.4s — the edge's upstream limit
 * — every one fell inside the first ten seconds of a cron tick, and the tables
 * behind them hold a few dozen rows (customer_preferences, abandoned_carts,
 * admin_control_current). Nothing was slow; something was queued. PostgREST on
 * this project runs a ten-connection pool, and a tick fans out thirty-odd
 * reads at once across two functions, so whichever request waits past five
 * seconds comes back as a bare "Gateway Timeout" and the job that issued it
 * fails outright. That raised `cron_lifecycle_failed` twice in one afternoon,
 * naming a job that had done nothing wrong.
 *
 * WHY A LONGER WAIT THAN THE AUTH RETRY. A clock-skew refusal is over the
 * moment it happened; a saturated pool is not. The edge logs put the same
 * tick's p90 origin time back under a second by ten seconds in, so three
 * seconds lands the retry after the burst rather than inside it, and still
 * leaves most of the fifty-second budget for the job itself.
 *
 * Still one retry, not a loop, for the reason given at the auth retry: a
 * second failure in a row is a real outage, and it is reported as one. The
 * retry does not fix the capacity; it stops one queued read from being
 * reported as a broken job.
 */
export const JOB_GATEWAY_RETRY_DELAY_MS = 3_000;

/**
 * The edge's own phrasing for giving up. postgrest-js hands back the status
 * text and nothing else when the body is not JSON, and Kong's body when it
 * does send one names the upstream. A job's genuine bug says neither.
 */
const GATEWAY_FAILURE_TEXT = /\b(gateway time-?out|bad gateway|service (temporarily )?unavailable|upstream server is timing out)\b/i;

/**
 * Did the Supabase edge, rather than the job, produce this failure?
 *
 * Three shapes, one cause. postgrest-js reports `{ message: "Gateway Timeout" }`
 * — the statusText, because the 504 carried no JSON — and readAllRowsBounded
 * wraps that text under its own label, so the message is the only evidence in
 * both. auth-js wraps every 5xx (and a dropped connection) in
 * AuthRetryableFetchError, with the status on the error and the request URL
 * as its message, so there the name and status are the evidence instead.
 */
export function isTransientGatewayFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; status?: unknown; message?: unknown };
  if (candidate.name === "AuthRetryableFetchError") return true;
  if (candidate.status === 502 || candidate.status === 503 || candidate.status === 504) return true;
  const message = candidate.message == null ? "" : String(candidate.message);
  return GATEWAY_FAILURE_TEXT.test(message);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A standing problem is not forty-eight criticals a day — but six hours is too
 * long when a missed tick can cost a recovery window permanently. Two hours
 * bounds a silent outage to four ticks instead of twelve, and still collapses
 * a persistent failure to twelve notifications a day rather than forty-eight.
 */
export const CRON_ALERT_DEDUPE_MS = 2 * 60 * 60 * 1000;

/**
 * Is this request the scheduler?
 *
 * Constant-time compare, consistent with admin-auth, so the secret cannot be
 * recovered by response-timing analysis.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret ?? ""}`;
  return Boolean(secret)
    && authHeader.length === expected.length
    && timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

async function runJobWithTransientRetry(jobs: CronJobMap, name: string): Promise<unknown> {
  try {
    return await jobs[name].run();
  } catch (error) {
    // PGRST303 "JWT issued at future" is clock skew between the lambda and
    // PostgREST, and it is real here: production raised several, each killing a
    // DIFFERENT job. A different job each time is the signature of an
    // infrastructure blip hitting whatever happened to be running, not a bug in
    // any one job. One retry, not a loop — hammering an edge that is already
    // refusing makes an outage worse rather than shorter.
    if (isTransientAuthRejection(error)) {
      await wait(JOB_AUTH_RETRY_DELAY_MS);
      return await jobs[name].run();
    }
    // The edge timed the request out (see JOB_GATEWAY_RETRY_DELAY_MS). Same
    // signature — a different job each time, on trivial reads — and the same
    // single retry. Logged, because a retry that works alerts nothing, and a
    // tick that needed one is still worth being able to find afterwards.
    if (isTransientGatewayFailure(error)) {
      console.warn(`[cron] ${jobs[name].label}: retrying once after the edge gave up on a request —`, describeError(error));
      await wait(JOB_GATEWAY_RETRY_DELAY_MS);
      return await jobs[name].run();
    }
    throw error;
  }
}

export interface CronGroupOptions {
  jobs: CronJobMap;
  /** Distinguishes this group's alerts from the other's. */
  group: string;
  /** The platform's ceiling for this route, in seconds. */
  maxDurationSeconds: number;
  /** When the watchdog gives up, INSIDE the budget so it can still report. */
  deadlineMs: number;
  /**
   * JOBS THAT MUST FINISH BEFORE THE REST BEGIN.
   *
   * WHY THIS EXISTS. Every job in a group used to start in the same tick of the
   * event loop, so the documented priority order was not a priority order at
   * all — it was a list. That is harmless for jobs that touch different rows,
   * and it is not harmless here, because two of these jobs compete for the SAME
   * scarce resource: the 24-hour quiet period held per recipient by
   * marketing_send_claim. Whichever job reaches an address first takes it and
   * the other is deferred.
   *
   * Deferral is not symmetrical. A welcome email deferred today goes tomorrow
   * and nothing is lost. A cart-recovery stage is due inside a WINDOW that
   * closes when the next stage opens (STAGE_WINDOWS), so a stage deferred past
   * its window is not sent late — it is never sent, and the shopper is simply
   * never reminded. Running the windowed job first costs the unwindowed ones a
   * few seconds and costs the windowed one nothing.
   *
   * Names not present in `jobs` are ignored rather than throwing: a route that
   * renames a job should not take its whole schedule down.
   */
  runFirst?: readonly string[];
}

/**
 * Run one group of jobs and return the response body.
 *
 * Settles each job into its own slot rather than awaiting Promise.allSettled,
 * because the interesting case is the one where the await never returns — this
 * keeps whatever HAS finished readable at the moment the deadline fires.
 */
export async function runCronGroup(options: CronGroupOptions): Promise<Record<string, unknown>> {
  const { jobs, group, maxDurationSeconds, deadlineMs } = options;
  const names = Object.keys(jobs);

  const settled: Array<PromiseSettledResult<unknown> | null> = names.map(() => null);
  const unfinished = new Set<string>(names);
  // Started, not merely pending. A job held behind an earlier phase has not
  // stalled — it has not begun — and the timeout alert below says which.
  const started = new Set<string>();

  const launch = (name: string) => {
    const index = names.indexOf(name);
    started.add(name);
    return Promise.resolve()
      .then(() => runJobWithTransientRetry(jobs, name))
      .then(
        (value) => { settled[index] = { status: "fulfilled", value }; },
        (reason: unknown) => { settled[index] = { status: "rejected", reason }; },
      )
      .finally(() => { unfinished.delete(name); });
  };

  const first = (options.runFirst ?? []).filter((name) => name in jobs);
  const rest = names.filter((name) => !first.includes(name));

  // Each launched job settles into its own slot and never rejects, so awaiting
  // a phase cannot be short-circuited by one job failing — the second phase
  // runs whether or not the first succeeded, exactly as before.
  const running = (async () => {
    if (first.length > 0) await Promise.all(first.map(launch));
    await Promise.all(rest.map(launch));
  })();

  // THE WATCHDOG. Every alert here is written AFTER the jobs finish, so the one
  // failure mode that could never report itself was running out of time: the
  // platform kills the function, nothing is written, and a sweep that times out
  // every tick looks exactly like a sweep that is not scheduled at all. Racing
  // a deadline INSIDE the budget is what makes it reportable. The jobs are not
  // cancelled — there is no cancellation to hand them, and each is idempotent,
  // so the next tick simply picks them up again.
  const raced = await Promise.race([
    running.then(() => "finished" as const),
    new Promise<"timed_out">((resolve) => {
      const timer = setTimeout(() => resolve("timed_out"), deadlineMs);
      timer.unref?.();
    }),
  ]);

  if (raced === "timed_out") {
    // A job that never started is a different fault from one that hung, and
    // conflating them sends an operator to read the wrong code. `neverStarted`
    // means an earlier phase used the whole budget.
    const stalled = [...unfinished].filter((name) => started.has(name));
    const neverStarted = [...unfinished].filter((name) => !started.has(name));
    await recordSystemAlert({
      type: `cron_${group}_timeout`,
      severity: "critical",
      message:
        `The ${group} schedule was still running ${stalled.length} job(s) after ${Math.round(deadlineMs / 1000)}s `
        + `and will be cut off at the ${maxDurationSeconds}s function limit: `
        + `${stalled.map((name) => jobs[name].label).join(", ")}. `
        + (neverStarted.length > 0
          ? `${neverStarted.length} job(s) never started because an earlier phase used the budget: `
            + `${neverStarted.map((name) => jobs[name].label).join(", ")}. `
          : "")
        + "Whatever those jobs do has not finished this tick, and if this repeats they are not running at all.",
      context: {
        group,
        deadlineSeconds: Math.round(deadlineMs / 1000),
        maxDurationSeconds,
        stalled: stalled.map((name) => jobs[name].label),
        neverStarted: neverStarted.map((name) => jobs[name].label),
        finished: names.filter((name) => !unfinished.has(name)).map((name) => jobs[name].label),
      },
      dedupeWindowMs: CRON_ALERT_DEDUPE_MS,
    });
  }

  const results = names.map((name, index) => [name, settled[index]] as const);

  const failed = results.filter(([, result]) => result?.status === "rejected");
  if (failed.length > 0) {
    await recordSystemAlert({
      type: `cron_${group}_failed`,
      severity: "critical",
      message: `The ${group} schedule had ${failed.length} failing job(s): ${failed.map(([name]) => jobs[name].label).join(", ")}.`,
      // describeError, NOT String(). A PostgREST failure is a plain object, and
      // String() on one is the literal "[object Object]" — which is exactly
      // what an alert on the affiliate money path once carried, with no other
      // trace anywhere because the route still returns 200.
      context: Object.fromEntries(
        failed.map(([name, result]) => [jobs[name].label, describeError((result as PromiseRejectedResult).reason)]),
      ),
      dedupeWindowMs: CRON_ALERT_DEDUPE_MS,
    });
  }

  return {
    success: true,
    timedOut: raced === "timed_out",
    ...Object.fromEntries(
      results.map(([name, result]) => [
        name,
        result === null
          ? { error: "did not finish before the deadline" }
          : result.status === "fulfilled"
            ? result.value
            : { error: describeError(result.reason) },
      ]),
    ),
  };
}

/** The shared entry point: authorise, run, answer. */
export async function handleCronRequest(request: Request, options: CronGroupOptions) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runCronGroup(options));
}
