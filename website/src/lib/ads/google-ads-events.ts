import { GOOGLE_ADS_PURCHASE_LABEL, GOOGLE_ADS_TAG_ID } from "./google-ads-tag-id";
import { money, type PaidOrder } from "./tiktok-events";

/**
 * The Google Ads purchase conversion — the pure half.
 *
 * A deliberate mirror of meta-events.ts, and the rules that carry over are the
 * ones that matter:
 *
 * **Purchase is gated on the backend's paid state, never on a URL.** Reaching
 * the thank-you page proves navigation, not payment. `PaidOrder.isPaid` is read
 * from the order's own `payment_status` by
 * `/api/ads/purchase-event/[orderId]`, and nothing here can override it.
 *
 * **Never invent a number.** The value is `amount_paid` — the settled figure
 * the card statement shows — rounded to the cent, never a recomputed sum.
 *
 * **One sale, one conversion.** `transaction_id` is the order id, which is what
 * Google deduplicates on. Google's own install screen ships that field with an
 * empty string and a comment telling you to fill it in; left empty, every
 * reopened confirmation link is a fresh sale and the account's reported revenue
 * climbs on its own.
 *
 * WHY THERE IS NO SERVER-SIDE LEG HERE, unlike TikTok, Reddit and Meta.
 * Reporting a conversion to Google from the server means the Google Ads API —
 * OAuth, a developer token, a ClickConversion upload keyed on gclid — which is
 * a different integration with different credentials, not a second call
 * alongside these. The browser tag is the whole of what the conversion action
 * created in the console asks for. The consequence is the one the other
 * platforms' server legs exist to fix: a customer who never opens the
 * confirmation page reports nothing. That is a known gap, not an oversight.
 *
 * NO IDENTITY, AT ANY CONSENT STATE. Google's console offers Enhanced
 * Conversions on the same screen as this snippet, which asks for `user_data`
 * carrying a raw email address or phone number from the visitor's own browser.
 * Nothing here builds that field — the conversion is five keys and every one of
 * them is about the order, not the person — so handing Google an address is
 * impossible by accident rather than merely discouraged.
 */

export const GOOGLE_ADS_CURRENCY = "USD";

export type GoogleAdsConversion = {
  /** `AW-<account>/<label>` — the conversion action this is reported against. */
  sendTo: string;
  /** The settled amount, rounded to the cent. */
  value: number;
  currency: typeof GOOGLE_ADS_CURRENCY;
  /** Google's deduplication key. The order, never a random value. */
  transactionId: string;
  /** Storage key that makes this fire at most once per order in a browser. */
  dedupeKey: string;
};

/**
 * Both halves come from operator-settable env vars and end up inside a call
 * made on every purchaser's browser, so neither is trusted.
 *
 * A Google Ads tag id is always "AW-" and digits; a conversion label is the
 * base64url-shaped string the console issues. Anything else composes no
 * `send_to` at all and the conversion is not reported — which is the right
 * direction: Google answers a send_to it does not recognise by recording
 * nothing, so a malformed one is a conversion that looks sent and is not.
 */
const TAG_ID_SHAPE = /^AW-\d+$/;
const LABEL_SHAPE = /^[A-Za-z0-9_-]{6,}$/;

export function googleAdsSendTo(tagId: string, label: string): string | null {
  if (!TAG_ID_SHAPE.test(tagId)) return null;
  if (!LABEL_SHAPE.test(label)) return null;
  return `${tagId}/${label}`;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The conversion for a paid order, or null.
 *
 * `options.sendTo` exists so a caller can override the composed action — used
 * by the tests to assert the refusal path. Omitted, it is composed from the
 * account constants, which is the only thing production does.
 */
export function buildGoogleAdsPurchase(
  order: PaidOrder,
  options?: { sendTo?: string | null },
): GoogleAdsConversion | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;

  const value = money(order.amountPaid);
  if (!isPositive(value)) return null;

  const sendTo =
    options && "sendTo" in options
      ? options.sendTo
      : googleAdsSendTo(GOOGLE_ADS_TAG_ID, GOOGLE_ADS_PURCHASE_LABEL);
  if (!sendTo) return null;

  return {
    sendTo,
    value,
    currency: GOOGLE_ADS_CURRENCY,
    transactionId: order.orderId,
    dedupeKey: `google-ads-purchase:${order.orderId}`,
  };
}

/** `gtag('event', 'conversion', { … })`, as Google's install screen writes it. */
export type GoogleAdsEmitter = (
  command: "event",
  name: "conversion",
  params: Record<string, unknown>,
) => void;

/**
 * Send a conversion, honouring its dedupe key. Mirrors emitMetaEvent.
 *
 * The store is the same localStorage-backed one every other platform uses, so a
 * refresh, a back button or a reopened link produces nothing further even
 * before Google's own transaction_id dedup is reached. Two guards rather than
 * one because they fail in different places: the key is per-browser, the
 * transaction id is account-wide and permanent.
 */
export function emitGoogleAdsConversion(
  conversion: GoogleAdsConversion | null,
  emit: GoogleAdsEmitter,
  store: { has(key: string): boolean; mark(key: string): void },
): boolean {
  if (!conversion) return false;
  if (store.has(conversion.dedupeKey)) return false;

  emit("event", "conversion", {
    send_to: conversion.sendTo,
    value: conversion.value,
    currency: conversion.currency,
    transaction_id: conversion.transactionId,
  });
  store.mark(conversion.dedupeKey);
  return true;
}
