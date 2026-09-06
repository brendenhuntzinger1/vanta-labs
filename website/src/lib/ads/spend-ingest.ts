import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import {
  WINDSOR_CONNECTORS,
  fetchConnectorSpend,
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
 * Least time between two real fetches.
 *
 * The sweep this hangs off runs every 30 minutes, which for four connectors
 * would be 192 Windsor requests a day to restate numbers the platforms
 * themselves only update a few times a day. Six hours gives four refreshes
 * daily — well inside any quota, and finer than the data's own granularity.
 *
 * The gate is a freshness READ rather than a schedule, so it stays correct when
 * the sweep is late, runs twice, or is triggered by hand, and it needs no state
 * of its own beyond the rows already being written.
 */
export const MIN_HOURS_BETWEEN_RUNS = 6;

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
  error?: string;
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
  const connectors = deps.connectors ?? WINDSOR_CONNECTORS;
  const outcomes: ConnectorOutcome[] = [];
  let totalWritten = 0;
  let totalSpend = 0;

  for (const connector of connectors) {
    const outcome: ConnectorOutcome = { connector, status: "ok", rows: 0, written: 0, rejected: 0, untagged: 0 };

    const fetched = await fetchConnectorSpend({
      connector,
      apiKey,
      dateFrom,
      dateTo,
      fetchImpl: deps.fetchImpl,
    });

    if (!fetched.ok) {
      outcomes.push({ ...outcome, status: "failed", error: fetched.error });
      continue;
    }

    outcome.rows = fetched.rows.length;
    outcome.rejected = fetched.rejections.length;
    outcome.untagged = fetched.rows.filter((r) => !r.utmContent && r.spend > 0).length;

    for (let i = 0; i < fetched.rows.length; i += CHUNK_SIZE) {
      const slice = fetched.rows.slice(i, i + CHUNK_SIZE);
      const { error } = await deps.upsert(slice.map(toDbRow));
      if (error) {
        // A write failure is reported against the connector rather than thrown.
        // The next run re-fetches the same window and tries again, which is the
        // whole reason the window is trailing.
        outcome.status = "failed";
        outcome.error = error.code === "42P01" ? "ad_spend_daily does not exist — apply ads-spend-roas.sql" : error.message;
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
  const failed = outcomes.filter((o) => o.status === "failed");
  if (outcomes.length > 0 && failed.length === outcomes.length) {
    throw new Error(
      `ad spend ingest failed on every connector (${failed.length}/${outcomes.length}): ` +
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
export async function ingestAdSpend(options: { force?: boolean } = {}): Promise<SpendIngestResult> {
  return runSpendIngest({
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
