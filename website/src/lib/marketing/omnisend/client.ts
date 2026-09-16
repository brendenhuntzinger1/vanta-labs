import "server-only";

import { serverAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { OMNISEND_API_VERSION, omnisendConfigured } from "@/lib/marketing/omnisend/config";

/**
 * THE ONE PLACE THAT TALKS TO OMNISEND.
 *
 * Every contact, event, product, batch or read goes through omnisendRequest,
 * and omnisendRequest applies the environment gate BEFORE it reads the API
 * key. That order is the whole point: a Vercel preview deployment inherits
 * production's variables unless someone scoped them by hand, so "the key is
 * set" is not evidence that this is production. The gate is the same one every
 * ad platform leg uses (K-16, lib/ads/ads-environment.ts) — deny by default,
 * no override — because a preview or QA run that pushed contacts and cart
 * events into the live Omnisend account would enrol real people in real
 * automations and send them real mail.
 *
 * Never throws. Every caller is on a request path or inside after(), and none
 * of them may fail an order, a checkout or a page over a marketing sync.
 */

export const OMNISEND_API_BASE = "https://api.omnisend.com/api";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * WHAT IS RETRIED, AND HOW LITTLE.
 *
 * Omnisend's API guide: 429, 500, 503 and 524, socket timeouts and TCP
 * disconnects MUST be retried with backoff; every other 4xx is the request's
 * own fault and must not be. The guide's suggested intervals (30 s, 120 s,
 * 480 s) belong to a queue worker, not to a request path — a checkout's
 * after() callback and a 60-second cron have no such time — so the transport
 * retries ONCE, after a short pause, and hands the rest to the parts of the
 * system that already carry it: the event ledger records the refusal, the
 * order backstop sweep retries paid orders, the nightly reconcile re-pushes
 * every contact. A Retry-After header is honoured up to a cap, because a
 * 429 that asks for two minutes is a 429 this call will not outlive.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 503, 524]);
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 5_000;

/** How long to wait before the retry: Retry-After (seconds) capped, else the default. Pure. */
export function retryDelayFor(retryAfter: string | null | undefined, fallbackMs: number): number {
  const seconds = Number(String(retryAfter ?? "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1_000));
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export type OmnisendMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type OmnisendResult<T> = {
  ok: boolean;
  /** HTTP status, or 0 when no request was made or the transport failed. */
  status: number;
  body: T | null;
  error: string | null;
};

/**
 * Is the integration allowed to do anything right now?
 *
 * Gate first, key second — the same order as the request itself — so a hook
 * on a preview deployment returns before it does any database work.
 */
export function omnisendActive(): { active: true; reason: null } | { active: false; reason: string } {
  const environment = serverAdsReportingAllowed();
  if (!environment.allowed) return { active: false, reason: environment.reason };
  const configured = omnisendConfigured();
  if (!configured.configured) return { active: false, reason: configured.reason };
  return { active: true, reason: null };
}

export async function omnisendRequest<T = unknown>(input: {
  method: OmnisendMethod;
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** Retries after a retryable failure. Default 1; 0 for a call that must not repeat. */
  retries?: number;
  /** Pause before a retry when Omnisend sends no Retry-After. Default one second. */
  retryDelayMs?: number;
}): Promise<OmnisendResult<T>> {
  const environment = serverAdsReportingAllowed();
  if (!environment.allowed) {
    return { ok: false, status: 0, body: null, error: `ads reporting disabled: ${environment.reason}` };
  }
  const key = String(process.env.OMNISEND_API_KEY ?? "").trim();
  if (!key) return { ok: false, status: 0, body: null, error: "OMNISEND_API_KEY not set" };

  const retries = Math.max(0, Math.trunc(input.retries ?? DEFAULT_RETRIES));
  const fallbackDelay = Math.max(0, input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  let attempt = 0;
  for (;;) {
    const result = await attemptOmnisendRequest<T>(key, input);
    const retryable = result.status === 0 || RETRYABLE_STATUSES.has(result.status);
    if (result.ok || !retryable || attempt >= retries) return result.result;
    attempt += 1;
    await sleep(retryDelayFor(result.retryAfter, fallbackDelay));
  }
}

/** One HTTP attempt. Never throws; the transport error is a result with status 0. */
async function attemptOmnisendRequest<T>(
  key: string,
  input: { method: OmnisendMethod; path: string; body?: unknown; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; retryAfter: string | null; result: OmnisendResult<T> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${OMNISEND_API_BASE}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Omnisend-API-Key ${key}`,
        "Omnisend-Version": OMNISEND_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let body: T | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = null;
      }
    }
    const retryAfter = typeof response.headers?.get === "function" ? response.headers.get("retry-after") : null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        retryAfter,
        result: { ok: false, status: response.status, body, error: `omnisend ${response.status}: ${text.slice(0, 300)}` },
      };
    }
    return { ok: true, status: response.status, retryAfter, result: { ok: true, status: response.status, body, error: null } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, retryAfter: null, result: { ok: false, status: 0, body: null, error: message } };
  } finally {
    clearTimeout(timer);
  }
}
