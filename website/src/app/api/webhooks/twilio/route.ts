import { NextResponse } from "next/server";

import { recordSystemAlert } from "@/lib/monitoring";
import { maskPhone } from "@/lib/sms/phone";
import { getSmsConfig } from "@/lib/sms/settings";
import {
  parseFormParams,
  signedUrlFor,
  verifyTwilioSignature,
} from "@/lib/sms/webhook-signature";
import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// POST /api/webhooks/twilio — delivery status callbacks.
//
// AUTHENTICITY
// ------------
// Twilio signs every callback with the account's auth token: HMAC-SHA1 over the
// request URL concatenated with the key-sorted POST parameters, base64, in
// `X-Twilio-Signature`. The arithmetic lives in sms/webhook-signature.ts,
// deliberately apart from this route, so all of it is unit-tested without
// constructing a request — see that file's header for why the URL is the part
// that goes wrong behind a proxy.
//
// STATUS CODE DISCIPLINE, and it matters because Twilio retries on non-2xx:
//
//   503  the auth token is not configured. We cannot verify ANYONE, so this is
//        our failure, not the caller's. Twilio retries and no delivery receipt
//        is lost to a half-finished deploy.
//   403  a signature was presented and did not match, or none was presented.
//        Twilio should not retry a forgery.
//   200  accepted — including a duplicate, an unknown SID and an unparseable
//        status. No number of retries changes any of those answers, and a
//        retry storm over an event we will never act on is its own outage.
//   500  ONLY a database failure, so the receipt is redelivered.
//
// WHAT THIS DOES NOT DO
// ---------------------
// Inbound messages (STOP / HELP / START) are NOT handled here. They arrive on
// a different Twilio webhook with a different payload, and conflating the two
// would put consent revocation — the highest-consequence path in the
// programme — behind the same parser as a delivery receipt. That handler
// arrives with M2.
//
// At M1 nothing sends, so nothing generates these callbacks. The route exists
// now so its signature handling is proven before it is load-bearing.
// ---------------------------------------------------------------------------

/** Twilio's terminal and intermediate message statuses. */
const TERMINAL_FAILURE = new Set(["failed", "undelivered"]);
const TERMINAL_SUCCESS = new Set(["delivered"]);

export async function POST(request: Request) {
  const config = await getSmsConfig();

  // Read the body ONCE, as text. The signature is computed over the parsed
  // parameters, and consuming the stream twice is not possible.
  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json({ error: "unreadable body" }, { status: 400 });
  }

  const params = parseFormParams(body);
  const url = signedUrlFor(config.statusCallbackUrl, request.url);
  const check = verifyTwilioSignature({
    authToken: config.authToken,
    url,
    params,
    signature: request.headers.get("x-twilio-signature"),
  });

  if (!check.valid) {
    if (check.reason === "not_configured") {
      // Ours to fix. Retryable.
      return NextResponse.json({ error: "not configured" }, { status: 503 });
    }
    // A forged or malformed callback is worth knowing about, but it is also
    // trivially easy for anyone who learns the URL to generate, so the alert is
    // a warning rather than a critical and carries no attacker-controlled text.
    await recordSystemAlert({
      type: "sms_webhook_signature_rejected",
      severity: "warning",
      message: `A Twilio webhook was rejected (${check.reason}).`,
      // Anyone who learns this URL can generate one, so repeats are collapsed
      // for an hour rather than paging the owner per request.
      dedupeWindowMs: 60 * 60 * 1000,
    }).catch(() => {});
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const sid = String(params.MessageSid ?? params.SmsSid ?? "").trim();
  const status = String(params.MessageStatus ?? params.SmsStatus ?? "").trim();
  const errorCode = String(params.ErrorCode ?? "").trim() || null;

  // A signed callback we cannot act on is still a signed callback. 200, so
  // Twilio stops, and no alert — an unrecognised status is a Twilio product
  // change, not an incident.
  if (!sid || !status) {
    return NextResponse.json({ ok: true, ignored: "no sid or status" });
  }

  try {
    // IDEMPOTENCY LIVES IN THE UNIQUE INDEX, not in a prior SELECT. Twilio
    // redelivers on any non-2xx, so the same (sid, status) pair arriving twice
    // is ordinary rather than anomalous, and a check-then-insert would race
    // with itself under concurrent redelivery.
    const { error: eventError } = await supabaseAdmin
      .from("sms_delivery_events")
      .upsert(
        { twilio_message_sid: sid, status, error_code: errorCode, raw: params },
        { onConflict: "twilio_message_sid,status", ignoreDuplicates: true },
      );
    if (eventError) throw eventError;

    // Stamp the ledger row. First-touch for each terminal state: a later
    // duplicate must not move a timestamp that is already set, which is the
    // same rule email's delivery events follow.
    const patch: Record<string, unknown> = { status };
    if (TERMINAL_SUCCESS.has(status)) patch.delivered_at = new Date().toISOString();
    if (TERMINAL_FAILURE.has(status)) {
      patch.failed_at = new Date().toISOString();
      patch.error_code = errorCode;
    }

    const { error: logError } = await supabaseAdmin
      .from("sms_send_log")
      .update(patch)
      .eq("twilio_message_sid", sid)
      // Never overwrite a terminal state with a late intermediate one.
      .is(TERMINAL_SUCCESS.has(status) ? "delivered_at" : "failed_at", null);
    if (logError) throw logError;

    // 30007 is carrier spam filtering. It is the signal that a programme is
    // being throttled by the carriers rather than failing technically, and it
    // is invisible unless something watches for it — Twilio reports the message
    // as sent.
    if (errorCode === "30007") {
      await recordSystemAlert({
        type: "sms_carrier_filtered",
        severity: "warning",
        message: `A message to ${maskPhone(String(params.To ?? ""))} was filtered as spam by the carrier (30007).`,
        context: { messageSid: sid },
        dedupeWindowMs: 60 * 60 * 1000,
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    // The ONE case that answers 5xx, so the receipt is redelivered rather than
    // lost to a transient database problem.
    await recordSystemAlert({
      type: "sms_webhook_write_failed",
      severity: "critical",
      message: "A Twilio delivery receipt could not be recorded.",
      context: { detail: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
    }).catch(() => {});
    return NextResponse.json({ error: "could not record" }, { status: 500 });
  }
}

/** Twilio only ever POSTs here. A GET is a misconfiguration worth saying so. */
export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
