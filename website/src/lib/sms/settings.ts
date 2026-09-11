import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// ---------------------------------------------------------------------------
// SMS runtime configuration and — the part that matters at M1 — the kill
// switches that keep every send path inert until A2P registration lands.
//
// THE PRECEDENT IS ALREADY IN THIS REPO. `PHONE_LOGIN_ENABLED = false` in
// account-auth-form.tsx hides a complete, working Supabase phone-OTP lane
// behind one constant "until the Twilio Trust Hub compliance profile is
// approved". This module is the same idea with an operator switch instead of a
// deploy: the whole pipeline is built, tested and observable, and the day
// approval arrives is a flag flip.
//
// TWO CAMPAIGNS, TWO NUMBERS, TWO SWITCHES. Twilio's STOP is scoped to
// (sender number, recipient), so a customer who opts out of marketing must not
// thereby lose their shipping notifications. That is only true if the two
// classes of message leave from different numbers, which in turn means they
// carry different A2P registrations that are approved at different times —
// transactional first, marketing weeks later. One switch could not express
// that state, so there are two.
//
// Shape follows email/settings.ts exactly: operator-editable control-store key
// layered over an env var, resolved once per read behind the snapshot cache.
// ---------------------------------------------------------------------------

export type SmsRuntimeConfig = {
  /** Master switch. OFF means nothing sends, of any kind, ever. */
  enabled: boolean;
  /** Transactional messages (order, shipping, delivery, payment failure, OTP). */
  transactionalEnabled: boolean;
  /** Marketing messages. Requires its own approved A2P campaign. */
  marketingEnabled: boolean;

  accountSid: string;
  authToken: string;
  /** Messaging Service for the transactional campaign. */
  transactionalMessagingServiceSid: string;
  /** Messaging Service for the marketing campaign. Separate on purpose. */
  marketingMessagingServiceSid: string;
  /** Twilio Verify service for phone-possession OTP. */
  verifyServiceSid: string;
  /** Public base URL Twilio posts status callbacks to. */
  statusCallbackUrl: string;

  /** Brand name in HELP replies and disclosures. */
  brandName: string;
  /** Support contact quoted in HELP replies. */
  helpContact: string;
  /** Frequency disclosed at opt-in, e.g. "4". Must match reality. */
  messagesPerMonth: string;
};

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const bool = (value: unknown): boolean => value === true || value === "true";

export async function getSmsConfig(): Promise<SmsRuntimeConfig> {
  const cfg = await getControlSnapshot("sms");
  return {
    enabled: bool(cfg.enabled),
    transactionalEnabled: bool(cfg.transactional_enabled),
    marketingEnabled: bool(cfg.marketing_enabled),

    accountSid: str(cfg.account_sid) || process.env.TWILIO_ACCOUNT_SID || "",
    authToken: str(cfg.auth_token) || process.env.TWILIO_AUTH_TOKEN || "",
    transactionalMessagingServiceSid:
      str(cfg.transactional_messaging_service_sid) || process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID || "",
    marketingMessagingServiceSid:
      str(cfg.marketing_messaging_service_sid) || process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID || "",
    verifyServiceSid: str(cfg.verify_service_sid) || process.env.TWILIO_VERIFY_SERVICE_SID || "",
    statusCallbackUrl: str(cfg.status_callback_url) || process.env.TWILIO_STATUS_CALLBACK_URL || "",

    brandName: str(cfg.brand_name) || "Vanta Labs",
    helpContact: str(cfg.help_contact) || "",
    messagesPerMonth: str(cfg.messages_per_month) || "4",
  };
}

/** The two classes of message. They have different consent, different numbers,
 *  different switches and different rules — never one enum value with a flag. */
export type SmsChannel = "transactional" | "marketing";

/**
 * Why this channel cannot send right now, or null when it can.
 *
 * MODELLED ON `marketingBlockedReason` (email/settings.ts), and for the same
 * reason: the automation sweep refuses to run at all when that returns
 * non-null, so "is sending allowed?" has one answer in one place rather than a
 * condition restated at each send site.
 *
 * FAILS CLOSED ON EVERY MISSING PIECE. An unconfigured credential is not a
 * degraded send, it is no send — and at M1 every one of these is unset, which
 * is exactly the state the tests assert.
 */
export function smsBlockedReason(config: SmsRuntimeConfig, channel: SmsChannel): string | null {
  if (!config.enabled) {
    return "SMS is turned off in Settings.";
  }
  if (channel === "transactional" && !config.transactionalEnabled) {
    return "Transactional SMS is turned off — the A2P campaign is not approved yet.";
  }
  if (channel === "marketing" && !config.marketingEnabled) {
    return "Marketing SMS is turned off — the A2P marketing campaign is not approved yet.";
  }
  if (!config.accountSid || !config.authToken) {
    return "Twilio credentials are not configured in Settings.";
  }
  const serviceSid = channel === "marketing"
    ? config.marketingMessagingServiceSid
    : config.transactionalMessagingServiceSid;
  if (!serviceSid) {
    return `No Twilio Messaging Service is configured for ${channel} SMS.`;
  }
  if (channel === "marketing" && !config.helpContact) {
    // HELP must return a real contact. A marketing programme that cannot answer
    // HELP is one a carrier can fault, and the reply is not optional.
    return "A support contact is required in Settings before marketing SMS can be sent.";
  }
  return null;
}

/** Convenience for the many call sites that only ask "can we send at all?". */
export async function smsSendingAllowed(channel: SmsChannel): Promise<boolean> {
  return smsBlockedReason(await getSmsConfig(), channel) === null;
}
