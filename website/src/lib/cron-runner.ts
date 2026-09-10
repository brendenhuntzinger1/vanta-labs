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
 * tick is simply picked up by the next; a transient PostgREST auth rejection
 * is retried exactly once; and the watchdog fires INSIDE the function budget
 * so a run that overruns can still report that it did.
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

async function runJobWithAuthRetry(jobs: CronJobMap, name: string): Promise<unknown> {
  try {
    return await jobs[name].run();
  } catch (error) {
    // PGRST303 "JWT issued at future" is clock skew between the lambda and
    // PostgREST, and it is real here: production raised several, each killing a
    // DIFFERENT job. A different job each time is the signature of an
    // infrastructure blip hitting whatever happened to be running, not a bug in
    // any one job. One retry, not a loop — hammering an edge that is already
    // refusing makes an outage worse rather than shorter.
    if (!isTransientAuthRejection(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, JOB_AUTH_RETRY_DELAY_MS));
    return await jobs[name].run();
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
  const running = names.map((name, index) =>
    Promise.resolve()
      .then(() => runJobWithAuthRetry(jobs, name))
      .then(
        (value) => { settled[index] = { status: "fulfilled", value }; },
        (reason: unknown) => { settled[index] = { status: "rejected", reason }; },
      )
      .finally(() => { unfinished.delete(name); }),
  );

  // THE WATCHDOG. Every alert here is written AFTER the jobs finish, so the one
  // failure mode that could never report itself was running out of time: the
  // platform kills the function, nothing is written, and a sweep that times out
  // every tick looks exactly like a sweep that is not scheduled at all. Racing
  // a deadline INSIDE the budget is what makes it reportable. The jobs are not
  // cancelled — there is no cancellation to hand them, and each is idempotent,
  // so the next tick simply picks them up again.
  const raced = await Promise.race([
    Promise.all(running).then(() => "finished" as const),
    new Promise<"timed_out">((resolve) => {
      const timer = setTimeout(() => resolve("timed_out"), deadlineMs);
      timer.unref?.();
    }),
  ]);

  if (raced === "timed_out") {
    const stalled = [...unfinished];
    await recordSystemAlert({
      type: `cron_${group}_timeout`,
      severity: "critical",
      message:
        `The ${group} schedule was still running ${stalled.length} job(s) after ${Math.round(deadlineMs / 1000)}s `
        + `and will be cut off at the ${maxDurationSeconds}s function limit: `
        + `${stalled.map((name) => jobs[name].label).join(", ")}. `
        + "Whatever those jobs do has not finished this tick, and if this repeats they are not running at all.",
      context: {
        group,
        deadlineSeconds: Math.round(deadlineMs / 1000),
        maxDurationSeconds,
        stalled: stalled.map((name) => jobs[name].label),
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
