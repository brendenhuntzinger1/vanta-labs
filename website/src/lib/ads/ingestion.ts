/**
 * COLLECT and NORMALIZE — the unglamorous half that decides whether anything
 * downstream can be believed.
 *
 * Ad platform reporting is not a clean stream. The same day gets re-fetched,
 * numbers get restated days later as the platform reconciles, requests fail
 * mid-page, rate limits bite, timezones disagree, and a retry after a partial
 * success is indistinguishable from a first attempt unless you make it so.
 *
 * Every safeguard here exists because the alternative is a dashboard that is
 * confidently wrong: doubled spend from a re-run, a "collapse in conversions"
 * that is really a failed fetch, or a comparison between a UTC day and an
 * account-timezone day. Wrong numbers are worse than missing numbers, because
 * missing numbers announce themselves.
 */

export type SourceSystem = "tiktok_reporting" | "site_analytics" | "manual";

/**
 * One fetch attempt. Written before the data lands, so a crash mid-ingest
 * leaves evidence rather than a silent hole.
 */
export type IngestionRun = {
  runId: string;
  source: SourceSystem;
  /** Reporting window requested, as dates in the source's own timezone. */
  windowStart: string;
  windowEnd: string;
  /** The timezone the SOURCE reports in. Not ours. See normaliseStatDate. */
  sourceTimezone: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "complete" | "partial" | "failed";
  rowsFetched: number;
  rowsAccepted: number;
  rowsRejected: number;
  rowsDuplicate: number;
  error?: string;
  /** Rejected rows, with the reason. Never discarded silently. */
  rejections: { key: string; reason: string }[];
};

export function startRun(input: {
  runId: string;
  source: SourceSystem;
  windowStart: string;
  windowEnd: string;
  sourceTimezone: string;
  now: string;
}): IngestionRun {
  return {
    runId: input.runId,
    source: input.source,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    sourceTimezone: input.sourceTimezone,
    startedAt: input.now,
    status: "running",
    rowsFetched: 0,
    rowsAccepted: 0,
    rowsRejected: 0,
    rowsDuplicate: 0,
    rejections: [],
  };
}

/**
 * The natural key of a metrics row.
 *
 * Ingestion is idempotent on this: re-running yesterday must overwrite
 * yesterday, never add to it. Platforms restate figures for several days after
 * the fact, so "insert if new" would freeze the first, least accurate version;
 * "always add" would double it. Upsert on this key is the only correct choice.
 */
export function metricsKey(row: { creativeId: string; statDate: string; platform: string }): string {
  return `${row.platform}|${row.creativeId}|${row.statDate}`;
}

export type RawMetricsRow = {
  creativeId?: string | null;
  statDate?: string | null;
  platform?: string | null;
  spend?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  [key: string]: unknown;
};

export type NormalizedMetricsRow = {
  key: string;
  creativeId: string;
  statDate: string;
  platform: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Where this came from and when we learned it. Needed to explain a restatement. */
  source: SourceSystem;
  observedAt: string;
  sourceTimezone: string;
};

export type NormalizeOutcome =
  | { ok: true; row: NormalizedMetricsRow }
  | { ok: false; key: string; reason: string };

/** Parse a number that a platform may send as a string, null, or "". */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalise one reported row.
 *
 * Rejects rather than coerces. A row with a missing creative id could be
 * "assigned" to something plausible, and that guess would then be
 * indistinguishable from measured data forever. Rejection is recoverable;
 * a fabricated join is not.
 */
export function normalizeMetricsRow(
  raw: RawMetricsRow,
  context: { source: SourceSystem; observedAt: string; sourceTimezone: string },
): NormalizeOutcome {
  const creativeId = String(raw.creativeId ?? "").trim();
  const statDate = String(raw.statDate ?? "").trim();
  const platform = String(raw.platform ?? "").trim().toLowerCase();
  const key = `${platform || "?"}|${creativeId || "?"}|${statDate || "?"}`;

  if (!creativeId) return { ok: false, key, reason: "no creativeId — cannot attribute this row to anything" };
  if (!ISO_DATE.test(statDate)) return { ok: false, key, reason: `statDate "${statDate}" is not YYYY-MM-DD` };
  if (!platform) return { ok: false, key, reason: "no platform" };

  const spend = num(raw.spend);
  const impressions = num(raw.impressions);
  const clicks = num(raw.clicks);

  // A null metric means "not reported", which is different from zero — but a
  // row where the core three are all absent carries no information at all.
  if (spend === null && impressions === null && clicks === null) {
    return { ok: false, key, reason: "no spend, impressions or clicks reported — empty row" };
  }
  for (const [name, value] of [["spend", spend], ["impressions", impressions], ["clicks", clicks]] as const) {
    if (value !== null && value < 0) return { ok: false, key, reason: `${name} is negative (${value})` };
  }
  if (impressions !== null && clicks !== null && clicks > impressions) {
    // Physically impossible. Almost always a mis-joined row, and it would
    // produce a CTR above 100% that then poisons a benchmark.
    return { ok: false, key, reason: `clicks (${clicks}) exceed impressions (${impressions})` };
  }

  return {
    ok: true,
    row: {
      key,
      creativeId,
      statDate,
      platform,
      spend: spend ?? 0,
      impressions: impressions ?? 0,
      clicks: clicks ?? 0,
      source: context.source,
      observedAt: context.observedAt,
      sourceTimezone: context.sourceTimezone,
    },
  };
}

export type IngestResult = {
  run: IngestionRun;
  accepted: NormalizedMetricsRow[];
};

/**
 * Normalise a batch, deduplicating within it and recording every rejection.
 *
 * Within-batch duplicates are resolved last-wins: a paginated response can
 * legitimately repeat a row across page boundaries, and the later copy is the
 * one the platform sent most recently.
 */
export function ingestBatch(
  run: IngestionRun,
  rows: RawMetricsRow[],
  context: { source: SourceSystem; observedAt: string; sourceTimezone: string },
): IngestResult {
  const byKey = new Map<string, NormalizedMetricsRow>();
  const next: IngestionRun = { ...run, rejections: [...run.rejections] };
  next.rowsFetched += rows.length;

  for (const raw of rows) {
    const outcome = normalizeMetricsRow(raw, context);
    if (!outcome.ok) {
      next.rowsRejected += 1;
      next.rejections.push({ key: outcome.key, reason: outcome.reason });
      continue;
    }
    if (byKey.has(outcome.row.key)) next.rowsDuplicate += 1;
    byKey.set(outcome.row.key, outcome.row);
  }

  next.rowsAccepted += byKey.size;
  return { run: next, accepted: [...byKey.values()] };
}

/**
 * Close a run. `partial` is a distinct state from `complete` on purpose: a run
 * that dropped rows still produced usable data, and the dashboard must be able
 * to say "this day is incomplete" instead of showing a dip that never happened.
 */
export function finishRun(run: IngestionRun, now: string, error?: string): IngestionRun {
  const status: IngestionRun["status"] = error
    ? "failed"
    : run.rowsRejected > 0
      ? "partial"
      : "complete";
  return { ...run, finishedAt: now, status, error };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type Freshness = {
  source: SourceSystem;
  lastSuccessfulAt: string | null;
  ageMinutes: number | null;
  state: "fresh" | "stale" | "never" | "failing";
  /** Shown next to any number derived from this source. */
  caveat: string | null;
};

export const STALE_AFTER_MINUTES = 180;

/**
 * How much to trust what is on screen.
 *
 * A dashboard that renders yesterday's numbers identically to today's teaches
 * the owner to act on stale data. The caveat travels with the number.
 */
export function assessFreshness(
  source: SourceSystem,
  runs: IngestionRun[],
  now: string,
): Freshness {
  const forSource = runs.filter((r) => r.source === source);
  const successes = forSource.filter((r) => r.status === "complete" || r.status === "partial");
  const latest = successes.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];

  if (!latest?.finishedAt) {
    const everFailed = forSource.some((r) => r.status === "failed");
    return {
      source,
      lastSuccessfulAt: null,
      ageMinutes: null,
      state: everFailed ? "failing" : "never",
      caveat: everFailed
        ? "Every ingestion attempt for this source has failed. Nothing below is measured."
        : "This source has never been ingested. Nothing below is measured.",
    };
  }

  const ageMinutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(latest.finishedAt)) / 60000));
  const mostRecent = forSource.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
  if (mostRecent?.status === "failed") {
    return {
      source,
      lastSuccessfulAt: latest.finishedAt,
      ageMinutes,
      state: "failing",
      caveat: `The most recent fetch failed. Showing data from ${ageMinutes} minutes ago.`,
    };
  }
  if (ageMinutes > STALE_AFTER_MINUTES) {
    return {
      source,
      lastSuccessfulAt: latest.finishedAt,
      ageMinutes,
      state: "stale",
      caveat: `Last updated ${ageMinutes} minutes ago. Treat as indicative, not current.`,
    };
  }
  return { source, lastSuccessfulAt: latest.finishedAt, ageMinutes, state: "fresh", caveat: null };
}

// ---------------------------------------------------------------------------
// Retry / rate limiting
// ---------------------------------------------------------------------------

export type RetryDecision = {
  shouldRetry: boolean;
  waitMs: number;
  reason: string;
};

/**
 * What to do with a failed API call.
 *
 * Retrying a 400 is pointless and retrying a 401 is worse than pointless — a
 * loop of unauthorised calls is how an app key gets suspended. Only transient
 * classes retry, with exponential backoff, and a rate limit's own
 * `Retry-After` always beats our guess.
 */
export function decideRetry(input: {
  status: number;
  attempt: number;
  maxAttempts?: number;
  retryAfterSeconds?: number | null;
}): RetryDecision {
  const maxAttempts = input.maxAttempts ?? 5;
  if (input.attempt >= maxAttempts) {
    return { shouldRetry: false, waitMs: 0, reason: `giving up after ${input.attempt} attempts` };
  }
  if (input.status === 429) {
    const waitMs = (input.retryAfterSeconds ?? Math.min(60, 2 ** input.attempt)) * 1000;
    return { shouldRetry: true, waitMs, reason: "rate limited — honouring the platform's own backoff" };
  }
  if (input.status >= 500) {
    return { shouldRetry: true, waitMs: Math.min(60_000, 2 ** input.attempt * 1000), reason: "server error — transient" };
  }
  if (input.status === 401 || input.status === 403) {
    return { shouldRetry: false, waitMs: 0, reason: "auth failure — retrying cannot fix it and risks the app key" };
  }
  if (input.status >= 400) {
    return { shouldRetry: false, waitMs: 0, reason: "client error — the request itself is wrong" };
  }
  return { shouldRetry: false, waitMs: 0, reason: "not an error" };
}

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

/**
 * Record the source timezone; never silently convert.
 *
 * TikTok reports in the advertiser account's timezone, and our orders are
 * stamped UTC. Shifting one to match the other invents precision — a day
 * boundary moved by five hours reassigns real conversions to the wrong day. So
 * a stat date is stored as reported, labelled with the timezone it came from,
 * and any comparison that crosses the two is flagged rather than fudged.
 */
export function describeStatDate(statDate: string, sourceTimezone: string): {
  statDate: string;
  sourceTimezone: string;
  comparableWithUtc: boolean;
  note: string;
} {
  const comparable = /^utc$|^etc\/utc$|^gmt$/i.test(sourceTimezone.trim());
  return {
    statDate,
    sourceTimezone,
    comparableWithUtc: comparable,
    note: comparable
      ? "Source reports in UTC; directly comparable with order timestamps."
      : `Source reports in ${sourceTimezone}; day boundaries differ from UTC order timestamps. ` +
        "Same-day joins are approximate — compare over multi-day windows.",
  };
}
