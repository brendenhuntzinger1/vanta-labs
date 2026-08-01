import "server-only";

import { getRequestIpAddress, getRequestUserAgent } from "@/lib/admin-auth";
import { getRequiredEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase-server";
import type { QuoteDisplayLineItem } from "@/lib/quote-order";

// -------------------------------------------------------------------------
// Server-side helpers shared by the four express (Apple Pay) endpoints:
// session create, the wallet shipping callback, the shipping-rates proxy, and
// authorize. Everything here is about ONE thing: making the amount the wallet
// sheet displayed provably the amount that gets charged.
//
// The pure parts of that argument — the address fingerprint, the shipping
// method id bound to it, the cardholder-name recovery, the constant-time secret
// compare — live in express-wallet.ts so they can be unit-tested directly.
// -------------------------------------------------------------------------

export * from "@/lib/express-wallet";

/**
 * The shopper's IP/UA, taken from THIS request's own headers.
 *
 * Never from a request body field: a client-supplied IP is spoofable, and this
 * value is forwarded to the processor where it feeds velocity rules, the IP
 * blacklist and the decline-velocity card-testing lock. Sending our own egress
 * IP instead is just as bad the other way — it would arm those rules against
 * our own infrastructure, blinding the risk engine to every real shopper.
 */
export function resolveShopperIdentity(request: Request): { ip: string | null; userAgent: string | null } {
  return { ip: getRequestIpAddress(request), userAgent: getRequestUserAgent(request) };
}

export function veyraApiBase(): string {
  return getRequiredEnv("VEYRA_API_BASE").replace(/\/+$/, "");
}

export function veyraSecretKey(): string {
  return getRequiredEnv("VEYRA_SECRET_KEY");
}

/**
 * Shared secret the processor echoes back on every wallet shipping callback (as
 * `x-vercel-protection-bypass`). It is the ONLY thing authenticating that
 * callback, so it is set unconditionally at session create and required here.
 */
export function shippingCallbackToken(): string {
  return getRequiredEnv("VEYRA_SHIPPING_CALLBACK_TOKEN");
}

export interface ExpressIntentItem {
  id: string;
  quantity: number;
}

export interface ExpressIntentRow {
  id: string;
  order_id: string;
  order_number: string;
  veyra_session_id: string | null;
  customer_user_id: string | null;
  /** Empty for a guest — Apple withholds the email until authorization. */
  customer_email: string | null;
  items: ExpressIntentItem[];
  referral_code: string | null;
  coupon_code: string | null;
  points_to_redeem: number;
  shipping_protection: boolean;
  store_credit_cents: number;
  amount_cents: number;
  currency: string;
  compliance_ack: Record<string, unknown>;
  compliance_acked_at: string | null;
  compliance_copy_version: string | null;
  client_ip: string | null;
  user_agent: string | null;
  status: string;
  outcome: Record<string, unknown> | null;
  consumed_at: string | null;
  created_at: string;
  expires_at: string;
}

const INTENT_COLUMNS =
  "id, order_id, order_number, veyra_session_id, customer_user_id, customer_email, items, referral_code, coupon_code, points_to_redeem, shipping_protection, store_credit_cents, amount_cents, currency, compliance_ack, compliance_acked_at, compliance_copy_version, client_ip, user_agent, status, outcome, consumed_at, created_at, expires_at";

export async function loadIntentBySession(sessionId: string): Promise<ExpressIntentRow | null> {
  const { data, error } = await supabaseAdmin
    .from("express_checkout_intents")
    .select(INTENT_COLUMNS)
    .eq("veyra_session_id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ExpressIntentRow;
}

/**
 * The single-charge claim.
 *
 * Flips consumed_at NULL -> now() exactly once. It runs immediately before the
 * order write and the charge, NOT at validation time: every refusal upstream of
 * it must leave the intent retryable, or a shopper whose first tap failed
 * validation could never try again on the same armed sheet. Zero rows returned
 * means a concurrent authorize won the race — the caller replays that attempt's
 * recorded outcome instead of charging a second time.
 */
export async function claimIntent(sessionId: string): Promise<ExpressIntentRow | null> {
  const { data, error } = await supabaseAdmin
    .from("express_checkout_intents")
    .update({ consumed_at: new Date().toISOString(), status: "consumed" })
    .eq("veyra_session_id", sessionId)
    .is("consumed_at", null)
    .select(INTENT_COLUMNS);
  if (error || !data || data.length === 0) return null;
  return data[0] as unknown as ExpressIntentRow;
}

/** Persist the terminal result so a duplicate authorize can replay it. */
export async function recordIntentOutcome(
  sessionId: string,
  outcome: Record<string, unknown>,
  status: "consumed" | "failed",
): Promise<void> {
  await supabaseAdmin
    .from("express_checkout_intents")
    .update({ outcome, status })
    .eq("veyra_session_id", sessionId);
}

export interface ExpressShippingQuoteRow {
  veyra_session_id: string;
  address_fingerprint: string;
  contact: Record<string, unknown>;
  shipping_methods: Array<{ id: string; label: string; detail?: string; amount_cents: number }>;
  tax_amount_cents: number;
  shipping_amount_cents: number;
  computed_at: string;
}

/**
 * The quote for a session AND a specific address, newest first.
 *
 * Deliberately NOT "latest row wins": authorization recomputes the fingerprint
 * from the address actually being charged and looks up by it, so a quote
 * computed for a different address can never be spent on this one.
 */
export async function loadShippingQuote(
  sessionId: string,
  fingerprint: string,
): Promise<ExpressShippingQuoteRow | null> {
  const { data, error } = await supabaseAdmin
    .from("express_shipping_quotes")
    .select("veyra_session_id, address_fingerprint, contact, shipping_methods, tax_amount_cents, shipping_amount_cents, computed_at")
    .eq("veyra_session_id", sessionId)
    .eq("address_fingerprint", fingerprint)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ExpressShippingQuoteRow;
}

/** The wallet sheet's opening rows, plus the pending shipping/tax placeholders. */
export interface ExpressSessionPayload {
  available: true;
  sessionId: string;
  amountCents: number;
  orderNumber: string;
  lineItems: QuoteDisplayLineItem[];
}

export interface ExpressUnavailablePayload {
  available: false;
  reason: string;
}
