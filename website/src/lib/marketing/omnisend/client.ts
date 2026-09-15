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
}): Promise<OmnisendResult<T>> {
  const environment = serverAdsReportingAllowed();
  if (!environment.allowed) {
    return { ok: false, status: 0, body: null, error: `ads reporting disabled: ${environment.reason}` };
  }
  const key = String(process.env.OMNISEND_API_KEY ?? "").trim();
  if (!key) return { ok: false, status: 0, body: null, error: "OMNISEND_API_KEY not set" };

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
    if (!response.ok) {
      return { ok: false, status: response.status, body, error: `omnisend ${response.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true, status: response.status, body, error: null };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
