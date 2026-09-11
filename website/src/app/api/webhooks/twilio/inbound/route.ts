import { NextResponse } from "next/server";

import { recordSystemAlert } from "@/lib/monitoring";
import { applyConsentEvent, loadSubscriber, recordConsentEvent } from "@/lib/sms/consent";
import { classifyInbound, suppressesMarketing } from "@/lib/sms/keywords";
import { maskPhone, normalisePhone } from "@/lib/sms/phone";
import { getSmsConfig } from "@/lib/sms/settings";
import { suppressSms } from "@/lib/sms/suppression";
import {
  parseFormParams,
  signedUrlFor,
  verifyTwilioSignature,
} from "@/lib/sms/webhook-signature";

// ---------------------------------------------------------------------------
// POST /api/webhooks/twilio/inbound — messages FROM customers.
//
// SEPARATE FROM THE STATUS CALLBACK ON PURPOSE. That route records delivery
// receipts; this one carries consent revocation, which is the
// highest-consequence path in the programme. Putting them behind one parser
// would mean a change to delivery-receipt handling could break STOP, and the
// two have nothing in common but their signature scheme.
//
// THE RULE THAT OUTRANKS EVERY OTHER RULE IN THIS FILE: if the message says
// stop, the suppression is written, even if everything else fails. Not the
// reply, not the audit row, not the subscriber update — the suppression. It is
// attempted first and its failure is the only thing here that answers 5xx, so
// Twilio retries until it lands.
//
// At M1/M2 nothing sends, so nothing can be replied to. The classification and
// suppression still run, which is the point: the day a number goes live, STOP
// already works.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const config = await getSmsConfig();

  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json({ error: "unreadable body" }, { status: 400 });
  }

  const params = parseFormParams(body);
  const check = verifyTwilioSignature({
    authToken: config.authToken,
    url: signedUrlFor(config.statusCallbackUrl, request.url),
    params,
    signature: request.headers.get("x-twilio-signature"),
  });

  if (!check.valid) {
    if (check.reason === "not_configured") {
      return NextResponse.json({ error: "not configured" }, { status: 503 });
    }
    await recordSystemAlert({
      type: "sms_inbound_signature_rejected",
      severity: "warning",
      message: `An inbound SMS webhook was rejected (${check.reason}).`,
      dedupeWindowMs: 60 * 60 * 1000,
    }).catch(() => {});
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const normalised = normalisePhone(String(params.From ?? ""));
  const messageBody = String(params.Body ?? "");
  const messageSid = String(params.MessageSid ?? params.SmsSid ?? "").trim() || null;

  if (!normalised.ok) {
    // A sender we cannot normalise. 200 — retrying will not make the number
    // parseable — but recorded, because an inbound message from an unparseable
    // number is worth an operator's attention rather than a silent drop.
    await recordSystemAlert({
      type: "sms_inbound_unparseable_sender",
      severity: "warning",
      message: `An inbound SMS came from a number that could not be normalised (${normalised.reason}).`,
      dedupeWindowMs: 60 * 60 * 1000,
    }).catch(() => {});
    return NextResponse.json({ ok: true, ignored: "unparseable sender" });
  }
  const phoneE164 = normalised.e164;

  // The subscriber is read only to disambiguate YES. A read failure must NOT
  // stop an opt-out, so it degrades to "no confirmation pending" rather than
  // aborting — the worst case is a confirmation read as a resubscribe, which
  // the state machine then refuses harmlessly.
  const loaded = await loadSubscriber(phoneE164);
  const confirmationPending = loaded.ok
    && loaded.state !== null
    && loaded.state.marketingConsent
    && !loaded.state.doubleOptinConfirmedAt;

  const classification = classifyInbound(messageBody, { confirmationPending });

  // ---- THE SUPPRESSION PATH. FIRST, AND ALLOWED TO FAIL NOTHING ELSE. ----
  if (suppressesMarketing(classification)) {
    const suppressed = await suppressSms({
      phoneE164,
      scope: "marketing",
      reason: classification.intent === "stop"
        ? `stop_keyword:${classification.keyword ?? "stop"}`
        : "free_text_revocation",
      needsReview: classification.needsReview,
    });

    if (!suppressed.ok) {
      // The one 5xx in this file. Twilio retries, and it must: an unhonoured
      // opt-out is the most expensive failure this system can have.
      await recordSystemAlert({
        type: "sms_suppression_write_failed",
        severity: "critical",
        message: `Could not suppress ${maskPhone(phoneE164)} after an opt-out. Twilio will retry.`,
        context: { detail: suppressed.error },
      }).catch(() => {});
      return NextResponse.json({ error: "could not suppress" }, { status: 500 });
    }

    // Best-effort from here. The suppression is what stops the messages; the
    // rows below explain it.
    await applyConsentEvent({
      phoneE164,
      event: "marketing_revoked",
      eventName: "marketing_revoked",
      twilioMessageSid: messageSid,
    }).catch(() => undefined);

    if (classification.needsReview) {
      // Free text was read as revocation by a regex. Honoured automatically
      // because the FCC requires any-reasonable-means revocation, and flagged
      // because a regex is not a reader.
      await recordSystemAlert({
        type: "sms_free_text_revocation",
        severity: "warning",
        message: `${maskPhone(phoneE164)} was suppressed on free text rather than an exact keyword. Worth a human read.`,
        dedupeWindowMs: 15 * 60 * 1000,
      }).catch(() => {});
    }

    // The single permitted confirmation would be sent here. Nothing sends at
    // M2, and that is correct: the suppression is recorded either way.
    return NextResponse.json({ ok: true, intent: classification.intent, suppressed: true });
  }

  // ---- EVERYTHING ELSE. Recorded; replies wait for a live number. ----
  switch (classification.intent) {
    case "confirm":
      await applyConsentEvent({
        phoneE164,
        event: "double_optin_confirmed",
        eventName: "double_optin_confirmed",
        twilioMessageSid: messageSid,
      }).catch(() => undefined);
      break;

    case "start":
      // Subject to the 30-day cooldown and a fresh consent — `transition`
      // refuses it otherwise, and the refusal is the correct outcome rather
      // than an error.
      await applyConsentEvent({
        phoneE164,
        event: "resubscribed",
        eventName: "resubscribed",
        twilioMessageSid: messageSid,
      }).catch(() => undefined);
      break;

    case "help":
      // HELP must be answerable even for a suppressed number. The reply is
      // sent once a number is live; the request is recorded now.
      await recordConsentEvent({
        phoneE164,
        event: "disclosure_shown",
        twilioMessageSid: messageSid,
        detail: { inbound: "help" },
      }).catch(() => undefined);
      break;

    case "unknown":
      if (classification.needsReview) {
        await recordSystemAlert({
          type: "sms_inbound_needs_review",
          severity: "info",
          message: `${maskPhone(phoneE164)} sent an inbound message that may need a human reply.`,
          dedupeWindowMs: 15 * 60 * 1000,
        }).catch(() => {});
      }
      break;
  }

  return NextResponse.json({ ok: true, intent: classification.intent });
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
