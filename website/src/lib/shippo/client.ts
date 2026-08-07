import "server-only";

import { ShippoNotConfiguredError, requireShippoToken } from "@/lib/shippo/config";
import type {
  ShippoOrder,
  ShippoOrderInput,
  ShippoAddress,
  ShippoLabelFileType,
  ShippoParcel,
  ShippoRate,
  ShippoRefund,
  ShippoRefundStatus,
  ShippoShipment,
  ShippoTransaction,
} from "@/lib/shippo/types";

// -------------------------------------------------------------------------
// The Shippo REST client. Every call to Shippo in this codebase goes through
// here, for three reasons that all cost money when they are violated:
//
//   1. NOTHING THROWS. A raw `fetch failed` escaping into an admin route is a
//      500 with a stack trace where an admin needed "Shippo didn't answer, try
//      again". Every expected failure is a typed result instead.
//   2. EVERY FAILURE SAYS WHETHER IT IS SAFE TO RETRY. This is the whole
//      exactly-once story for label purchase: a caller holding the
//      `label_purchase_claimed_at` claim may only release it — and thus allow a
//      second purchase attempt — when we KNOW Shippo did nothing. A timeout is
//      not that; the label may have printed and be waiting in the dashboard.
//   3. THE TOKEN NEVER LEAVES. It is read once per request, put straight into a
//      header, and any text we return or log is run through redact() first.
//
// There is no SDK dependency on purpose: four endpoints, plain JSON, and a
// pinned understanding of the wire format is smaller than the SDK's surface.
// -------------------------------------------------------------------------

const SHIPPO_API_BASE = "https://api.goshippo.com";

/**
 * A hung connection must not hold an admin request open forever, and a label
 * purchase is a foreground action someone is waiting on. 15s is well past
 * Shippo's normal response time for a synchronous transaction while still
 * failing fast enough to show a usable error.
 */
export const SHIPPO_REQUEST_TIMEOUT_MS = 15_000;

/** How much provider detail we keep. Enough to diagnose, short enough to log. */
const MAX_DETAIL_CHARS = 300;

export type ShippoErrorKind =
  /** No SHIPPO_API_TOKEN in the environment — nothing was sent. */
  | "not_configured"
  /** The request was abandoned at SHIPPO_REQUEST_TIMEOUT_MS. Outcome unknown. */
  | "timeout"
  /** DNS/TLS/socket failure. Outcome unknown. */
  | "network"
  /** Shippo refused the request (bad address, unknown rate, bad token, 4xx). */
  | "rejected"
  /** Shippo is having a bad day (5xx). The request may still have landed. */
  | "server_error"
  /** 2xx we could not make sense of. */
  | "invalid_response"
  /** The shipment was created but Shippo quoted nothing for it. */
  | "no_rates"
  /** Shippo explicitly reported the label purchase as failed. No postage bought. */
  | "purchase_failed"
  /** The transaction is still processing. A label may yet appear — do NOT retry. */
  | "purchase_pending"
  /** The rate carries no usable price, so postage could not be recorded. */
  | "missing_cost";

export interface ShippoFailure {
  ok: false;
  kind: ShippoErrorKind;
  /** One sentence, safe to show an admin. Never contains the API token. */
  message: string;
  /** HTTP status, when the failure came from a response. */
  status?: number;
  /** Provider diagnostics — truncated and token-redacted. */
  detail?: string;
  /**
   * TRUE only when Shippo demonstrably did nothing.
   *
   * A caller holding an exactly-once claim (label_purchase_claimed_at) may
   * release it ONLY on `safeToRetry: true`. On false the request may have taken
   * effect at Shippo, and releasing the claim is how an order ends up paying for
   * two labels — recover with getTransaction() or the Shippo dashboard instead.
   */
  safeToRetry: boolean;
  /**
   * Set whenever a transaction exists at Shippo despite the failure, so the
   * caller can poll it or void it rather than buying again.
   */
  transactionId?: string;
}

export type ShippoResult<T> = { ok: true; data: T } | ShippoFailure;

// ---------------------------------------------------------------- money ----

/**
 * "5.20" -> 520. The ONLY sanctioned way to turn a Shippo amount into cents.
 *
 * Shippo sends money as a decimal string and the obvious `Math.round(Number(a) *
 * 100)` is wrong often enough to matter: `Number("1.15") * 100` is
 * 114.99999999999999. Round() would save that one, but `Math.trunc` or a `| 0`
 * anywhere downstream records 114 — a cent lost per label, silently, forever.
 * So the string is split on the decimal point and the two halves are combined
 * with integer arithmetic; no float is ever multiplied.
 *
 * Returns null — never 0 — for anything unusable. A zero cost is a real value
 * ("free") and must not be how "we couldn't read it" is expressed, because the
 * caller's decision differs completely: an unreadable amount means the purchase
 * must not be treated as successful.
 */
export function parseAmountToCents(amount: string | number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;

  // A JS number gets stringified first rather than multiplied — Number#toString
  // gives the shortest exact decimal representation, so 5.2 becomes "5.2" and
  // the same integer path handles it.
  const raw = (typeof amount === "number" ? (Number.isFinite(amount) ? String(amount) : "") : String(amount)).trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!match) return null;

  const whole = Number(match[1]);
  if (!Number.isSafeInteger(whole)) return null;

  const fraction = match[2] ?? "";
  const cents = Number((fraction + "00").slice(0, 2));
  // Shippo quotes two decimals, but a third digit must round rather than be
  // dropped: "5.999" is 6.00 of real postage, not 5.99.
  const roundUp = fraction.length > 2 && Number(fraction[2]) >= 5 ? 1 : 0;

  const total = whole * 100 + cents + roundUp;
  return Number.isSafeInteger(total) ? total : null;
}

// ------------------------------------------------------------- internals ----

/**
 * Belt-and-braces scrub before any provider text is returned or logged.
 *
 * Shippo does not echo the Authorization header today, but "today" is not a
 * guarantee worth a leaked postage-buying credential in a log aggregator.
 */
function redact(text: string, token: string): string {
  const withoutToken = token ? text.split(token).join("[redacted]") : text;
  return withoutToken.replace(/ShippoToken\s+\S+/gi, "ShippoToken [redacted]");
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

function parseJson(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Pull human-readable strings out of a Shippo error body. Its error shapes are
 * inconsistent — `{"detail":"…"}`, `{"__all__":["…"]}`, and per-field maps like
 * `{"address_to":{"zip":["Enter a valid ZIP"]}}` all occur — so this walks the
 * structure instead of guessing one shape.
 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 4 || depth > 4) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, out, depth + 1);
    }
  }
}

function describeBody(parsed: unknown, raw: string): string {
  const found: string[] = [];
  collectStrings(parsed, found);
  return found.length > 0 ? found.join("; ") : raw;
}

/** Diagnostics attached to a shipment or transaction, as one line. */
function describeMessages(messages: ShippoTransaction["messages"] | ShippoShipment["messages"]): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const texts = messages
    .map((message) => [message?.code, message?.text].filter(Boolean).join(": "))
    .filter((text) => text.length > 0);
  return texts.length > 0 ? truncate(texts.join("; ")) : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A 4xx means Shippo validated the request and refused it, so nothing was
 * created and a corrected retry is safe. A 5xx (or a 408) may have been applied
 * before the failure and is NOT safe to retry blindly.
 */
function isSafeToRetryStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

function messageForStatus(status: number): string {
  if (status === 401 || status === 403) return "Shippo rejected the API token.";
  if (status === 404) return "Shippo could not find that record.";
  if (status === 429) return "Shippo is rate-limiting this account. Try again shortly.";
  if (status >= 500) return "Shippo is unavailable right now.";
  return "Shippo rejected the request.";
}

interface ShippoRequestInit {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

/**
 * The one place a Shippo HTTP call happens.
 *
 * Returns the decoded 2xx body cast to T without validating it — each caller
 * checks the specific fields it depends on, because "what makes this response
 * usable" differs per endpoint (a transaction needs a label_url; a shipment
 * needs rates).
 */
async function shippoRequest<T>(request: ShippoRequestInit): Promise<ShippoResult<T>> {
  let token: string;
  try {
    token = requireShippoToken();
  } catch (error) {
    return {
      ok: false,
      kind: "not_configured",
      message:
        error instanceof ShippoNotConfiguredError
          ? error.message
          : "Shippo is not configured. Set SHIPPO_API_TOKEN in the server environment.",
      safeToRetry: true,
    };
  }

  let response: Response;
  let rawBody: string;
  try {
    response = await fetch(`${SHIPPO_API_BASE}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `ShippoToken ${token}`,
        "Content-Type": "application/json",
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      // Next.js extends fetch with its own persistent cache and memoises GETs
      // inside a render pass. A cached /transactions/<id> would keep reporting a
      // label as QUEUED long after it printed, so every call opts out explicitly
      // rather than relying on the current default.
      cache: "no-store",
      signal: AbortSignal.timeout(SHIPPO_REQUEST_TIMEOUT_MS),
    });
    rawBody = await response.text();
  } catch (error) {
    // AbortSignal.timeout() rejects with a TimeoutError; an externally aborted
    // request surfaces as AbortError. Anything else is a transport failure.
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.error("Shippo request did not complete", {
      path: request.path,
      reason: timedOut ? "timeout" : "network",
    });
    return {
      ok: false,
      kind: timedOut ? "timeout" : "network",
      message: timedOut
        ? `Shippo did not respond within ${Math.round(SHIPPO_REQUEST_TIMEOUT_MS / 1000)} seconds.`
        : "Could not reach Shippo.",
      // The request may have been fully processed before the connection died.
      safeToRetry: false,
    };
  }

  const parsed = parseJson(rawBody);

  if (!response.ok) {
    const detail = truncate(redact(describeBody(parsed, rawBody), token));
    console.error("Shippo request failed", { path: request.path, status: response.status, detail });
    return {
      ok: false,
      kind: response.status >= 500 ? "server_error" : "rejected",
      message: messageForStatus(response.status),
      status: response.status,
      detail: detail || undefined,
      safeToRetry: isSafeToRetryStatus(response.status),
    };
  }

  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    console.error("Shippo returned an unreadable body", { path: request.path, status: response.status });
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo returned a response we could not read.",
      status: response.status,
      // A 2xx we cannot parse almost certainly means the action succeeded.
      safeToRetry: false,
    };
  }

  return { ok: true, data: parsed as T };
}

// ------------------------------------------------------------- shipments ----

export interface CreateShipmentInput {
  addressFrom: ShippoAddress;
  addressTo: ShippoAddress;
  parcel: ShippoParcel;
  /**
   * Printed as the return address, and where an undeliverable parcel goes.
   *
   * Shippo DEFAULTS this to address_from when omitted, which publishes the
   * ship-from address on every parcel. When the origin is a home address that
   * is a privacy leak, so callers pass this explicitly; the resolution and
   * fallback live in src/lib/shipping-origin.ts.
   */
  addressReturn?: ShippoAddress;
  /**
   * The Shippo ORDER this shipment belongs to.
   *
   * This is the field that makes the parcel visible when the owner opens the
   * order in Shippo's dashboard. A Shippo Order carries line items and
   * addresses but NO parcel; the parcel lives on a Shipment. Without this
   * link, Shippo builds its own empty Shipment when the order is opened and
   * asks for dimensions and weight by hand — which is the whole problem this
   * integration exists to avoid.
   */
  order?: string;
}

export interface ShipmentWithRates {
  shipmentId: string;
  /** Purchasable rates only, cheapest first. Never empty. */
  rates: ShippoRate[];
}

/**
 * Quote a shipment. Synchronous (`async: false`) because the admin is looking at
 * a spinner and needs the rates in this response, not a webhook later.
 *
 * Rates without a readable price are dropped rather than shown: postage must be
 * recorded in exact cents on purchase, so a rate we cannot price is a rate that
 * would fail at the till. Better to hide it than to let an admin pick it.
 */
export async function createShipmentWithRates(
  input: CreateShipmentInput,
): Promise<ShippoResult<ShipmentWithRates>> {
  const result = await shippoRequest<ShippoShipment>({
    method: "POST",
    path: "/shipments/",
    body: {
      address_from: input.addressFrom,
      address_to: input.addressTo,
      ...(input.addressReturn ? { address_return: input.addressReturn } : {}),
      ...(input.order ? { order: input.order } : {}),
      parcels: [input.parcel],
      async: false,
    },
  });
  if (!result.ok) return result;

  const shipment = result.data;
  const shipmentId = asNonEmptyString(shipment?.object_id);
  if (!shipmentId) {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo created a shipment without an id.",
      detail: describeMessages(shipment?.messages),
      safeToRetry: true,
    };
  }

  const priced = (Array.isArray(shipment.rates) ? shipment.rates : [])
    .map((rate) => ({ rate, cents: parseAmountToCents(rate?.amount) }))
    .filter((entry) => asNonEmptyString(entry.rate?.object_id) !== null && entry.cents !== null && entry.cents > 0)
    .sort((a, b) => (a.cents ?? 0) - (b.cents ?? 0))
    .map((entry) => entry.rate);

  if (priced.length === 0) {
    return {
      ok: false,
      kind: "no_rates",
      message: "Shippo returned no usable shipping rates. Check the delivery address and parcel size.",
      detail: describeMessages(shipment.messages),
      // Nothing was purchased; a corrected address can be quoted again.
      safeToRetry: true,
    };
  }

  return { ok: true, data: { shipmentId, rates: priced } };
}

// ------------------------------------------------------------------ label ----

export interface PurchaseLabelInput {
  /**
   * The FULL rate object from createShipmentWithRates, not just its id.
   *
   * Its `amount` is the only reliable source of what this label costs, and the
   * cost must be recorded in cents on every successful purchase. Taking the
   * whole object makes it impossible to reach this function without one.
   */
  rate: ShippoRate;
  labelFileType?: ShippoLabelFileType;
  /** Echoed back by Shippo — pass the Vanta order id so a label in Shippo's dashboard is traceable. */
  metadata?: string;
}

export interface PurchasedLabel {
  transactionId: string;
  rateId: string;
  trackingNumber: string;
  labelUrl: string;
  trackingUrlProvider: string | null;
  carrier: string | null;
  service: string | null;
  serviceToken: string | null;
  /** Exact postage in integer cents. Always > 0 — see the missing_cost guard. */
  postageCostCents: number;
  raw: ShippoTransaction;
}

/** The postage actually charged, when the transaction came back with an expanded rate. */
function settledCentsFromTransaction(rate: ShippoTransaction["rate"]): number | null {
  if (!rate || typeof rate === "string") return null;
  const cents = parseAmountToCents(rate.amount);
  return cents !== null && cents > 0 ? cents : null;
}

// purchaseLabel REMOVED — this application cannot buy postage.
//
// POST /transactions/ is the Shippo call that spends money. It is deleted
// rather than merely left uncalled: an unused function is one import away from
// being used again, and the guarantee the owner asked for is that Shippo's
// dashboard is the ONLY place a label can be bought.
//
// What remains here is read-only or refunding: quoting a shipment, creating an
// order record, reading a transaction back, and refunding one.


// ------------------------------------------------------------------ void ----

export interface VoidedLabel {
  refundId: string;
  transactionId: string;
  status: ShippoRefundStatus;
  /**
   * True while the carrier has accepted but not yet settled the refund (the
   * normal case for USPS). The charge WILL be reversed, so the caller should
   * clear the recorded postage cost now rather than waiting — otherwise profit
   * keeps a charge that no longer exists.
   */
  pending: boolean;
}

/**
 * Void a purchased label so the postage is refunded.
 *
 * QUEUED/PENDING count as success: carriers settle refunds asynchronously and
 * treating "accepted, not yet settled" as a failure would leave the admin
 * clicking void repeatedly on a label that is already being refunded.
 */
export async function voidLabel(transactionId: string): Promise<ShippoResult<VoidedLabel>> {
  const id = asNonEmptyString(transactionId);
  if (!id) {
    return {
      ok: false,
      kind: "rejected",
      message: "No Shippo transaction to void.",
      safeToRetry: false,
    };
  }

  const result = await shippoRequest<ShippoRefund>({
    method: "POST",
    path: "/refunds/",
    body: { transaction: id, async: false },
  });
  if (!result.ok) return result;

  const refund = result.data;
  const refundId = asNonEmptyString(refund?.object_id);
  const status = refund?.status;

  if (status === "ERROR" || !refundId) {
    return {
      ok: false,
      kind: "rejected",
      message: "Shippo could not void this label. It may already be refunded, or past the carrier's refund window.",
      detail: describeMessages(refund?.messages),
      transactionId: id,
      safeToRetry: false,
    };
  }

  return {
    ok: true,
    data: {
      refundId,
      transactionId: id,
      status: status ?? "QUEUED",
      pending: status !== "SUCCESS",
    },
  };
}

// ----------------------------------------------------------- transaction ----

/**
 * Read a transaction back.
 *
 * The recovery path for every `safeToRetry: false` purchase failure: it answers
 * "did that label actually print?" without spending anything.
 */
export async function getTransaction(transactionId: string): Promise<ShippoResult<ShippoTransaction>> {
  const id = asNonEmptyString(transactionId);
  if (!id) {
    return {
      ok: false,
      kind: "rejected",
      message: "No Shippo transaction id was provided.",
      safeToRetry: false,
    };
  }

  const result = await shippoRequest<ShippoTransaction>({
    method: "GET",
    path: `/transactions/${encodeURIComponent(id)}`,
  });
  if (!result.ok) return result;

  if (!asNonEmptyString(result.data?.object_id)) {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo returned a transaction without an id.",
      safeToRetry: true,
    };
  }

  return result;
}


// ------------------------------------------------------------------ orders ----

/**
 * Push a paid order into Shippo's Orders tab.
 *
 * This is what makes the owner's workflow possible: they open Shippo, see the
 * order already populated with the customer's address, the line items and the
 * computed parcel weight, and buy the label without retyping anything.
 *
 * Creating an order in Shippo NEVER buys postage and never costs money — it is
 * a record, not a purchase. That is why this is safe to call automatically on
 * payment while label purchase stays a deliberate human action.
 */
export async function purchaseLabel(input: PurchaseLabelInput): Promise<ShippoResult<PurchasedLabel>> {
  const rateId = asNonEmptyString(input?.rate?.object_id);
  if (!rateId) {
    return {
      ok: false,
      kind: "rejected",
      message: "No Shippo rate was selected for this label.",
      safeToRetry: true,
    };
  }

  const quotedCents = parseAmountToCents(input.rate?.amount);
  if (quotedCents === null || quotedCents <= 0) {
    return {
      ok: false,
      kind: "missing_cost",
      message: "That rate has no usable price, so the postage cost could not be recorded. Re-quote the shipment.",
      // Nothing was sent to Shippo — this check runs before the purchase.
      safeToRetry: true,
    };
  }

  const result = await shippoRequest<ShippoTransaction>({
    method: "POST",
    path: "/transactions/",
    body: {
      rate: rateId,
      label_file_type: input.labelFileType ?? "PDF_4x6",
      async: false,
      // Shippo caps metadata at 100 characters and rejects the whole purchase
      // when it is longer.
      ...(input.metadata ? { metadata: input.metadata.slice(0, 100) } : {}),
    },
  });
  if (!result.ok) return result;

  const transaction = result.data;
  const transactionId = asNonEmptyString(transaction?.object_id) ?? undefined;
  const detail = describeMessages(transaction?.messages);

  if (transaction?.status === "ERROR") {
    return {
      ok: false,
      kind: "purchase_failed",
      message: "Shippo could not buy this label.",
      detail,
      transactionId,
      // Shippo states outright that no postage was bought, so a retry is safe.
      safeToRetry: true,
    };
  }

  if (transaction?.status === "QUEUED" || transaction?.status === "WAITING") {
    return {
      ok: false,
      kind: "purchase_pending",
      message: "Shippo is still processing this label. Check again in a moment before trying anything else.",
      detail,
      transactionId,
      // A label may still print for this transaction — buying again would pay twice.
      safeToRetry: false,
    };
  }

  if (transaction?.status !== "SUCCESS") {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo returned an unexpected status for this label purchase.",
      detail: detail ?? `status=${String(transaction?.status ?? "")}`,
      transactionId,
      safeToRetry: false,
    };
  }

  const trackingNumber = asNonEmptyString(transaction.tracking_number);
  const labelUrl = asNonEmptyString(transaction.label_url);
  if (!transactionId || !trackingNumber || !labelUrl) {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo reported the label as purchased but did not return a label and tracking number.",
      detail,
      transactionId,
      // The postage was almost certainly charged: void it rather than re-buying.
      safeToRetry: false,
    };
  }

  return {
    ok: true,
    data: {
      transactionId,
      rateId,
      trackingNumber,
      labelUrl,
      trackingUrlProvider: asNonEmptyString(transaction.tracking_url_provider),
      carrier: asNonEmptyString(input.rate.provider),
      service: asNonEmptyString(input.rate.servicelevel?.name),
      serviceToken: asNonEmptyString(input.rate.servicelevel?.token),
      // Prefer what Shippo says it charged; fall back to the quote we validated
      // before buying. Both are the same rate, so they only differ if Shippo
      // repriced — in which case its own number is the one that hits the bill.
      postageCostCents: settledCentsFromTransaction(transaction.rate) ?? quotedCents,
      raw: transaction,
    },
  };
}

export async function createShippoOrder(input: ShippoOrderInput): Promise<ShippoResult<ShippoOrder>> {
  const result = await shippoRequest<ShippoOrder>({
    method: "POST",
    path: "/orders/",
    body: input as unknown as Record<string, unknown>,
  });
  if (!result.ok) return result;

  const orderId = asNonEmptyString(result.data?.object_id);
  if (!orderId) {
    // Without Shippo's order id there is no reliable way to match the label
    // purchase back to this order later, so an id-less success is a failure.
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo created an order without an id.",
      // NOT safe to retry: Shippo answered 2xx, so the order almost certainly
      // exists on their side. Retrying would create a second order for the same
      // purchase and the owner would see the same shipment twice in the Orders
      // tab, with no way to tell which one to buy the label against.
      safeToRetry: false,
    };
  }
  return { ok: true, data: { ...result.data, object_id: orderId } };
}

/** Read an order back, used to confirm a sync that timed out actually landed. */
export async function getShippoOrder(orderId: string): Promise<ShippoResult<ShippoOrder>> {
  return shippoRequest<ShippoOrder>({ method: "GET", path: `/orders/${encodeURIComponent(orderId)}` });
}
