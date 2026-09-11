import "server-only";

import { maskPhone } from "@/lib/sms/phone";

// ---------------------------------------------------------------------------
// The Twilio REST client. Every Twilio call in this codebase goes through here,
// for the three reasons the Shippo client states and one more that is specific
// to messaging:
//
//   1. NOTHING THROWS. Typed results, always.
//   2. EVERY FAILURE SAYS WHETHER IT IS SAFE TO RETRY. For messaging this is
//      sharper than for a label: a timeout on a send is NOT safe to retry. The
//      message may have gone out, and a duplicate marketing text is both a
//      complaint and a carrier-filtering risk. Only failures where we KNOW
//      Twilio did nothing are retryable.
//   3. THE TOKEN NEVER LEAVES. Read once, put straight into a header, and any
//      text returned or logged is redacted first — including phone numbers,
//      which are PII and go through maskPhone().
//
// NO SDK, matching Shippo, Resend and the payment processor. Three endpoints,
// form-encoded bodies, and a pinned understanding of the wire format is
// smaller than the SDK's surface — and the SDK would pull in its own HTTP
// stack, which is where the timeout guarantee would quietly stop applying.
// ---------------------------------------------------------------------------

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_VERIFY_BASE = "https://verify.twilio.com/v2";
const TWILIO_LOOKUP_BASE = "https://lookups.twilio.com/v2";

/**
 * A send is a foreground-ish action inside a 15-minute cron tick, and Twilio
 * normally answers in well under a second. 10s is far past normal while still
 * leaving the tick's watchdog (50s, cron-runner.ts) room for the rest of its
 * work.
 */
export const TWILIO_REQUEST_TIMEOUT_MS = 10_000;

/** Enough provider detail to diagnose, short enough to log. */
const MAX_DETAIL_CHARS = 300;

export type TwilioErrorKind =
  /** No credentials — nothing was sent. Safe to retry once configured. */
  | "not_configured"
  /** Abandoned at the timeout. OUTCOME UNKNOWN — never retry a send on this. */
  | "timeout"
  /** DNS/TLS/socket failure. Outcome unknown. */
  | "network"
  /** Twilio refused it: bad number, unsubscribed recipient, bad token (4xx). */
  | "rejected"
  /** Twilio is having a bad day (5xx). The request may still have landed. */
  | "server_error"
  /** 2xx we could not parse. */
  | "unexpected";

export type TwilioFailure = {
  ok: false;
  kind: TwilioErrorKind;
  /** Twilio's numeric error code when it sent one — 21610, 30007, 30034… */
  code: string | null;
  /** Redacted, truncated provider detail. Safe to log. */
  detail: string;
  /**
   * True ONLY when we know Twilio did nothing. A timeout, a network drop and a
   * 5xx are all false: the message may have been accepted and retrying would
   * send it twice.
   */
  safeToRetry: boolean;
};

export type TwilioSendResult =
  | { ok: true; sid: string; status: string; segments: number | null; priceCents: number | null }
  | TwilioFailure;

export type TwilioVerifyStartResult =
  | { ok: true; sid: string; status: string }
  | TwilioFailure;

export type TwilioVerifyCheckResult =
  | { ok: true; approved: boolean; status: string }
  | TwilioFailure;

export type TwilioLookupResult =
  | { ok: true; valid: boolean; lineType: string | null; carrier: string | null }
  | TwilioFailure;

/** Strip anything that must never reach a log line. */
function redact(text: string): string {
  return text
    // Any E.164-ish run of digits becomes a masked number.
    .replace(/\+?1?\d{10,11}/g, (match) => maskPhone(match))
    // Account SIDs and auth tokens are 32 hex/alnum characters.
    .replace(/\b(AC|SK)[0-9a-fA-F]{32}\b/g, "$1••••")
    .slice(0, MAX_DETAIL_CHARS);
}

type Credentials = { accountSid: string; authToken: string };

function authHeader({ accountSid, authToken }: Credentials): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

/**
 * One request, one place where every failure mode is classified.
 *
 * `safeToRetry` is decided here and nowhere else, because it is the field
 * callers make irreversible decisions on and a second opinion about it is how
 * a duplicate send happens.
 */
async function twilioRequest(
  credentials: Credentials,
  url: string,
  body: Record<string, string> | null,
): Promise<{ ok: true; json: unknown } | TwilioFailure> {
  if (!credentials.accountSid || !credentials.authToken) {
    return { ok: false, kind: "not_configured", code: null, detail: "Twilio credentials are not configured.", safeToRetry: true };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: authHeader(credentials),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body ? new URLSearchParams(body).toString() : undefined,
      signal: AbortSignal.timeout(TWILIO_REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const isTimeout = error instanceof Error
      && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      kind: isTimeout ? "timeout" : "network",
      code: null,
      detail: redact(error instanceof Error ? error.message : String(error)),
      // NEITHER IS SAFE. The request may have reached Twilio and been accepted.
      safeToRetry: false,
    };
  }

  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const payload = (json ?? {}) as { code?: unknown; message?: unknown };
    const code = payload.code != null ? String(payload.code) : null;
    const message = typeof payload.message === "string" ? payload.message : text;
    return {
      ok: false,
      kind: response.status >= 500 ? "server_error" : "rejected",
      code,
      detail: redact(message || `HTTP ${response.status}`),
      // A 4xx means Twilio declined and did nothing, so retrying the same
      // request is pointless but harmless. A 5xx may have landed.
      safeToRetry: false,
    };
  }

  if (json == null) {
    return { ok: false, kind: "unexpected", code: null, detail: redact(text || "empty response"), safeToRetry: false };
  }
  return { ok: true, json };
}

/**
 * Send one message through a Messaging Service.
 *
 * THE MESSAGING SERVICE, NOT A FROM NUMBER. The service is what carries the
 * approved A2P campaign registration, and the campaign is what the carriers
 * check. Sending from a bare number bypasses the registration and gets the
 * traffic blocked (error 30034) while still being billed.
 */
export async function sendTwilioMessage(input: {
  credentials: Credentials;
  messagingServiceSid: string;
  to: string;
  body: string;
  statusCallback?: string;
}): Promise<TwilioSendResult> {
  const form: Record<string, string> = {
    MessagingServiceSid: input.messagingServiceSid,
    To: input.to,
    Body: input.body,
  };
  if (input.statusCallback) form.StatusCallback = input.statusCallback;

  const result = await twilioRequest(
    input.credentials,
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(input.credentials.accountSid)}/Messages.json`,
    form,
  );
  if (!result.ok) return result;

  const payload = result.json as {
    sid?: unknown; status?: unknown; num_segments?: unknown; price?: unknown;
  };
  const sid = typeof payload.sid === "string" ? payload.sid : "";
  if (!sid) {
    return { ok: false, kind: "unexpected", code: null, detail: "Twilio accepted the message but returned no SID.", safeToRetry: false };
  }

  const segments = Number(payload.num_segments);
  // Twilio returns price as a NEGATIVE string ("-0.00830") because it is a
  // debit, and only once the message is priced — it is usually null on the
  // initial response and arrives with the status callback.
  const price = payload.price != null ? Math.abs(Number(payload.price)) : NaN;

  return {
    ok: true,
    sid,
    status: typeof payload.status === "string" ? payload.status : "queued",
    segments: Number.isFinite(segments) && segments > 0 ? segments : null,
    priceCents: Number.isFinite(price) ? Math.round(price * 100) : null,
  };
}

/** Start a Verify OTP. Proves possession of the number; grants no consent. */
export async function startTwilioVerification(input: {
  credentials: Credentials;
  verifyServiceSid: string;
  to: string;
}): Promise<TwilioVerifyStartResult> {
  const result = await twilioRequest(
    input.credentials,
    `${TWILIO_VERIFY_BASE}/Services/${encodeURIComponent(input.verifyServiceSid)}/Verifications`,
    { To: input.to, Channel: "sms" },
  );
  if (!result.ok) return result;
  const payload = result.json as { sid?: unknown; status?: unknown };
  return {
    ok: true,
    sid: typeof payload.sid === "string" ? payload.sid : "",
    status: typeof payload.status === "string" ? payload.status : "pending",
  };
}

/**
 * Check an OTP.
 *
 * `approved` is the ONLY thing a caller may act on. Twilio returns 404 once a
 * verification is consumed or expired, which `twilioRequest` classifies as
 * `rejected` — so a replayed code is a failure rather than a second approval.
 */
export async function checkTwilioVerification(input: {
  credentials: Credentials;
  verifyServiceSid: string;
  to: string;
  code: string;
}): Promise<TwilioVerifyCheckResult> {
  const result = await twilioRequest(
    input.credentials,
    `${TWILIO_VERIFY_BASE}/Services/${encodeURIComponent(input.verifyServiceSid)}/VerificationCheck`,
    { To: input.to, Code: input.code },
  );
  if (!result.ok) return result;
  const payload = result.json as { status?: unknown; valid?: unknown };
  const status = typeof payload.status === "string" ? payload.status : "";
  return { ok: true, approved: payload.valid === true && status === "approved", status };
}

/**
 * Look up line type and carrier.
 *
 * Used to refuse VOIP at signup — the cheap end of verification abuse and gift
 * farming. A FAILED LOOKUP MUST NOT BLOCK A REAL CUSTOMER: the caller treats
 * an unavailable answer as "allowed" (see `isRefusedLineType`, which answers
 * false for null), because Twilio being down is not the shopper's fault.
 */
export async function lookupTwilioNumber(input: {
  credentials: Credentials;
  phone: string;
}): Promise<TwilioLookupResult> {
  const result = await twilioRequest(
    input.credentials,
    `${TWILIO_LOOKUP_BASE}/PhoneNumbers/${encodeURIComponent(input.phone)}?Fields=line_type_intelligence`,
    null,
  );
  if (!result.ok) return result;
  const payload = result.json as {
    valid?: unknown;
    line_type_intelligence?: { type?: unknown; carrier_name?: unknown } | null;
  };
  const lti = payload.line_type_intelligence ?? null;
  return {
    ok: true,
    valid: payload.valid === true,
    lineType: lti && typeof lti.type === "string" ? lti.type : null,
    carrier: lti && typeof lti.carrier_name === "string" ? lti.carrier_name : null,
  };
}
