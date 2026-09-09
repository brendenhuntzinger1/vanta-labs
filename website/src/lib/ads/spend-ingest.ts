import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  activeWindsorConnectors,
  fetchConnectorSpend,
  WINDSOR_REQUEST_TIMEOUT_MS,
  type SpendRow,
  type WindsorConnector,
} from "./windsor-client";

/**
 * Pull yesterday's — and last week's — ad spend into `ad_spend_daily`.
 *
 * TWO DECISIONS CARRY THIS FILE.
 *
 * **It re-fetches a trailing window, not just yesterday.** Every ad platform
 * restates: conversions get attributed late, invalid clicks get refunded, and a
 * day's spend can move for a week afterwards. A job that fetches only yesterday
 * freezes the first number it ever saw and quietly disagrees with the platform's
 * own dashboard forever after. Re-fetching seven days means the stored figure
 * converges on the platform's final one.
 *
 * **Which is only safe because the write is an upsert on the platform's own
 * key.** `(platform, ad_id, stat_date)` is the primary key, so the seventh
 * re-fetch of a day overwrites the sixth instead of adding to it. Without that,
 * a trailing window would multiply a week's spend by seven — the characteristic
 * catastrophe of ad reporting pipelines, and the reason the key is in the schema
 * rather than in a comment.
 *
 * A connector that fails is isolated. Snapchat's grant expiring must not cost
 * the store its Meta numbers, so each is fetched and reported independently and
 * the job's outcome names which ones worked.
 */

/**
 * How many days back to re-fetch on every run.
 *
 * Seven is chosen for restatement, not for safety margin: Meta and TikTok both
 * finalise within about three days, and a week leaves room for a job that did
 * not run over a weekend to heal the gap by itself rather than needing a
 * backfill.
 */
export const RESTATEMENT_WINDOW_DAYS = 7;

/** Rows per upsert. Small enough to stay well inside the 60s cron budget. */
const CHUNK_SIZE = 500;

/**
 * How long the WHOLE job may spend fetching, across every connector.
 *
 * A per-request deadline alone is not enough. The connectors are fetched one
 * after another, so three of them each stopping at the client's 15s limit is
 * still 45s — and the cron sweep's watchdog fires at 50s and needs the
 * remaining ten seconds to write its alert and email the operator. That is the
 * failure this job actually caused on 2026-09-08: a critical
 * `cron_sweep_timeout` naming `ad_spend_ingest` as the only job still running.
 *
 * Thirty-five seconds leaves the watchdog fifteen seconds of headroom while
 * still allowing every connector a real attempt on a healthy day, when the
 * whole job takes a second or two. Past it, connectors are not started at all:
 * a partial window that lands is worth more than a complete one that is killed
 * mid-flight, and the next tick re-fetches the same trailing window anyway.
 */
export const SPEND_INGEST_BUDGET_MS = 35_000;

/**
 * Least time between two real fetches.
 *
 * The sweep this hangs off runs every 30 minutes. Refreshing that often would
 * be 144 Windsor requests a day for three connectors, to restate numbers the
 * platforms themselves only settle a few times a day — so the gate exists to
 * stop the feed spending quota on data that has not changed.
 *
 * SIX HOURS WAS TOO COARSE FOR THE PERSON WATCHING THE DASHBOARD. It is defensible
 * against the data's own granularity and indefensible when someone has just
 * changed an ad and wants to see the spend land: the honest worst case was
 * "correct in up to six hours", which reads as broken. One hour is still only
 * 72 requests a day, comfortably inside any quota, and it is the difference
 * between checking the dashboard and waiting on it.
 *
 * Override with ADS_SPEND_MIN_HOURS — 0.5 matches the sweep exactly, if the
 * quota ever proves to allow it.
 *
 * The gate is a freshness READ rather than a schedule, so it stays correct when
 * the sweep is late, runs twice, or is triggered by hand, and it needs no state
 * of its own beyond the rows already being written.
 */
export const MIN_HOURS_BETWEEN_RUNS = (() => {
  const raw = Number(process.env.ADS_SPEND_MIN_HOURS);
  // A nonsense value must not disable the gate: an unparseable or non-positive
  // override would otherwise mean "fetch on every sweep, forever".
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

/** UTC, because `stat_date` is a UTC day and a local day would silently shift it. */
export function spendWindow(now: Date, days = RESTATEMENT_WINDOW_DAYS): { dateFrom: string; dateTo: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10) };
}

/** `SpendRow` to the column names in `ad_spend_daily`. Kept next to the ingest
 *  so the storage shape and the fetched shape cannot drift apart. */
export function toDbRow(row: SpendRow): Record<string, unknown> {
  return {
    platform: row.platform,
    ad_id: row.adId,
    stat_date: row.statDate,
    campaign_id: row.campaignId,
    campaign_name: row.campaignName,
    adgroup_id: row.adgroupId,
    adgroup_name: row.adgroupName,
    ad_name: row.adName,
    landing_url: row.landingUrl,
    utm_content: row.utmContent,
    utm_campaign: row.utmCampaign,
    platform_conversions: row.platformConversions,
    platform_conversion_value: row.platformConversionValue,
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    currency: row.currency,
    source: "windsor",
    ingested_at: new Date().toISOString(),
  };
}

export type ConnectorOutcome = {
  connector: WindsorConnector;
  status: "ok" | "failed" | "skipped";
  rows: number;
  written: number;
  rejected: number;
  /** Rows the platform reported with no readable creative tag. Spend we can see
   *  but cannot tie to revenue — worth surfacing, never worth hiding. */
  untagged: number;
  /** Duplicate (platform, ad_id, stat_date) pairs summed before the write. */
  merged: number;
  error?: string;
  /** Windsor's reply when it returned nothing. See FetchOutcome.emptySample. */
  emptySample?: string;
};

export type SpendIngestResult = {
  ran: boolean;
  reason?: string;
  dateFrom?: string;
  dateTo?: string;
  connectors: ConnectorOutcome[];
  totalWritten: number;
  totalSpend: number;
};

type Chunker = (rows: Record<string, unknown>[]) => Promise<{ error: { code?: string; message: string } | null }>;

/**
 * The testable core. Every dependency is injected, so the whole job — including
 * a connector failing halfway and a chunk being rejected — is exercised without
 * a network or a database.
 */
export async function runSpendIngest(deps: {
  apiKey: string | null | undefined;
  now: Date;
  upsert: Chunker;
  fetchImpl?: typeof fetch;
  connectors?: readonly WindsorConnector[];
  windowDays?: number;
  /** Newest `ingested_at` already stored, or null when nothing has ever landed. */
  lastIngestedAt?: Date | null;
  /** Bypass the freshness gate — an operator pressing refresh, not the cron. */
  force?: boolean;
  /** Per-request deadline. Only ever narrows the client's own. */
  requestTimeoutMs?: number;
  /** Whole-job fetch budget. See SPEND_INGEST_BUDGET_MS. */
  budgetMs?: number;
  /** Monotonic clock, injected so the budget is testable without waiting. */
  elapsedNow?: () => number;
}): Promise<SpendIngestResult> {
  const empty: SpendIngestResult = { ran: false, connectors: [], totalWritten: 0, totalSpend: 0 };

  const apiKey = deps.apiKey?.trim();
  if (!apiKey) {
    // Not an error. The feed is unconfigured, which is a state an operator needs
    // named plainly rather than discovering as an empty dashboard.
    return { ...empty, reason: "WINDSOR_API_KEY is not set — ad spend cannot be fetched" };
  }

  if (!deps.force && deps.lastIngestedAt) {
    const hours = (deps.now.getTime() - deps.lastIngestedAt.getTime()) / 3_600_000;
    if (hours < MIN_HOURS_BETWEEN_RUNS) {
      return { ...empty, reason: `last fetch was ${hours.toFixed(1)}h ago; minimum interval is ${MIN_HOURS_BETWEEN_RUNS}h` };
    }
  }

  const { dateFrom, dateTo } = spendWindow(deps.now, deps.windowDays);
  const connectors = deps.connectors ?? activeWindsorConnectors();
  const outcomes: ConnectorOutcome[] = [];
  let totalWritten = 0;
  let totalSpend = 0;

  const budgetMs = deps.budgetMs ?? SPEND_INGEST_BUDGET_MS;
  const clock = deps.elapsedNow ?? (() => Date.now());
  const startedAt = clock();

  for (const connector of connectors) {
    const outcome: ConnectorOutcome = { connector, status: "ok", rows: 0, written: 0, rejected: 0, untagged: 0, merged: 0 };

    // OUT OF TIME IS "failed", NOT "skipped".
    //
    // `skipped` means "this platform is not attached to the account" and is
    // excluded from BOTH sides of the every-connector-failed incident check
    // below. Reusing it here would make a feed that is timing out on every
    // connector report as a store that has simply stopped advertising — the
    // exact "a broken feed reads as a quiet one" failure the rest of this file
    // is built to prevent. It did not get its data, so it failed.
    const remaining = budgetMs - (clock() - startedAt);
    if (remaining <= 0) {
      outcomes.push({
        ...outcome,
        status: "failed",
        error:
          `not attempted — the ${Math.round(budgetMs / 1000)}s ingest budget was spent by the connectors before it. `
          + "The next tick re-fetches the same trailing window, so this heals itself if the feed recovers.",
      });
      continue;
    }

    const fetched = await fetchConnectorSpend({
      connector,
      apiKey,
      dateFrom,
      dateTo,
      fetchImpl: deps.fetchImpl,
      // Whichever is sooner: the client's own per-request deadline, or all the
      // budget this job has left. Without the clamp three connectors each
      // stopping at 15s would still add up past the sweep's 50s watchdog.
      timeoutMs: Math.min(deps.requestTimeoutMs ?? WINDSOR_REQUEST_TIMEOUT_MS, remaining),
    });

    if (!fetched.ok) {
      // A PLATFORM NOBODY HAS CONNECTED IS SKIPPED, NOT FAILED.
      //
      // Windsor answers a hard error for a connector with no attached account —
      // "No snapchat account for user … was found" — so a platform detached for
      // ordinary marketing reasons would otherwise report a failed connector on
      // every nightly run, for as long as it stayed detached. An operator
      // learns to ignore a signal that is always red, which costs them the one
      // that means the feed is down.
      outcomes.push({
        ...outcome,
        status: fetched.notConnected ? "skipped" : "failed",
        error: fetched.error,
      });
      continue;
    }

    outcome.rows = fetched.rows.length;
    if (fetched.emptySample !== undefined) outcome.emptySample = fetched.emptySample;
    outcome.rejected = fetched.rejections.length;
    outcome.untagged = fetched.rows.filter((r) => !r.utmContent && r.spend > 0).length;

    // ONE ROW PER (platform, ad_id, stat_date), BECAUSE THE UPSERT DEMANDS IT.
    //
    // The write is `insert … on conflict (platform, ad_id, stat_date) do update`
    // per chunk, and Postgres refuses a statement that presents the same
    // conflict target twice: SQLSTATE 21000, "ON CONFLICT DO UPDATE command
    // cannot affect row a second time". The rows go to the database exactly as
    // fetched, with no de-duplication anywhere in between — and a duplicate pair
    // is routine, because the fetch asks for a URL dimension: one ad running two
    // creatives or two landing URLs on one day comes back as two rows.
    //
    // One such pair aborted the CHUNK, which broke the loop, which failed the
    // whole connector for the run — dropping its entire trailing window with a
    // message that reads like a write failure. Summed here instead, which is
    // exactly the aggregation Windsor would have done had the URL dimension not
    // been requested. The last-seen labels win; the tags are the same for any
    // pair that shares a key.
    const merged = new Map<string, typeof fetched.rows[number]>();
    for (const row of fetched.rows) {
      const key = `${row.platform}\u0000${row.adId}\u0000${row.statDate}`;
      const seen = merged.get(key);
      if (!seen) {
        merged.set(key, { ...row });
        continue;
      }
      seen.spend += row.spend;
      seen.impressions += row.impressions;
      seen.clicks += row.clicks;
      if (row.platformConversions !== null) {
        seen.platformConversions = (seen.platformConversions ?? 0) + row.platformConversions;
      }
      if (row.platformConversionValue !== null) {
        seen.platformConversionValue = (seen.platformConversionValue ?? 0) + row.platformConversionValue;
      }
      // A LATER row that carries a tag beats an earlier one that does not: an
      // untagged variant must not erase the tag the pair does have.
      seen.utmContent = row.utmContent ?? seen.utmContent;
      seen.utmCampaign = row.utmCampaign ?? seen.utmCampaign;
      seen.campaignId = row.campaignId ?? seen.campaignId;
      seen.campaignName = row.campaignName ?? seen.campaignName;
      seen.adgroupId = row.adgroupId ?? seen.adgroupId;
      seen.adgroupName = row.adgroupName ?? seen.adgroupName;
      seen.adName = row.adName ?? seen.adName;
      seen.landingUrl = row.landingUrl ?? seen.landingUrl;
    }
    const writable = [...merged.values()];
    outcome.merged = fetched.rows.length - writable.length;

    for (let i = 0; i < writable.length; i += CHUNK_SIZE) {
      const slice = writable.slice(i, i + CHUNK_SIZE);
      const { error } = await deps.upsert(slice.map(toDbRow));
      if (error) {
        // A write failure is reported against the connector rather than thrown.
        // The next run re-fetches the same window and tries again, which is the
        // whole reason the window is trailing.
        outcome.status = "failed";
        outcome.error = error.code === "42P01"
          ? "ad_spend_daily does not exist — apply ads-spend-roas.sql"
          // The SQLSTATE travels, so 21000 (a duplicate conflict target that
          // survived the merge above) is distinguishable from a transient write
          // failure in the operator alert.
          : `${error.message}${error.code ? ` [${error.code}]` : ""}`;
        break;
      }
      outcome.written += slice.length;
      totalSpend += slice.reduce((sum, r) => sum + r.spend, 0);
    }

    totalWritten += outcome.written;
    outcomes.push(outcome);
  }

  // EVERY CONNECTOR FAILING IS AN INCIDENT, AND IT MUST BE LOUD.
  //
  // Returning normally here was a real defect in the first version. A revoked
  // API key, an expired Windsor grant or a DNS failure would mark all four
  // connectors "failed" inside a result nobody reads, the sweep would record the
  // job as successful, and the dashboard would show an empty table. "No spend
  // yet" and "the feed has been broken for a week" looked identical — the exact
  // failure this system is built to prevent, sitting in the system itself.
  //
  // Throwing routes it into the sweep's own alerting (recordSystemAlert →
  // operator email), which is the only path that reaches a human.
  //
  // One connector failing must NOT throw: Snapchat's grant expiring cannot be
  // allowed to discard Meta's numbers, and that partial state is reported in
  // `connectors` for the dashboard to show.
  // Skipped connectors are excluded from BOTH sides of this test. A store that
  // has detached three of its four platforms and has one healthy feed is not
  // having an incident, and one that has detached ALL of them is not either —
  // it has simply stopped advertising, which the dashboard already says.
  const attempted = outcomes.filter((o) => o.status !== "skipped");
  const failed = attempted.filter((o) => o.status === "failed");
  if (attempted.length > 0 && failed.length === attempted.length) {
    throw new Error(
      `ad spend ingest failed on every connected platform (${failed.length}/${attempted.length}): ` +
        failed.map((f) => `${f.connector}: ${f.error ?? "unknown"}`).join("; "),
    );
  }

  return {
    ran: true,
    dateFrom,
    dateTo,
    connectors: outcomes,
    totalWritten,
    totalSpend: Math.round(totalSpend * 100) / 100,
  };
}

/**
 * The cron entry point. Idempotent by construction — see the upsert key above —
 * so running it more often than nightly is harmless and running it less often
 * only means coarser freshness.
 */
/**
 * The freshness gate keys off rows that were successfully WRITTEN, which means
 * it cannot engage while the feed is broken.
 *
 * readLastIngestedAt returns the newest `ingested_at` in ad_spend_daily, so a
 * run that writes nothing leaves the gate permanently disarmed. That is not
 * hypothetical — it is the live state of this store: Windsor currently answers
 * every connector with a plan-limit notice in place of data, every row is
 * rejected, nothing is written, and the job throws. vercel.json runs the sweep
 * every thirty minutes, so the six-hour interval this file exists to enforce
 * becomes 192 Windsor calls a day, and the cron_sweep_failed alert (which had
 * no dedupe window, unlike the timeout alert fifteen lines above it) becomes
 * 48 criticals and 48 operator emails a day. That is one standing problem, not
 * forty-eight.
 *
 * So the interval is enforced on ATTEMPTS as well as on writes, through the
 * store's own rate limiter rather than a new table. A failing feed now backs
 * off exactly as a healthy one does, and an operator pressing refresh still
 * bypasses both gates with `force`.
 */
const ATTEMPT_BUCKET = "ads-spend-ingest";

export async function ingestAdSpend(options: { force?: boolean } = {}): Promise<SpendIngestResult> {
  if (!options.force) {
    const attempt = await checkRateLimit(ATTEMPT_BUCKET, 1, MIN_HOURS_BETWEEN_RUNS * 3600);
    if (!attempt.allowed) {
      return {
        ran: false,
        connectors: [],
        totalWritten: 0,
        totalSpend: 0,
        reason:
          `last ATTEMPT was under ${MIN_HOURS_BETWEEN_RUNS}h ago (retry in ${attempt.retryAfterSeconds}s); `
          + "the interval is enforced on attempts so a failing feed backs off like a healthy one",
      };
    }
  }
  const result = await runSpendIngest({
    apiKey: process.env.WINDSOR_API_KEY,
    now: new Date(),
    force: options.force,
    lastIngestedAt: await readLastIngestedAt(),
    upsert: async (rows) => {
      const { error } = await supabaseAdmin
        .from("ad_spend_daily")
        .upsert(rows, { onConflict: "platform,ad_id,stat_date" });
      return { error: error ? { code: error.code, message: error.message } : null };
    },
  });

  // WHAT EACH CONNECTOR SAID, WHERE SOMEONE CAN READ IT LATER.
  //
  // Every per-connector outcome lived only in the value returned from here, and
  // the only production caller is Vercel Cron, which discards the response
  // body. So an ingest that fetched nothing was indistinguishable from an
  // ingest that fetched nothing FOR A REASON: the table simply stayed as it
  // was, no alarm fired (an empty `data` array is a legitimately quiet day),
  // and there was no way to find out which connector had answered what without
  // being the caller.
  //
  // That cost a full round on 2026-09-07. The Windsor connector fix deployed,
  // the sweep ran, zero rows were written, and nothing anywhere could say
  // whether Windsor had returned an empty window, skipped a platform as not
  // connected, or failed — the three cases with completely different fixes.
  //
  // One line, at info. No API key, no customer data: connector names, statuses,
  // counts and the provider's own error text, which is the thing worth having
  // at 2am and is already written to be read by a human.
  const summary = result.connectors
    .map((c) => `${c.connector}=${c.status}(rows ${c.rows}, written ${c.written}${c.error ? `, ${c.error}` : ""}${c.emptySample ? `, empty reply: ${c.emptySample}` : ""})`)
    .join("; ");
  console.log(
    `[ads-spend] ${result.ran ? "ran" : "did not run"}: written ${result.totalWritten}, spend ${result.totalSpend}`
    + `${result.reason ? `, reason: ${result.reason}` : ""}`
    + `${summary ? ` — ${summary}` : " — no connectors attempted"}`,
  );

  return result;
}

/**
 * Newest `ingested_at` in the table, or null.
 *
 * A read that fails — including the table not existing yet — returns null,
 * which lets the ingest proceed and report the real problem when it tries to
 * write. Refusing to run because the freshness check itself broke would hide
 * the actual fault behind a rate limit.
 */
async function readLastIngestedAt(): Promise<Date | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("ad_spend_daily")
      .select("ingested_at")
      .order("ingested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.ingested_at) return null;
    const at = new Date(String(data.ingested_at));
    return Number.isFinite(at.getTime()) ? at : null;
  } catch {
    // Missing table, missing credentials, a network blip: all mean "we do not
    // know when this last ran", and the ingest should then proceed and report
    // the real problem when it writes. Throwing here would surface a rate-limit
    // question as the job's cause of death.
    return null;
  }
}
