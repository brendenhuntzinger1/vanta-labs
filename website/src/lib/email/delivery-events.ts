import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * E-08 — THE BOUNCE/COMPLAINT LOOP.
 *
 * WHAT WAS MISSING. Suppression only ever grew from one direction: a person
 * clicking unsubscribe, or an account toggling marketing off. Nothing listened
 * to the provider. So an address that HARD BOUNCES stayed on every audience for
 * ever and was mailed again on the next campaign, the next automation and the
 * next cart-recovery sweep; and a recipient who hit "this is spam" — the single
 * most damaging signal a mailbox provider can send — was mailed again too,
 * because the complaint was recorded nowhere but the provider's dashboard.
 *
 * Repeatedly mailing dead addresses and people who complained is exactly what
 * drives a sending domain's reputation into the ground, and the first mail to
 * suffer is the mail customers actually need: receipts, password resets,
 * shipping notices.
 *
 * WHAT SUPPRESSION MEANS HERE. `email_suppressions` gates MARKETING only —
 * sendMarketingEmail consults it, sendEmail does not. That carve-out is
 * deliberate and stays: a bounced address should stop receiving campaigns
 * immediately, while a receipt for money already taken is still attempted (and
 * a hard bounce on one is visible through the alert below rather than silently
 * suppressed).
 *
 * THE PARSER IS PURE. Provider payloads differ, are attacker-reachable, and are
 * the part most likely to be wrong; keeping the shape-reading separate from the
 * writing is what lets every branch be tested without a database.
 */

/**
 * `delivered` and `delayed` suppress nothing — they exist so the webhook has
 * something to record on a healthy send. Without them the only provable state
 * was "something bounced", and a sender with no bounces was indistinguishable
 * from a webhook that was never configured. See email-delivery-event-log.sql.
 */
export type DeliveryEventKind =
  | "delivered"
  | "hard_bounce"
  | "soft_bounce"
  | "complaint"
  | "delayed"
  | "ignored";

export interface DeliveryEvent {
  email: string;
  kind: DeliveryEventKind;
  /** Provider's own message id, when it gives one — the join to their logs. */
  providerMessageId?: string;
  /** Verbatim provider event name, for the alert context. */
  rawType: string;
}

function firstEmail(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim().toLowerCase();
  return "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A Resend webhook body: one event, `{ type, data }`.
 *
 * Resend distinguishes bounce severity inside `data.bounce.type`. "Permanent"
 * (and the SES-flavoured "HardBounce") mean the address does not exist —
 * suppress. "Transient" is a full mailbox or a temporary defer, which will very
 * often deliver next time; suppressing on it would lose a real customer over a
 * weekend outage.
 */
function parseResend(body: Record<string, unknown>): DeliveryEvent[] {
  const type = str(body.type);
  if (!type.startsWith("email.")) return [];
  const data = (body.data ?? {}) as Record<string, unknown>;
  const email = firstEmail(data.to);
  if (!email) return [];
  const providerMessageId = str(data.email_id) || str(data.id) || undefined;

  if (type === "email.complained") {
    return [{ email, kind: "complaint", providerMessageId, rawType: type }];
  }
  if (type === "email.delivered") {
    return [{ email, kind: "delivered", providerMessageId, rawType: type }];
  }
  if (type === "email.delivery_delayed") {
    return [{ email, kind: "delayed", providerMessageId, rawType: type }];
  }
  if (type === "email.bounced") {
    const bounce = (data.bounce ?? {}) as Record<string, unknown>;
    const severity = str(bounce.type).toLowerCase();
    const permanent = severity === "" || severity.includes("permanent") || severity.includes("hard");
    return [{
      email,
      // An unlabelled bounce is treated as permanent: Resend's older payloads
      // carry no severity at all, and mailing a dead address for ever is the
      // worse of the two mistakes.
      kind: permanent ? "hard_bounce" : "soft_bounce",
      providerMessageId,
      rawType: `${type}:${severity || "unspecified"}`,
    }];
  }
  return [{ email, kind: "ignored", providerMessageId, rawType: type }];
}

/**
 * A SendGrid webhook body: an ARRAY of events.
 *
 * `event: "bounce"` with `type: "blocked"` is a temporary block by the
 * receiving server, not a dead address — soft. `"dropped"` means SendGrid
 * itself refused to send because the address is already on its own suppression
 * list, which is as permanent as it gets.
 */
function parseSendgrid(events: Array<Record<string, unknown>>): DeliveryEvent[] {
  const parsed: DeliveryEvent[] = [];
  for (const event of events) {
    const email = firstEmail(event.email);
    if (!email) continue;
    const name = str(event.event).toLowerCase();
    const providerMessageId = str(event.sg_message_id) || undefined;

    if (name === "delivered") {
      parsed.push({ email, kind: "delivered", providerMessageId, rawType: name });
    } else if (name === "deferred") {
      parsed.push({ email, kind: "delayed", providerMessageId, rawType: name });
    } else if (name === "spamreport") {
      parsed.push({ email, kind: "complaint", providerMessageId, rawType: name });
    } else if (name === "dropped") {
      parsed.push({ email, kind: "hard_bounce", providerMessageId, rawType: name });
    } else if (name === "bounce") {
      const soft = str(event.type).toLowerCase() === "blocked";
      parsed.push({
        email,
        kind: soft ? "soft_bounce" : "hard_bounce",
        providerMessageId,
        rawType: `bounce:${str(event.type) || "bounce"}`,
      });
    } else {
      parsed.push({ email, kind: "ignored", providerMessageId, rawType: name });
    }
  }
  return parsed;
}

/**
 * Read a provider webhook body into events, whichever provider sent it.
 *
 * Never throws: this is fed straight from an HTTP body. Anything unrecognised
 * yields no events, which the route answers 200 — a shape we do not understand
 * will not be understood on a retry either.
 */
export function parseDeliveryEvents(body: unknown): DeliveryEvent[] {
  try {
    if (Array.isArray(body)) {
      return parseSendgrid(body.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
    }
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (typeof record.type === "string" && record.type.startsWith("email.")) return parseResend(record);
      // A single SendGrid event posted unwrapped.
      if (typeof record.event === "string") return parseSendgrid([record]);
    }
  } catch {
    // Fall through — an unparseable body produces no events.
  }
  return [];
}

export interface DeliveryEventOutcome {
  suppressed: number;
  ignored: number;
  /** True when a write failed, so the route can ask the provider to retry. */
  writeFailed: boolean;
}

/**
 * Apply parsed events: suppress hard bounces and complaints, alert on both.
 *
 * Idempotent by construction — an upsert keyed on the email address. Providers
 * retry anything not answered 2xx, and a repeat delivery must not turn into a
 * second anything.
 */
/**
 * Is this the error a database that has not run the migration produces?
 *
 * Deliberately STRICTER than partner-portal's helper of the same name, which
 * also returns true for any error whose text merely mentions the relation.
 * That looseness would have hidden the defect this function's caller was built
 * to expose: the ON CONFLICT mismatch names `email_delivery_events` in its
 * message, so a substring test would have classified a broken index as a
 * missing table and stayed quiet. Only the two codes that actually mean "no
 * such relation" count.
 */
function isMissingRelationError(error: unknown, _relationName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "42P01" || code === "PGRST205";
}

/**
 * Write one webhook event to `email_delivery_events`.
 *
 * Idempotent at the database: `email_delivery_events_once` covers
 * (provider_message_id, event_type, recipient_email), so a provider redelivery
 * updates the existing row rather than inserting a second. That keeps "how many
 * times did this bounce?" honest — providers retry anything not answered 2xx.
 *
 * Swallows a missing table so a deployment that has not run
 * email-delivery-event-log.sql yet still suppresses bounces correctly. The
 * suppression is what protects the domain; this is only how we can see it.
 *
 * BEST-EFFORT, BUT NOT SILENT — and it was silent, which cost a round.
 *
 * The first version of the migration indexed
 * `coalesce(provider_message_id, '')` rather than the bare column, so this
 * upsert's ON CONFLICT could not be matched and every insert raised. The caller
 * catches, so Resend saw 200, bounces suppressed correctly, and the log stayed
 * empty — indistinguishable from "no events arrived", which is the exact
 * ambiguity this table exists to remove. It was found by sending real events
 * through production and comparing four Success rows in Resend against zero
 * rows here.
 *
 * So a failure is logged now. Still never thrown: a logging fault must not stop
 * a bounce being suppressed. But it must not be invisible either.
 */
async function recordDeliveryEvent(event: DeliveryEvent, suppressed: boolean): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_delivery_events")
    .upsert(
      {
        provider_message_id: event.providerMessageId ?? null,
        event_type: event.rawType,
        kind: event.kind,
        recipient_email: event.email || null,
        suppressed,
        received_at: new Date().toISOString(),
      },
      { onConflict: "provider_message_id,event_type,recipient_email" },
    );

  // A missing table is the one expected failure (a deployment that has not run
  // the migration). Anything else means the log is broken while the webhook
  // looks healthy, which is precisely the state that hid the ON CONFLICT
  // mismatch — so it goes to the server log. Never the payload: it carries
  // customer email addresses.
  if (error && !isMissingRelationError(error, "email_delivery_events")) {
    console.error(
      `[email] could not record a ${event.kind} delivery event: ${error.message ?? "unknown error"}`,
    );
  }
}

export async function applyDeliveryEvents(events: DeliveryEvent[]): Promise<DeliveryEventOutcome> {
  const outcome: DeliveryEventOutcome = { suppressed: 0, ignored: 0, writeFailed: false };

  for (const event of events) {
    // RECORD FIRST, ACT SECOND — and record EVERY event, including the ones
    // this function goes on to do nothing about.
    //
    // The audit could not answer "is the provider webhook actually configured?"
    // because a healthy sender and an unwired webhook produce the same empty
    // suppression table. A delivered/opened/clicked event writes a row here and
    // settles it. Best-effort by construction: a logging failure must never
    // stop a bounce being suppressed, which is the thing that protects the
    // sending domain.
    await recordDeliveryEvent(event, false).catch(() => {});

    if (event.kind !== "hard_bounce" && event.kind !== "complaint") {
      outcome.ignored += 1;
      continue;
    }
    const reason = event.kind === "complaint" ? "complained" : "bounced";
    try {
      const { error } = await supabaseAdmin
        .from("email_suppressions")
        // Keyed on the address, so a re-delivered webhook rewrites one row
        // rather than inserting a second. An address a person unsubscribed
        // from is not "upgraded" to bounced in any meaningful way — either way
        // they receive no marketing — so the last reason simply wins.
        .upsert(
          { email: event.email, reason, created_at: new Date().toISOString() },
          { onConflict: "email" },
        );
      if (error) {
        outcome.writeFailed = true;
        continue;
      }
      outcome.suppressed += 1;
      await recordDeliveryEvent(event, true).catch(() => {});
    } catch {
      outcome.writeFailed = true;
      continue;
    }

    // MAKE THE ACCOUNT PAGE TELL THE TRUTH.
    //
    // email_suppressions is the authoritative gate, but the Notifications tab
    // renders its checkbox from customer_preferences.marketing_emails — which a
    // provider suppression never touched. So a customer who pressed "report
    // spam" saw "Product news and promotions" still ticked, and pressing Save
    // on that panel posted marketingEmails: true and asked for the suppression
    // to be lifted. The preferences route now refuses to lift a provider
    // suppression; this stops the page inviting them to try.
    //
    // Best-effort, exactly like the unsubscribe route's identical mirror: the
    // suppression above already did the work that matters.
    try {
      const { data } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      const matchedUser = data?.users.find(
        (user) => user.email?.toLowerCase() === event.email.toLowerCase(),
      );
      if (matchedUser) {
        await supabaseAdmin
          .from("customer_preferences")
          .upsert(
            { user_id: matchedUser.id, marketing_emails: false, updated_at: new Date().toISOString() },
            { onConflict: "user_id" },
          );
      }
    } catch {
      // Non-fatal; the suppression is what actually gates the send.
    }

    // A complaint is the signal worth waking someone for: it damages the
    // sending domain that also carries receipts. A hard bounce is logged at
    // the lower severity — it is routine list hygiene.
    await recordSystemAlert({
      type: event.kind === "complaint" ? "email_complaint" : "email_hard_bounce",
      severity: event.kind === "complaint" ? "warning" : "info",
      message: event.kind === "complaint"
        ? `A recipient marked Vanta Labs email as spam. Suppressed from all marketing.`
        : `Email to a recipient hard-bounced. Address suppressed from marketing.`,
      // The address itself is the point of the alert — an operator cannot act
      // on "someone complained" — but the provider's id is carried too so the
      // event can be found in their dashboard.
      context: { email: event.email, event: event.rawType, providerMessageId: event.providerMessageId ?? null },
    }).catch(() => {});
  }

  return outcome;
}
