import "server-only";

import { serverAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_PURCHASE_CONVERSION_ACTION_ID } from "@/lib/ads/google-conversion-id";
import type { GoogleEvent } from "@/lib/ads/google-events";

/**
 * Google Ads Enhanced Conversions — the server-side leg.
 *
 * WHY IT EXISTS. The browser tag is the only path today, and a meaningful share
 * of it never arrives: ad blockers, tracking-protection defaults, a tab closed
 * before the request flushes. This reports the same purchase from the server,
 * where none of that applies. Both legs carry the same `transaction_id`, so
 * Google counts ONE conversion.
 *
 * IT FAILS CLOSED ON PARTIAL CONFIGURATION, and that is the important property
 * here. Five separate values are needed; a half-configured integration that
 * attempted the call anyway would produce either an error on every paid order
 * or, worse, a conversion carrying incomplete identity. Absence of a complete
 * credential set is a refusal, not a best-effort attempt.
 *
 * ITS CREDENTIAL CHECK IS INDEPENDENT of TikTok's and Reddit's. Nesting Reddit
 * inside TikTok's was a real silent single point of failure — with one token
 * configured and the other absent, the whole block was skipped and conversions
 * never sent while every dashboard looked fine. Four platforms, four gates.
 *
 * ON DIAGNOSTICS. `describeGoogleResult` is built from a fixed field set
 * precisely so a token, a customer id or a customer's data cannot reach a log
 * line, a Sentry breadcrumb or the audit log. It has no field to carry one.
 *
 * ON THE CONVERSION ACTION ID. `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID` is
 * NOT the same value as the browser leg's gtag conversion label. The label
 * (`GOOGLE_PURCHASE_LABEL`, an opaque string used in `send_to: 'AW-123/AbC-D_efG'`)
 * is a browser-surface concept; this REST API addresses the same conversion
 * action by its numeric resource id
 * (`customers/<cid>/conversionActions/<numeric id>`). The two must never be
 * conflated — sending the gtag label here produces a resource name Google
 * cannot resolve, and the failure is a rejected upload, not anything visible
 * in the browser. It is required and shape-checked for the same reason: an
 * upload against a missing or malformed id has nothing to report against.
 *
 * ON TIMEOUTS. `sendGoogleConversion` is awaited inline from a customer's
 * confirmation page (see the purchase-event route). Both network calls it
 * makes — the OAuth refresh and the upload — are bounded by an AbortController,
 * the same mechanism `reddit-conversions.ts` already uses, so a slow or hung
 * Google endpoint cannot stall that page beyond `DEFAULT_TIMEOUT_MS`. A timeout
 * is reported as `message: "timed out"`, which `describeGoogleResult` renders
 * distinctly from both a rejection (which carries an HTTP code) and a generic
 * network error, so an operator can tell "Google was slow" from "Google said
 * no" at a glance.
 */

const DEFAULT_TIMEOUT_MS = 8000;

const REQUIRED_ENV = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID",
] as const;

const CONVERSION_ACTION_ID_SHAPE = /^\d+$/;

export type GoogleSendResult = {
  attempted: boolean;
  delivered: boolean;
  code: number | null;
  message: string | null;
};

function present(key: string): boolean {
  return String(process.env[key] ?? "").trim().length > 0;
}

/**
 * Every credential, or none. `missing` names what to set rather than making an
 * operator diff two lists by hand.
 */
export function googleCredentialStatus(): { configured: boolean; missing: string[] } {
  const missing = REQUIRED_ENV.filter((key) => !present(key));
  return { configured: missing.length === 0, missing };
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_API_BASE = "https://googleads.googleapis.com/v18/customers";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function accessToken(timeoutMs: number): Promise<{ token: string | null; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: String(process.env.GOOGLE_ADS_CLIENT_ID),
        client_secret: String(process.env.GOOGLE_ADS_CLIENT_SECRET),
        refresh_token: String(process.env.GOOGLE_ADS_REFRESH_TOKEN),
        grant_type: "refresh_token",
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { token: null, timedOut: false };
    const body = (await response.json()) as { access_token?: string };
    return { token: body.access_token ?? null, timedOut: false };
  } catch (error) {
    return { token: null, timedOut: isAbortError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report one purchase.
 *
 * Best-effort telemetry by contract: it never throws, because the caller is a
 * customer's confirmation page and a measurement failure must not become a
 * customer-visible one.
 */
export async function sendGoogleConversion(input: {
  event: GoogleEvent;
  occurredAt: Date;
  timeoutMs?: number;
}): Promise<GoogleSendResult> {
  const notAttempted: GoogleSendResult = { attempted: false, delivered: false, code: null, message: null };

  if (!googleCredentialStatus().configured) {
    return { ...notAttempted, message: "credentials incomplete" };
  }

  // The one gate that decides whether an ad event may leave this deployment.
  // A preview, a local run, CI or a Playwright script must never train the real
  // account. Deny by default; there is deliberately no override.
  const verdict = serverAdsReportingAllowed();
  if (!verdict.allowed) {
    return { ...notAttempted, message: `suppressed: ${verdict.reason ?? "not production"}` };
  }

  const transactionId = input.event.params.transaction_id;
  if (!transactionId) return { ...notAttempted, message: "no transaction id" };

  if (!CONVERSION_ACTION_ID_SHAPE.test(String(process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID))) {
    return { ...notAttempted, message: "conversion action id is not numeric" };
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { token, timedOut: oauthTimedOut } = await accessToken(timeoutMs);
  if (oauthTimedOut) return { ...notAttempted, message: "timed out" };
  if (!token) return { ...notAttempted, message: "oauth refresh failed" };

  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, "");

  const userIdentifiers = [
    ...(input.event.userData?.sha256_email_address
      ? [{ hashedEmail: input.event.userData.sha256_email_address }]
      : []),
    ...(input.event.userData?.sha256_phone_number
      ? [{ hashedPhoneNumber: input.event.userData.sha256_phone_number }]
      : []),
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ADS_API_BASE}/${customerId}:uploadClickConversions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversions: [
          {
            conversionAction: `customers/${customerId}/conversionActions/${GOOGLE_PURCHASE_CONVERSION_ACTION_ID}`,
            conversionDateTime: formatGoogleDateTime(input.occurredAt),
            conversionValue: input.event.params.value,
            currencyCode: input.event.params.currency,
            orderId: transactionId,
            ...(userIdentifiers.length > 0 ? { userIdentifiers } : {}),
          },
        ],
        partialFailure: true,
      }),
      signal: controller.signal,
    });

    return {
      attempted: true,
      delivered: response.ok,
      code: response.status,
      message: response.ok ? null : response.statusText,
    };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      code: null,
      message: isAbortError(error) ? "timed out" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Google wants `yyyy-MM-dd HH:mm:ss+|-HH:mm`, not ISO-8601. */
export function formatGoogleDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

/**
 * A fixed field set. No token, no customer id, no customer data — this is what
 * makes it safe to log.
 */
export function describeGoogleResult(result: GoogleSendResult): string {
  // Checked before attempted/delivered so a timeout on either leg reads the
  // same way regardless of how far the request got — distinct from both a
  // rejection (which carries an HTTP code) and a generic network error.
  if (result.message === "timed out") return "google: timed out";
  if (!result.attempted) return `google: not sent (${result.message ?? "not attempted"})`;
  if (result.delivered) return "google: delivered";
  return `google: rejected (${result.code ?? "no status"}${result.message ? ` ${result.message}` : ""})`;
}
