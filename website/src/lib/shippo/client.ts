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
  /**
   * Extra headers. Exists for `Shippo-Idempotency-Key` on the one call that
   * spends money — see purchaseLabel(). Never used to override Authorization or
   * Content-Type, which are set after this spreads.
   */
  headers?: Record<string, string>;
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
        ...(request.headers ?? {}),
        // Set AFTER the spread so no caller can replace the credential or the
        // content type by passing a colliding key.
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
  /**
   * `Shippo-Idempotency-Key`, keyed on the ORDER rather than the request.
   *
   * The last line of defence: if the local claim were ever defeated — two
   * processes, a restored database, a hand-crafted request — Shippo returns the
   * transaction it already created for this key instead of charging twice.
   */
  idempotencyKey?: string;
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
export function settledCentsFromTransaction(rate: ShippoTransaction["rate"]): number | null {
  if (!rate || typeof rate === "string") return null;
  const cents = parseAmountToCents(rate.amount);
  return cents !== null && cents > 0 ? cents : null;
}

/**
 * Read a quoted rate back by id.
 *
 * A GET on /rates/<id>: it prices a rate that already exists and cannot buy
 * anything. This is the ONLY way to price a label bought in Shippo's dashboard,
 * whose transaction comes back with `rate` as a bare object_id reference rather
 * than an expanded object.
 */
export async function getRate(rateId: string): Promise<ShippoResult<ShippoRate>> {
  const id = asNonEmptyString(rateId);
  if (!id) {
    return {
      ok: false,
      kind: "rejected",
      message: "No Shippo rate id was provided.",
      safeToRetry: false,
    };
  }

  const result = await shippoRequest<ShippoRate>({
    method: "GET",
    path: `/rates/${encodeURIComponent(id)}`,
  });
  if (!result.ok) return result;

  if (!asNonEmptyString(result.data?.object_id)) {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Shippo returned a rate without an id.",
      safeToRetry: true,
    };
  }

  return result;
}

/**
 * WHAT A SETTLED TRANSACTION COST, FROM EITHER SHAPE SHIPPO SENDS.
 *
 * `rate` arrives expanded when WE bought the label, and as a bare object_id
 * string when the label was bought in Shippo's DASHBOARD — which is the owner's
 * normal workflow. The bare form carries no price, so every dashboard label
 * landed with no recorded postage, was classified "manual entry required" by
 * the repair sweep, and alerted an operator forever about a cost that Shippo
 * could have answered all along.
 *
 * A bare reference is not absence: it is an id, and an id can be read. One
 * extra GET, only on the shape that needs it, and only for a row that has no
 * cost recorded.
 *
 * Returns null only when the price genuinely cannot be established — never a 0,
 * which would silently overstate the margin instead of asking for a human.
 */
export async function settledCentsForTransaction(
  transaction: ShippoTransaction,
): Promise<number | null> {
  const expanded = settledCentsFromTransaction(transaction.rate);
  if (expanded !== null) return expanded;

  const rateId = typeof transaction.rate === "string" ? asNonEmptyString(transaction.rate) : null;
  if (!rateId) return null;

  const rate = await getRate(rateId);
  if (!rate.ok) return null;

  const cents = parseAmountToCents(rate.data.amount);
  return cents !== null && cents > 0 ? cents : null;
}

/**
 * BUY THE POSTAGE. The one call in this codebase that spends money.
 *
 * Restored deliberately (owner decision, recorded 2026-08) under the inverse of
 * the rule that removed it: there must be exactly ONE system that can buy a
 * label, and that system is now Vanta. Shippo's dashboard stays available for
 * recovery, but the normal day never opens it.
 *
 * FOUR LAYERS STAND BETWEEN A DOUBLE-CLICK AND A DOUBLE CHARGE, and this is
 * only the outermost:
 *
 *   1. purchaseLabelForOrder() short-circuits when a label already exists.
 *   2. An atomic claim on `label_purchase_claimed_at` lets exactly one caller
 *      through per order.
 *   3. `Shippo-Idempotency-Key`, below, keyed on the ORDER — so even if layers
 *      1 and 2 were both defeated, Shippo itself returns the first transaction
 *      instead of creating a second.
 *   4. Any ambiguous outcome keeps the claim and raises an exception rather
 *      than retrying.
 *
 * `async: false` makes Shippo settle the transaction before responding, so a
 * 2xx carries the real tracking number and label URL rather than a QUEUED stub
 * we would have to poll for.
 */
export async function purchaseLabel(input: PurchaseLabelInput): Promise<ShippoResult<PurchasedLabel>> {
  const rateId = asNonEmptyString(input?.rate?.object_id);
  if (!rateId) {
    return {
      ok: false,
      kind: "rejected",
      message: "No Shippo rate was selected for this label.",
      safeToRetry: false,
    };
  }

  // The quoted cost, captured BEFORE the call. If the response comes back
  // without an expanded rate we still know what we agreed to pay.
  const quotedCents = parseAmountToCents(input.rate.amount);

  const result = await shippoRequest<ShippoTransaction>({
    method: "POST",
    path: "/transactions/",
    headers: input.idempotencyKey ? { "Shippo-Idempotency-Key": input.idempotencyKey } : undefined,
    body: {
      rate: rateId,
      label_file_type: input.labelFileType ?? "PDF_4x6",
      async: false,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
  if (!result.ok) return result;

  const transaction = result.data;
  const transactionId = asNonEmptyString(transaction?.object_id);

  // A transaction that came back ERROR bought nothing, but one that came back
  // without an object_id is the dangerous shape: Shippo answered 2xx and we
  // cannot name what it created. Neither is safe to retry blindly.
  if (transaction?.status === "ERROR" || !transactionId) {
    return {
      ok: false,
      kind: transaction?.status === "ERROR" ? "rejected" : "invalid_response",
      message:
        transaction?.status === "ERROR"
          ? "Shippo could not buy this label."
          : "Shippo accepted the purchase but did not return a transaction id.",
      detail: describeMessages(transaction?.messages),
      // ERROR is a definitive "nothing was created"; a missing id is not.
      safeToRetry: transaction?.status === "ERROR",
    };
  }

  const labelUrl = asNonEmptyString(transaction.label_url);
  const trackingNumber = asNonEmptyString(transaction.tracking_number);
  const postageCostCents = settledCentsFromTransaction(transaction.rate) ?? quotedCents;

  // POSTAGE WAS CHARGED by this point. Everything below reports a real spend
  // whose record is incomplete — never a reason to buy again.
  if (postageCostCents === null || postageCostCents <= 0) {
    return {
      ok: false,
      kind: "missing_cost",
      message: "The label was purchased but Shippo did not report what it cost.",
      transactionId,
      safeToRetry: false,
    };
  }

  const expandedRate = typeof transaction.rate === "object" && transaction.rate !== null ? transaction.rate : null;

  return {
    ok: true,
    data: {
      transactionId,
      rateId,
      trackingNumber: trackingNumber ?? "",
      labelUrl: labelUrl ?? "",
      trackingUrlProvider: asNonEmptyString(transaction.tracking_url_provider) ?? null,
      carrier: expandedRate?.provider ?? input.rate.provider ?? null,
      service: expandedRate?.servicelevel?.name ?? input.rate.servicelevel?.name ?? null,
      serviceToken: expandedRate?.servicelevel?.token ?? input.rate.servicelevel?.token ?? null,
      postageCostCents,
      raw: transaction,
    },
  };
}
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
