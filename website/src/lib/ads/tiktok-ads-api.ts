import "server-only";

/**
 * The live TikTok Ads (Marketing) API.
 *
 * A different service from the Events API, with a different credential: that
 * one reports conversions in, this one reads spend and campaigns back out and
 * can change them. Both are v1.3 and both authenticate with an `Access-Token`
 * header, and that is where the similarity ends.
 *
 * Two things shape this file.
 *
 * **TikTok answers HTTP 200 to failures.** Their envelope carries the real
 * outcome in `code`, and only `code === 0` is success. Checking the status line
 * is how an integration ends up reporting zero spend on a permissions error and
 * calling it a quiet day.
 *
 * **Credentials must not be sufficient to spend money.** Every write is behind
 * `TIKTOK_ADS_WRITE_ENABLED`, a second switch that is deliberately separate
 * from the token. Pasting a token turns on reading; spending requires a
 * distinct, deliberate act. Without that, the moment the account is authorised
 * an automated decision could create a campaign, and "I only added the
 * credential" would be a true and useless defence.
 *
 * NOT VERIFIED AGAINST TIKTOK. It is written from their v1.3 specification and
 * covered by tests against a stubbed transport, but no request has ever reached
 * TikTok from here — this environment cannot route to business-api.tiktok.com.
 * Treat every claim it makes as unproven until a real call returns code 0.
 */

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export type AdsApiCredentials = { accessToken: string; advertiserId: string };

export function readAdsCredentials(env: NodeJS.ProcessEnv = process.env): AdsApiCredentials | null {
  const accessToken = env.TIKTOK_ADS_ACCESS_TOKEN?.trim();
  const advertiserId = env.TIKTOK_ADVERTISER_ID?.trim();
  if (!accessToken || !advertiserId) return null;
  return { accessToken, advertiserId };
}

/** Reading is enabled by credentials. Spending needs its own switch. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TIKTOK_ADS_WRITE_ENABLED?.trim().toLowerCase() === "true";
}

export type ApiResult<T> =
  | { ok: true; data: T; requestId: string | null }
  | { ok: false; code: number | null; message: string; requestId: string | null; httpStatus: number | null };

type Envelope<T> = { code?: number; message?: string; request_id?: string; data?: T };

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One request, with TikTok's envelope unwrapped honestly.
 *
 * Never throws for a rejected call — the failure is a value, so a caller has to
 * look at it. Throwing would tempt a try/catch that swallows a permissions
 * error into an empty result set.
 */
export async function callAdsApi<T>(
  path: string,
  options: {
    credentials: AdsApiCredentials;
    method?: "GET" | "POST";
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs?: number;
    transport?: Transport;
  },
): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const fetcher = options.transport ?? fetch;

  try {
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        // The only place the token appears. Never logged, never returned.
        "Access-Token": options.credentials.accessToken,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: Envelope<T>;
    try {
      parsed = JSON.parse(text) as Envelope<T>;
    } catch {
      return {
        ok: false,
        code: null,
        message: `response was not JSON (${text.slice(0, 200)})`,
        requestId: null,
        httpStatus: response.status,
      };
    }

    const requestId = parsed.request_id ?? null;
    if (parsed.code !== 0) {
      return {
        ok: false,
        code: typeof parsed.code === "number" ? parsed.code : null,
        message: parsed.message ?? "TikTok returned an error with no message",
        requestId,
        httpStatus: response.status,
      };
    }
    return { ok: true, data: (parsed.data ?? {}) as T, requestId };
  } catch (error) {
    return {
      ok: false,
      code: null,
      message: controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error),
      requestId: null,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type CampaignPerformance = {
  campaignId: string;
  campaignName: string;
  statDate: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Derived here so every surface computes them identically. */
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
};

const REPORT_METRICS = ["spend", "impressions", "clicks", "conversion", "campaign_name"];

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Division that returns null instead of NaN or Infinity on a zero denominator. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function toCampaignPerformance(row: {
  dimensions?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}): CampaignPerformance {
  const dimensions = row.dimensions ?? {};
  const metrics = row.metrics ?? {};
  const spend = num(metrics.spend);
  const impressions = num(metrics.impressions);
  const clicks = num(metrics.clicks);
  const conversions = num(metrics.conversion);

  return {
    campaignId: String(dimensions.campaign_id ?? ""),
    campaignName: String(metrics.campaign_name ?? dimensions.campaign_id ?? ""),
    statDate: String(dimensions.stat_time_day ?? "").slice(0, 10),
    spend,
    impressions,
    clicks,
    conversions,
    ctr: ratio(clicks, impressions),
    cpc: ratio(spend, clicks),
    // CPM is per thousand impressions, so the denominator is impressions/1000.
    cpm: ratio(spend, impressions / 1000),
    cpa: ratio(spend, conversions),
  };
}

export async function fetchCampaignPerformance(input: {
  credentials: AdsApiCredentials;
  since: string;
  until: string;
  transport?: Transport;
}): Promise<ApiResult<CampaignPerformance[]>> {
  const result = await callAdsApi<{ list?: { dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> }[] }>(
    "/report/integrated/get/",
    {
      credentials: input.credentials,
      method: "GET",
      transport: input.transport,
      query: {
        advertiser_id: input.credentials.advertiserId,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(REPORT_METRICS),
        start_date: input.since,
        end_date: input.until,
        page_size: 1000,
      },
    },
  );

  if (!result.ok) return result;
  return { ok: true, requestId: result.requestId, data: (result.data.list ?? []).map(toCampaignPerformance) };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export class AdsWritesDisabledError extends Error {
  constructor(action: string) {
    super(
      `Refusing to ${action}: TIKTOK_ADS_WRITE_ENABLED is not "true". ` +
        "Credentials alone permit reading only — spending requires a separate, deliberate switch.",
    );
    this.name = "AdsWritesDisabledError";
  }
}

export function assertWritesEnabled(action: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!writesEnabled(env)) throw new AdsWritesDisabledError(action);
}

export async function setCampaignStatus(input: {
  credentials: AdsApiCredentials;
  campaignId: string;
  status: "ENABLE" | "DISABLE";
  transport?: Transport;
}): Promise<ApiResult<unknown>> {
  // Pausing is the safe direction and enabling is not, but both are gated:
  // a system that may pause may also un-pause, and that spends money.
  assertWritesEnabled(`${input.status === "ENABLE" ? "enable" : "pause"} campaign ${input.campaignId}`);
  return callAdsApi("/campaign/status/update/", {
    credentials: input.credentials,
    method: "POST",
    transport: input.transport,
    body: {
      advertiser_id: input.credentials.advertiserId,
      campaign_ids: [input.campaignId],
      operation_status: input.status,
    },
  });
}
