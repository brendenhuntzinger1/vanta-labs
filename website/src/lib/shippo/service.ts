import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { recordSystemAlert } from "@/lib/monitoring";
import { deliveryConfirmationTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { resolveCarrier } from "@/lib/tracking-url";
import { getSiteUrl } from "@/lib/env";
import { normalizeUsState } from "@/lib/sales-tax";
import { parseOrderItemRef } from "@/lib/inventory-fulfillment";
import {
  FULFILLMENT_STATUS_LABELS,
  applyTransition,
  applyTrackingUpdate as applyPipelineTrackingUpdate,
  normalizeLegacyStatus,
  type FulfillmentStatus,
  type OrderStatusHistoryRecord,
  type TransitionSource,
} from "@/lib/order-pipeline";
import { createShipmentWithRates, purchaseLabel, voidLabel, type ShippoFailure } from "@/lib/shippo/client";
import { buildParcel, computeParcelWeightOz, lineWeightOz, type ParcelLine } from "@/lib/shippo/parcel";
import { getDefaultPackagePreset, getPackagePresetById, type PackagePresetRecord } from "@/lib/shippo/packages";
import { getShippingAddresses, type ShippingAddress } from "@/lib/shipping-origin";
import {
  SHIPPO_TRACK_UPDATED_EVENT,
  isShippoTrackingStatus,
  type ShippoAddress,
  type ShippoParcel,
  type ShippoRate,
  type ShippoWebhookPayload,
} from "@/lib/shippo/types";

// -------------------------------------------------------------------------
// The fulfillment service: everything the app asks of Shippo, in one place.
//
// Vanta Labs packs and ships every order itself, so this module is the whole
// shipping department — quote a parcel, buy the postage, reprint the label,
// void a mistake, and apply the carrier's scans as they arrive.
//
// Three rules run through all of it:
//
//   1. NOTHING THROWS. Every entry point returns a typed result carrying a
//      sentence an admin can act on and an HTTP status a route can return.
//      These are all reached from a dashboard click or an inbound webhook, and
//      an escaped exception is either a 500 in the owner's face or a Shippo
//      retry storm.
//   2. MONEY IS SPENT AT MOST ONCE. purchaseLabelForOrder holds an atomic
//      database claim across the entire window in which a purchase could
//      happen, and releases it only when Shippo has told us it did nothing.
//   3. A COST IS NEVER GUESSED. Postage is written in exact integer cents,
//      parsed from Shippo's own decimal string, or it is not written at all. A
//      stored 0 is indistinguishable from free shipping and would quietly
//      inflate profit, so "unknown" stays NULL and the UI renders "Pending".
// -------------------------------------------------------------------------

// ---------------------------------------------------------------- results ---

export type ShippoServiceErrorCode =
  /** No such order. */
  | "order_not_found"
  /** A membership or other non-physical order. There is nothing to put in a box. */
  | "not_shippable"
  /** The ship-from address in admin settings is missing carrier-required fields. */
  | "origin_incomplete"
  /** The order's delivery address is missing carrier-required fields. */
  | "destination_incomplete"
  /** SHIPPO_API_TOKEN is not set. */
  | "not_configured"
  /** Shippo quoted nothing — almost always a bad address or an impossible parcel. */
  | "no_rates"
  /** Shippo refused, failed, or could not be reached. */
  | "shippo_error"
  /** The chosen service is no longer quotable. Re-quote and pick again. NOTHING WAS BOUGHT. */
  | "rate_expired"
  /** Another caller holds the purchase claim right now. NOTHING WAS BOUGHT. */
  | "purchase_in_progress"
  /** The order has no label. */
  | "no_label"
  /** The label was voided; it must never be reprinted. */
  | "label_voided"
  /** A label exists but its cost could not be recorded — profit must NOT be finalized. */
  | "cost_unrecorded"
  /** A database write failed. */
  | "db_error"
  /** The caller passed something unusable. */
  | "invalid_request";

/**
 * HTTP status per failure, so every route answers the same way for the same
 * cause. The distinctions that matter: 409 is "the world is not in a state
 * where this can happen" (fix the address, re-quote, wait), 502 is "Shippo let
 * us down", 503 is "we are not configured", and 5xx generally means a retry is
 * reasonable while 4xx means it is not.
 */
const HTTP_STATUS_BY_CODE: Record<ShippoServiceErrorCode, number> = {
  invalid_request: 400,
  order_not_found: 404,
  no_label: 404,
  not_shippable: 409,
  origin_incomplete: 409,
  destination_incomplete: 409,
  label_voided: 409,
  rate_expired: 409,
  purchase_in_progress: 409,
  cost_unrecorded: 500,
  db_error: 500,
  no_rates: 502,
  shippo_error: 502,
  not_configured: 503,
};

export interface ShippoServiceFailure {
  ok: false;
  code: ShippoServiceErrorCode;
  /** One sentence, safe to show an admin. Never contains the API token. */
  message: string;
  /** Suggested HTTP status for a route handler. */
  status: number;
  detail?: string;
  /** The label, when one exists despite the failure — so it can still be printed. */
  label?: OrderLabel;
}

export type ServiceResult<T> = { ok: true; data: T } | ShippoServiceFailure;

function fail(
  code: ShippoServiceErrorCode,
  message: string,
  extra: Partial<Omit<ShippoServiceFailure, "ok" | "code">> = {},
): ShippoServiceFailure {
  return { ok: false, code, message, status: HTTP_STATUS_BY_CODE[code], ...extra };
}

/**
 * Translate a client failure into a service failure.
 *
 * `not_configured` and `no_rates` keep their own codes because the admin reacts
 * differently to each (set the token / fix the address); everything else is
 * "Shippo said no" as far as a caller is concerned.
 */
function fromShippoFailure(failure: ShippoFailure): ShippoServiceFailure {
  const code: ShippoServiceErrorCode =
    failure.kind === "not_configured" ? "not_configured" : failure.kind === "no_rates" ? "no_rates" : "shippo_error";
  return fail(code, failure.message, { detail: failure.detail });
}

// ------------------------------------------------------------------ order ---

const ORDER_COLUMNS = [
  "id",
  "order_id",
  "order_number",
  "order_type",
  "customer_name",
  "customer_email",
  "shipping_address",
  "city",
  "state",
  "postal_code",
  "country",
  "phone",
  "payment_status",
  "fulfillment_status",
  "tracking_number",
  "shippo_shipment_id",
  "shippo_transaction_id",
  "shippo_rate_id",
  "shipping_carrier",
  "shipping_service",
  "label_url",
  "label_purchased_at",
  "label_voided_at",
  "label_purchase_claimed_at",
  "postage_cost_cents",
  "package_preset_id",
  "parcel_weight_oz_override",
  "packed_at",
  "shipped_at",
  "delivered_at",
].join(", ");

interface OrderShippingRow {
  order_id: string;
  order_number: string | null;
  order_type: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
  payment_status: string | null;
  fulfillment_status: string | null;
  tracking_number: string | null;
  shippo_shipment_id: string | null;
  shippo_transaction_id: string | null;
  shippo_rate_id: string | null;
  shipping_carrier: string | null;
  shipping_service: string | null;
  label_url: string | null;
  label_purchased_at: string | null;
  label_voided_at: string | null;
  label_purchase_claimed_at: string | null;
  postage_cost_cents: number | null;
  package_preset_id: string | null;
  parcel_weight_oz_override: number | string | null;
  packed_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
}

function text(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return raw.length > 0 ? raw : null;
}

async function loadOrder(orderId: string): Promise<ServiceResult<OrderShippingRow>> {
  const id = String(orderId ?? "").trim();
  if (!id) {
    return fail("invalid_request", "No order was specified.");
  }

  const { data, error } = await supabaseAdmin.from("orders").select(ORDER_COLUMNS).eq("order_id", id).maybeSingle();
  if (error) {
    console.error("Unable to load order for shipping", id, error);
    return fail("db_error", "Could not load that order.");
  }
  if (!data) {
    return fail("order_not_found", "That order no longer exists.");
  }
  return { ok: true, data: data as unknown as OrderShippingRow };
}

/**
 * A membership is not a parcel. It carries no shipping address by design, and
 * quoting one produces a confusing Shippo validation error instead of the true
 * answer, which is that there is nothing to ship.
 */
function assertShippable(order: OrderShippingRow): ShippoServiceFailure | null {
  if (String(order.order_type ?? "product") === "membership") {
    return fail("not_shippable", "This is a membership order — there is nothing to ship.");
  }
  return null;
}

// -------------------------------------------------------------- addresses ---

/**
 * Country names as checkout stores them ("United States"), mapped to the ISO
 * alpha-2 codes Shippo requires. Only the two countries the store ships to are
 * listed; anything else resolves to "" and is reported as an incomplete
 * destination rather than guessed at. A wrong country code is not a rejected
 * label — it is a correctly-printed label for the wrong country.
 */
const COUNTRY_CODES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  canada: "CA",
  ca: "CA",
  can: "CA",
};

export function toCountryCode(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COUNTRY_CODES, key)) {
    return COUNTRY_CODES[key];
  }
  return /^[a-z]{2}$/i.test(raw) ? raw.toUpperCase() : "";
}

/** Both countries the store ships to require a state/province on the label. */
const COUNTRIES_REQUIRING_STATE = new Set(["US", "CA"]);

function toShippoAddress(address: ShippingAddress): ShippoAddress {
  return {
    name: address.name,
    ...(address.company ? { company: address.company } : {}),
    street1: address.street1,
    ...(address.street2 ? { street2: address.street2 } : {}),
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: toCountryCode(address.country) || "US",
    ...(address.phone ? { phone: address.phone } : {}),
    ...(address.email ? { email: address.email } : {}),
  };
}

/**
 * The order's delivery address as Shippo wants it.
 *
 * The buyer's EMAIL is deliberately not sent. Shippo can be configured to email
 * tracking notifications to the address on a shipment, and those messages are
 * Shippo-branded, not Vanta Labs — the customer's shipping mail comes from us
 * (notifyCustomer below) and only from us. The phone IS sent, because UPS and
 * FedEx refuse a shipment without one.
 */
function orderDestinationAddress(order: OrderShippingRow): ShippoAddress {
  const country = toCountryCode(order.country);
  const rawState = String(order.state ?? "").trim();
  // "Texas" and "tx" both have to become "TX" — checkout offers a code list,
  // but browser autofill and imported orders do not.
  const state = country === "US" ? (normalizeUsState(rawState) ?? "") : rawState.toUpperCase().slice(0, 2);

  return {
    name: text(order.customer_name) ?? "",
    street1: text(order.shipping_address) ?? "",
    city: text(order.city) ?? "",
    state,
    zip: text(order.postal_code) ?? "",
    country,
    ...(text(order.phone) ? { phone: String(order.phone).trim() } : {}),
  };
}

function validateDestination(address: ShippoAddress): string[] {
  const missing: string[] = [];
  if (!address.name) missing.push("name");
  if (!address.street1) missing.push("street address");
  if (!address.city) missing.push("city");
  if (!address.zip) missing.push("postal code");
  if (!address.country) missing.push("country");
  if (COUNTRIES_REQUIRING_STATE.has(address.country) && !address.state) missing.push("state");
  return missing;
}

// ----------------------------------------------------------------- parcel ---

/** Only real uuids may be sent to a uuid column — see loadItemWeights. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getPackagePresetForOrder(orderId: string): Promise<PackagePresetRecord | null> {
  const order = await loadOrder(orderId);
  if (!order.ok) return null;
  return resolvePresetForOrder(order.data);
}

async function resolvePresetForOrder(order: OrderShippingRow): Promise<PackagePresetRecord | null> {
  if (order.package_preset_id) {
    const named = await getPackagePresetById(order.package_preset_id);
    if (named) return named;
  }
  return getDefaultPackagePreset();
}

export interface OrderParcel {
  parcel: ShippoParcel;
  /** The declared total in ounces — the same number encoded in `parcel.weight`. */
  weightOz: number;
  preset: PackagePresetRecord | null;
  /** Per-line detail, so the admin UI can show where the weight came from. */
  lines: OrderParcelLine[];
  /** True when orders.parcel_weight_oz_override replaced the computed total. */
  overridden: boolean;
}

export interface OrderParcelLine {
  productId: string;
  name: string;
  quantity: number;
  unitWeightOz: number;
  lineWeightOz: number;
}

interface OrderItemRow {
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
}

/**
 * Resolve each line's per-unit weight: the dose's own value, else the parent
 * product's, else the module default — exactly the precedence parcel.ts
 * implements and parcel.test.ts pins.
 */
async function loadItemWeights(items: OrderItemRow[]): Promise<{ lines: ParcelLine[]; detail: OrderParcelLine[] }> {
  const refs = items.map((item) => {
    const productId = String(item.product_id ?? "");
    const { slug, variantId } = parseOrderItemRef(productId);
    return {
      productId,
      name: String(item.product_name ?? "Item"),
      quantity: Math.trunc(Number(item.quantity ?? 0)),
      slug,
      variantId,
    };
  });

  const slugs = [...new Set(refs.map((ref) => ref.slug).filter((slug) => slug.length > 0))];
  // A dose id is a uuid. Cart lines can carry other suffixes (membership rows
  // use "membership:<tier>"), and sending a non-uuid to a uuid column makes
  // PostgREST reject the WHOLE query — which would silently drop every dose
  // weight in the order and under-declare the parcel.
  const doseIds = [
    ...new Set(refs.map((ref) => ref.variantId).filter((id): id is string => !!id && UUID_PATTERN.test(id))),
  ];

  const productWeights = new Map<string, number | null>();
  if (slugs.length > 0) {
    const { data, error } = await supabaseAdmin.from("products").select("slug, shipping_weight_oz").in("slug", slugs);
    if (error) {
      console.error("Unable to load product shipping weights", error);
    }
    for (const row of data ?? []) {
      productWeights.set(String(row.slug), row.shipping_weight_oz == null ? null : Number(row.shipping_weight_oz));
    }
  }

  const doseWeights = new Map<string, number | null>();
  if (doseIds.length > 0) {
    const { data, error } = await supabaseAdmin.from("product_doses").select("id, shipping_weight_oz").in("id", doseIds);
    if (error) {
      console.error("Unable to load dose shipping weights", error);
    }
    for (const row of data ?? []) {
      doseWeights.set(String(row.id), row.shipping_weight_oz == null ? null : Number(row.shipping_weight_oz));
    }
  }

  const lines: ParcelLine[] = [];
  const detail: OrderParcelLine[] = [];
  for (const ref of refs) {
    const line: ParcelLine = {
      quantity: ref.quantity,
      doseWeightOz: ref.variantId ? doseWeights.get(ref.variantId) ?? null : null,
      productWeightOz: productWeights.get(ref.slug) ?? null,
    };
    lines.push(line);

    const unit = lineWeightOz(line);
    const quantity = ref.quantity > 0 ? ref.quantity : 0;
    detail.push({
      productId: ref.productId,
      name: ref.name,
      quantity,
      unitWeightOz: unit,
      lineWeightOz: Math.round(unit * quantity * 100) / 100,
    });
  }

  return { lines, detail };
}

/**
 * The parcel for an order: preset dimensions, plus every unit's weight and the
 * packaging tare — or the order-level override, which replaces the whole total.
 */
export async function buildOrderParcel(orderId: string): Promise<ServiceResult<OrderParcel>> {
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;
  return buildParcelForOrder(loaded.data);
}

async function buildParcelForOrder(order: OrderShippingRow): Promise<ServiceResult<OrderParcel>> {
  const notShippable = assertShippable(order);
  if (notShippable) return notShippable;

  const { data: items, error } = await supabaseAdmin
    .from("order_items")
    .select("product_id, product_name, quantity")
    .eq("order_id", order.order_id);
  if (error) {
    console.error("Unable to load order items for parcel", order.order_id, error);
    return fail("db_error", "Could not load the items on this order.");
  }

  const [preset, weights] = await Promise.all([
    resolvePresetForOrder(order),
    loadItemWeights((items ?? []) as OrderItemRow[]),
  ]);

  const input = {
    preset: preset
      ? {
          lengthIn: preset.lengthIn,
          widthIn: preset.widthIn,
          heightIn: preset.heightIn,
          emptyWeightOz: preset.emptyWeightOz,
        }
      : null,
    items: weights.lines,
    overrideOz: order.parcel_weight_oz_override,
  };

  const overrideValue = Number(order.parcel_weight_oz_override);

  return {
    ok: true,
    data: {
      parcel: buildParcel(input),
      weightOz: computeParcelWeightOz(input),
      preset,
      lines: weights.detail,
      overridden: Number.isFinite(overrideValue) && overrideValue > 0,
    },
  };
}

/**
 * A box/weight change the admin made in the shipping panel.
 *
 * `undefined` and `null` mean different things and both are honoured: absent
 * leaves the order's stored value alone, explicit null clears it back to "use
 * the default box / the computed weight".
 */
export interface ParcelOverrides {
  packagePresetId?: string | null;
  weightOverrideOz?: number | null;
}

async function applyParcelOverrides(
  order: OrderShippingRow,
  overrides: ParcelOverrides | undefined,
): Promise<ServiceResult<{ order: OrderShippingRow; changed: boolean }>> {
  if (!overrides) {
    return { ok: true, data: { order, changed: false } };
  }

  const update: Record<string, unknown> = {};
  const next: OrderShippingRow = { ...order };

  if (overrides.packagePresetId !== undefined) {
    const presetId = text(overrides.packagePresetId);
    if (presetId && !UUID_PATTERN.test(presetId)) {
      return fail("invalid_request", "That package selection is not valid.");
    }
    if (presetId !== text(order.package_preset_id)) {
      update.package_preset_id = presetId;
      next.package_preset_id = presetId;
    }
  }

  if (overrides.weightOverrideOz !== undefined) {
    const weight = overrides.weightOverrideOz;
    if (weight !== null && (!Number.isFinite(weight) || weight <= 0)) {
      return fail("invalid_request", "The parcel weight override must be a positive number of ounces.");
    }
    if (Number(weight ?? NaN) !== Number(order.parcel_weight_oz_override ?? NaN)) {
      update.parcel_weight_oz_override = weight;
      next.parcel_weight_oz_override = weight;
    }
  }

  if (Object.keys(update).length === 0) {
    return { ok: true, data: { order, changed: false } };
  }

  update.updated_at = new Date().toISOString();
  const { error } = await supabaseAdmin.from("orders").update(update).eq("order_id", order.order_id);
  if (error) {
    console.error("Unable to save parcel overrides", order.order_id, error);
    return fail("db_error", "Could not save the parcel settings for this order.");
  }

  return { ok: true, data: { order: next, changed: true } };
}

// ------------------------------------------------------------------ rates ---

export interface OrderRateQuote {
  shipmentId: string;
  /** Purchasable rates, cheapest first. Never empty. */
  rates: ShippoRate[];
  parcel: ShippoParcel;
  weightOz: number;
  preset: PackagePresetRecord | null;
}

/**
 * Quoted rates, remembered just long enough for the admin to click one.
 *
 * Buying a label needs the FULL rate object — its amount is what gets recorded
 * as postage — and this client has no "fetch rate by id". Rather than trust an
 * amount round-tripped through the browser (where it could be edited, and would
 * then be written into profit as fact), the quote is kept server-side and
 * looked up at purchase time.
 *
 * Entries are scoped to the order they were quoted for, so a rate id belonging
 * to one order can never buy postage for another. A miss is not fatal —
 * resolveSelectedRate re-quotes and matches on carrier + service — and it is
 * not a correctness risk either: a selection that cannot be resolved returns
 * `rate_expired` with no money spent and no claim held.
 */
const RATE_CACHE_TTL_MS = 20 * 60 * 1000;
const RATE_CACHE_MAX_ENTRIES = 500;
const quotedRates = new Map<string, { orderId: string; rate: ShippoRate; expiresAt: number }>();

function pruneRateCache(): void {
  const now = Date.now();
  for (const [key, entry] of quotedRates) {
    if (entry.expiresAt <= now) quotedRates.delete(key);
  }
  // Bounded, so a long-lived server process cannot grow this without limit.
  while (quotedRates.size > RATE_CACHE_MAX_ENTRIES) {
    const oldest = quotedRates.keys().next();
    if (oldest.done) break;
    quotedRates.delete(oldest.value);
  }
}

function cacheQuotedRates(orderId: string, rates: ShippoRate[]): void {
  const expiresAt = Date.now() + RATE_CACHE_TTL_MS;
  for (const rate of rates) {
    if (rate?.object_id) {
      quotedRates.set(rate.object_id, { orderId, rate, expiresAt });
    }
  }
  pruneRateCache();
}

function readCachedRate(orderId: string, rateId: string): ShippoRate | null {
  const entry = quotedRates.get(rateId);
  if (!entry) return null;
  if (entry.orderId !== orderId || entry.expiresAt <= Date.now()) return null;
  return entry.rate;
}

/** Exposed for tests and for an admin "start over" action. */
export function clearQuotedRateCache(): void {
  quotedRates.clear();
}

async function quoteShipment(order: OrderShippingRow): Promise<ServiceResult<OrderRateQuote>> {
  const notShippable = assertShippable(order);
  if (notShippable) return notShippable;

  const addresses = await getShippingAddresses();
  if (!addresses.canRequestRates) {
    return fail(
      "origin_incomplete",
      `The ship-from address is incomplete — add ${addresses.originValidation.missing.join(", ")} in Shipping settings before quoting rates.`,
    );
  }

  const destination = orderDestinationAddress(order);
  const missing = validateDestination(destination);
  if (missing.length > 0) {
    return fail("destination_incomplete", `This order's delivery address is missing ${missing.join(", ")}.`);
  }

  const parcel = await buildParcelForOrder(order);
  if (!parcel.ok) return parcel;

  const result = await createShipmentWithRates({
    addressFrom: toShippoAddress(addresses.origin),
    addressTo: destination,
    parcel: parcel.data.parcel,
  });
  if (!result.ok) return fromShippoFailure(result);

  cacheQuotedRates(order.order_id, result.data.rates);

  // Best-effort: a quote the admin can act on is worth more than a stored id.
  const { error } = await supabaseAdmin
    .from("orders")
    .update({ shippo_shipment_id: result.data.shipmentId, updated_at: new Date().toISOString() })
    .eq("order_id", order.order_id);
  if (error) {
    console.error("Unable to persist the Shippo shipment id", order.order_id, error);
  }

  return {
    ok: true,
    data: {
      shipmentId: result.data.shipmentId,
      rates: result.data.rates,
      parcel: parcel.data.parcel,
      weightOz: parcel.data.weightOz,
      preset: parcel.data.preset,
    },
  };
}

/**
 * Create the Shippo shipment for an order and return its purchasable rates.
 * Spends nothing.
 */
export async function quoteRatesForOrder(
  orderId: string,
  overrides?: ParcelOverrides,
): Promise<ServiceResult<OrderRateQuote>> {
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;

  const applied = await applyParcelOverrides(loaded.data, overrides);
  if (!applied.ok) return applied;

  return quoteShipment(applied.data.order);
}

/** Alias kept for callers that only ever quote with the order's stored settings. */
export async function getRatesForOrder(orderId: string): Promise<ServiceResult<OrderRateQuote>> {
  return quoteRatesForOrder(orderId);
}

/**
 * Which service the admin clicked.
 *
 * A Shippo rate id belongs to ONE shipment object and expires, so it cannot be
 * the only way to identify a choice — by the time a purchase lands, the quote
 * that produced the id may be gone. `carrier` + `serviceToken` survives a
 * re-quote and is what actually resolves the selection; the id is a fast path.
 */
export interface RateSelection {
  rateId?: string | null;
  /** Shippo's provider string: "USPS", "UPS", "FedEx". */
  carrier?: string | null;
  /** Shippo's servicelevel token, e.g. "usps_ground_advantage". */
  serviceToken?: string | null;
  /** Buy the cheapest quoted rate. Only honoured when explicitly asked for. */
  cheapest?: boolean;
}

/**
 * Turn a selection into the full rate object a purchase needs.
 *
 * Cache first (the normal path — the admin buys seconds after quoting), then a
 * fresh quote matched by id, then by carrier + service, then — only if asked —
 * the cheapest. If nothing matches, the honest answer is "re-quote": guessing
 * would buy a different service than the one that was clicked, at a price
 * nobody saw.
 *
 * Every branch here is free of side effects at Shippo beyond creating a
 * shipment object, and it all runs BEFORE the purchase claim is taken, so a
 * failure never strands the order.
 */
async function resolveSelectedRate(
  order: OrderShippingRow,
  selection: RateSelection,
  forceRequote: boolean,
): Promise<ServiceResult<ShippoRate>> {
  const rateId = text(selection?.rateId);
  const carrier = text(selection?.carrier);
  const serviceToken = text(selection?.serviceToken);
  const cheapest = selection?.cheapest === true;

  if (!rateId && !serviceToken && !cheapest) {
    return fail("invalid_request", "Pick a shipping service before buying a label.");
  }

  // A changed box or weight invalidates the cached quote: it priced a different
  // parcel, and buying it would pay for a package we are not sending.
  if (!forceRequote && rateId) {
    const cached = readCachedRate(order.order_id, rateId);
    if (cached) return { ok: true, data: cached };
  }

  const quote = await quoteShipment(order);
  if (!quote.ok) return quote;
  const rates = quote.data.rates;

  if (rateId) {
    const byId = rates.find((rate) => rate.object_id === rateId);
    if (byId) return { ok: true, data: byId };
  }

  if (serviceToken) {
    const token = serviceToken.toLowerCase();
    const provider = carrier?.toLowerCase() ?? null;
    const byCarrierAndService = rates.find(
      (rate) =>
        String(rate.servicelevel?.token ?? "").toLowerCase() === token &&
        (!provider || String(rate.provider ?? "").toLowerCase() === provider),
    );
    if (byCarrierAndService) return { ok: true, data: byCarrierAndService };

    // Service tokens are already carrier-specific ("usps_priority"), so a token
    // match with a mismatched provider string is a naming quirk, not a
    // different service.
    const byService = rates.find((rate) => String(rate.servicelevel?.token ?? "").toLowerCase() === token);
    if (byService) return { ok: true, data: byService };
  }

  if (cheapest) {
    // The client returns rates sorted cheapest-first and never returns an empty
    // list on success.
    return { ok: true, data: rates[0] };
  }

  return fail(
    "rate_expired",
    "That shipping service is no longer being quoted for this parcel. Fetch rates again and choose one.",
  );
}

// ------------------------------------------------------------------ label ---

export interface OrderLabel {
  orderId: string;
  orderNumber: string;
  transactionId: string;
  rateId: string | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  /** The carrier's own tracking page, or null when the carrier is unrecognised. */
  trackingUrl: string | null;
  labelUrl: string | null;
  /** Exact postage in integer cents, or null when unknown. NEVER 0 for "unknown". */
  postageCostCents: number | null;
  purchasedAt: string | null;
  fulfillmentStatus: string;
  /** True when this call bought nothing — the label already existed. */
  alreadyPurchased: boolean;
}

function labelFromOrder(order: OrderShippingRow, alreadyPurchased: boolean): OrderLabel | null {
  const transactionId = text(order.shippo_transaction_id);
  if (!transactionId || order.label_voided_at) return null;

  const trackingNumber = text(order.tracking_number);
  return {
    orderId: order.order_id,
    orderNumber: text(order.order_number) ?? order.order_id,
    transactionId,
    rateId: text(order.shippo_rate_id),
    carrier: text(order.shipping_carrier),
    service: text(order.shipping_service),
    trackingNumber,
    trackingUrl: resolveCarrier(order.shipping_carrier, trackingNumber)?.trackingUrl ?? null,
    labelUrl: text(order.label_url),
    postageCostCents: order.postage_cost_cents == null ? null : Number(order.postage_cost_cents),
    purchasedAt: text(order.label_purchased_at),
    fulfillmentStatus: String(order.fulfillment_status ?? ""),
    alreadyPurchased,
  };
}

// --- the exactly-once claim ------------------------------------------------
//
// Identical in shape to claimInventoryRestock() in inventory-fulfillment.ts and
// the paid_side_effects_at claim in payment-webhook.ts, for the same reason:
// Postgres serializes two concurrent UPDATEs on one row, so with
// `where label_purchase_claimed_at is null` exactly one of them can match and
// return a row. Everyone else loses and must not call Shippo.

type ClaimOutcome = "won" | "lost" | "error";

async function claimLabelPurchase(orderId: string): Promise<ClaimOutcome> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ label_purchase_claimed_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("label_purchase_claimed_at", null)
    .select("id");
  if (error) {
    console.error("Label purchase claim failed for order", orderId, error);
    // Fail CLOSED. An unknown claim state must never read as "go ahead and
    // buy": under-buying is a retry, double-buying is money.
    return "error";
  }
  return data && data.length > 0 ? "won" : "lost";
}

/**
 * Hand the claim back so a genuine retry can proceed.
 *
 * ONLY safe when Shippo has told us it did nothing (ShippoFailure.safeToRetry).
 * After a timeout or a 5xx the label may well have printed, and releasing would
 * let the next click buy a second one.
 */
async function releaseLabelClaim(orderId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("orders")
    .update({ label_purchase_claimed_at: null })
    .eq("order_id", orderId);
  if (error) {
    console.error("Unable to release the label purchase claim for order", orderId, error);
  }
}

/**
 * Deliberate, human-initiated release of a stuck claim.
 *
 * There is no automatic stale-claim sweep, and that is the point. A claim
 * outlives its request only when the purchase's outcome is genuinely unknown (a
 * timeout, a 5xx, a crashed process) — precisely the case where a label may
 * exist at Shippo that we never recorded. Auto-releasing that would buy the
 * second label this whole design exists to prevent. Freeing it is a decision
 * someone makes after looking at the Shippo dashboard, so it is an explicit
 * admin action with an alert behind it.
 */
export async function releaseLabelPurchaseClaim(orderId: string, actor?: string | null): Promise<ServiceResult<true>> {
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;

  const existing = labelFromOrder(loaded.data, true);
  if (existing) {
    return fail("invalid_request", "This order already has a label. Void it instead of releasing the claim.", {
      label: existing,
    });
  }

  await releaseLabelClaim(loaded.data.order_id);
  await recordSystemAlert({
    type: "shippo_claim_released",
    severity: "warning",
    message: `Label purchase claim manually released for order ${loaded.data.order_id}.`,
    context: { orderId: loaded.data.order_id, actor: actor ?? null },
  });
  return { ok: true, data: true };
}

/**
 * How long a loser waits for the winner's label before giving up.
 *
 * Covers the double-click, where the second request arrives milliseconds after
 * the first and the first is about to finish. A real Shippo purchase takes
 * seconds, so a genuinely concurrent second admin gets `purchase_in_progress`
 * instead — which is the correct answer, not a failure.
 */
const LOST_CLAIM_POLL_ATTEMPTS = 5;
const LOST_CLAIM_POLL_DELAY_MS = 40;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitExistingLabel(orderId: string): Promise<ServiceResult<OrderLabel>> {
  for (let attempt = 0; attempt < LOST_CLAIM_POLL_ATTEMPTS; attempt += 1) {
    const reloaded = await loadOrder(orderId);
    if (!reloaded.ok) return reloaded;

    const label = labelFromOrder(reloaded.data, true);
    if (label) return { ok: true, data: label };

    if (attempt < LOST_CLAIM_POLL_ATTEMPTS - 1) {
      await delay(LOST_CLAIM_POLL_DELAY_MS);
    }
  }

  return fail(
    "purchase_in_progress",
    "A label purchase for this order is already in progress. Refresh in a moment — nothing was bought twice.",
  );
}

export interface PurchaseLabelRequest {
  orderId: string;
  selection: RateSelection;
  overrides?: ParcelOverrides;
  actor?: string | null;
}

function normalizePurchaseRequest(
  orderIdOrRequest: string | PurchaseLabelRequest,
  rateId?: string,
  actor?: string | null,
): PurchaseLabelRequest {
  if (typeof orderIdOrRequest === "string") {
    return { orderId: orderIdOrRequest, selection: { rateId: rateId ?? null }, actor: actor ?? null };
  }
  return orderIdOrRequest;
}

/**
 * Buy the postage for an order. THIS SPENDS MONEY, AT MOST ONCE.
 *
 * Callable as `purchaseLabelForOrder(orderId, rateId, actor)` or with the full
 * request object when a box override or a carrier+service selection is in play.
 *
 * The order of operations is the whole design:
 *
 *   1. SHORT-CIRCUIT. A label already bought and not voided comes straight
 *      back. This is what makes a refresh, a back-button re-submit and an HTTP
 *      retry free.
 *   2. RESOLVE THE RATE FIRST, before claiming. Resolution can fail (expired
 *      quote, bad address), and failing while holding the claim would strand
 *      the order for no reason.
 *   3. CLAIM. One atomic UPDATE decides who may talk to Shippo. Losers wait
 *      briefly and return the winner's label.
 *   4. BUY, then persist, advance the status, and record the exact postage.
 *   5. RELEASE ONLY ON A KNOWN-SAFE FAILURE. `safeToRetry` is Shippo's own
 *      statement that nothing was created; anything else keeps the claim so a
 *      human checks before another cent is spent.
 */
export async function purchaseLabelForOrder(
  orderIdOrRequest: string | PurchaseLabelRequest,
  rateId?: string,
  actor?: string | null,
): Promise<ServiceResult<OrderLabel>> {
  const request = normalizePurchaseRequest(orderIdOrRequest, rateId, actor);

  const loaded = await loadOrder(request.orderId);
  if (!loaded.ok) return loaded;

  const notShippable = assertShippable(loaded.data);
  if (notShippable) return notShippable;

  // 1. Already bought. Checked before anything else so a duplicate request
  //    never even quotes, let alone purchases.
  const existing = labelFromOrder(loaded.data, true);
  if (existing) {
    return { ok: true, data: existing };
  }

  const applied = await applyParcelOverrides(loaded.data, request.overrides);
  if (!applied.ok) return applied;
  const order = applied.data.order;

  // 2. Resolve the rate before taking the claim.
  const rate = await resolveSelectedRate(order, request.selection ?? {}, applied.data.changed);
  if (!rate.ok) return rate;

  // 3. Claim.
  const claim = await claimLabelPurchase(order.order_id);
  if (claim === "error") {
    return fail("db_error", "Could not reserve this order for a label purchase. Nothing was bought — try again.");
  }
  if (claim === "lost") {
    return awaitExistingLabel(order.order_id);
  }

  // 4. Buy.
  const purchase = await purchaseLabel({
    rate: rate.data,
    labelFileType: "PDF_4x6",
    metadata: text(order.order_number) ?? order.order_id,
  });

  if (!purchase.ok) {
    if (purchase.safeToRetry) {
      await releaseLabelClaim(order.order_id);
    } else {
      // The outcome is unknown and the claim STAYS. Say so loudly: this is the
      // one state a human has to resolve, and silence here is how an order sits
      // unshipped for a week.
      await recordSystemAlert({
        type: "shippo_label_uncertain",
        severity: "critical",
        message: `Label purchase for order ${order.order_id} failed with an unknown outcome — a label may exist at Shippo.`,
        context: {
          orderId: order.order_id,
          transactionId: purchase.transactionId ?? null,
          kind: purchase.kind,
          detail: purchase.detail ?? null,
        },
      });
    }
    return fromShippoFailure(purchase);
  }

  const bought = purchase.data;
  const now = new Date().toISOString();

  // Defensive: the client refuses to return success without a positive cost, so
  // this cannot normally fire. If it ever does, the label is real and must stay
  // usable — but the cost is UNKNOWN, and unknown is NULL, never 0.
  const postageCostCents =
    Number.isSafeInteger(bought.postageCostCents) && bought.postageCostCents > 0 ? bought.postageCostCents : null;

  const transition = applyTransition({
    orderId: order.order_id,
    from: order.fulfillment_status,
    to: "label_purchased",
    source: "system",
    actor: request.actor ?? null,
  });

  const update: Record<string, unknown> = {
    shippo_transaction_id: bought.transactionId,
    shippo_rate_id: bought.rateId,
    shipping_carrier: bought.carrier,
    shipping_service: bought.service,
    tracking_number: bought.trackingNumber,
    label_url: bought.labelUrl,
    label_purchased_at: now,
    label_voided_at: null,
    postage_cost_cents: postageCostCents,
    updated_at: now,
  };
  // A rejected transition is not a failed purchase: an order already marked
  // shipped by hand keeps its status and still gets its label recorded.
  if (transition.ok) {
    update.fulfillment_status = transition.next;
  }

  const { error: updateError } = await supabaseAdmin.from("orders").update(update).eq("order_id", order.order_id);

  const label: OrderLabel = {
    orderId: order.order_id,
    orderNumber: text(order.order_number) ?? order.order_id,
    transactionId: bought.transactionId,
    rateId: bought.rateId,
    carrier: bought.carrier,
    service: bought.service,
    trackingNumber: bought.trackingNumber,
    trackingUrl: resolveCarrier(bought.carrier, bought.trackingNumber)?.trackingUrl ?? null,
    labelUrl: bought.labelUrl,
    postageCostCents,
    purchasedAt: now,
    fulfillmentStatus: transition.ok ? transition.next : String(order.fulfillment_status ?? ""),
    alreadyPurchased: false,
  };

  if (updateError) {
    // The postage is bought and paid for. The claim STAYS held so nothing buys
    // again, and the label travels back with the failure so it can still be
    // printed while someone repairs the row.
    console.error("Bought a Shippo label but could not persist it", order.order_id, updateError);
    await recordSystemAlert({
      type: "shippo_label_unsaved",
      severity: "critical",
      message: `Label bought for order ${order.order_id} but the order row could not be updated.`,
      context: { orderId: order.order_id, transactionId: bought.transactionId, labelUrl: bought.labelUrl },
    });
    return fail("db_error", "The label was purchased but could not be saved to the order. Do not buy another.", {
      label,
    });
  }

  if (transition.ok) {
    await recordStatusHistory(transition.history);
  }

  await upsertShipment({
    orderId: order.order_id,
    carrier: bought.carrier,
    trackingNumber: bought.trackingNumber,
    status: transition.ok ? transition.next : normalizeLegacyStatus(order.fulfillment_status) ?? "label_purchased",
  });

  // 5. Postage into profit, in exact cents.
  if (postageCostCents === null) {
    await recordSystemAlert({
      type: "shippo_cost_missing",
      severity: "critical",
      message: `Label bought for order ${order.order_id} with no usable postage amount — profit is NOT finalized.`,
      context: { orderId: order.order_id, transactionId: bought.transactionId },
    });
    return fail("cost_unrecorded", "The label was purchased but Shippo did not return a usable postage amount.", {
      label,
    });
  }

  const recorded = await recordActualShippingCost({
    orderId: order.order_id,
    amountCents: postageCostCents,
    source: "provider",
    changedBy: request.actor ?? null,
  }).catch((error: unknown) => {
    console.error("Unable to record actual shipping cost", order.order_id, error);
    return { ok: false as const, error: "Unhandled error" };
  });

  if (!recorded.ok) {
    // The label is good and the cost is on the order; only the profit
    // reconciliation missed. Report it rather than pretending, so a number
    // shown as "Finalized" is always one that actually was.
    await recordSystemAlert({
      type: "shippo_cost_unreconciled",
      severity: "warning",
      message: `Postage of ${postageCostCents} cents for order ${order.order_id} was not reconciled into profit.`,
      context: { orderId: order.order_id, error: recorded.error ?? null },
    });
  }

  return { ok: true, data: label };
}

/** A label that is definitely printable — labelUrl is non-null. */
export interface PrintableLabel extends OrderLabel {
  labelUrl: string;
}

/**
 * Reprint. Returns the SAME stored label and never touches Shippo — a second
 * purchase is not a printing problem, it is a second charge.
 */
export async function getLabelForOrder(orderId: string): Promise<ServiceResult<PrintableLabel>> {
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;

  const order = loaded.data;
  if (order.label_voided_at && order.shippo_transaction_id) {
    return fail("label_voided", "This label was voided and can no longer be used. Buy a new one.");
  }

  const label = labelFromOrder(order, true);
  if (!label) {
    return fail("no_label", "No shipping label has been purchased for this order yet.");
  }
  if (!label.labelUrl) {
    return fail("no_label", "This order has a Shippo transaction but no stored label file.", { label });
  }
  return { ok: true, data: { ...label, labelUrl: label.labelUrl } };
}

/** Same thing, named for the "give me the label URL" call site. */
export async function getLabelUrlForOrder(orderId: string): Promise<ServiceResult<PrintableLabel>> {
  return getLabelForOrder(orderId);
}

export interface VoidedOrderLabel {
  orderId: string;
  transactionId: string;
  /**
   * The carrier accepted the refund but has not settled it — the normal case
   * for USPS. The charge WILL be reversed, so the recorded cost is cleared now
   * rather than later; waiting would leave profit carrying a charge that no
   * longer exists.
   */
  refundPending: boolean;
  fulfillmentStatus: string;
  /** True when the label was already voided — a double-click, not an error. */
  alreadyVoided: boolean;
}

/**
 * Undo a label: refund the postage at Shippo, strip the tracking, take the
 * charge back out of profit and walk the order back to packed.
 *
 * The recorded cost is CLEARED rather than overwritten with 0. Zero is a real
 * value meaning "this shipment was free"; a voided label means the cost is
 * unknown again — the order falls back to its estimate and the UI shows
 * "Pending" until a new label is bought.
 */
export async function voidLabelForOrder(
  orderIdOrRequest: string | { orderId: string; actor?: string | null },
  actorArg?: string | null,
): Promise<ServiceResult<VoidedOrderLabel>> {
  const orderId = typeof orderIdOrRequest === "string" ? orderIdOrRequest : orderIdOrRequest.orderId;
  const actor = typeof orderIdOrRequest === "string" ? actorArg ?? null : orderIdOrRequest.actor ?? null;

  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;

  const order = loaded.data;
  const transactionId = text(order.shippo_transaction_id);
  if (!transactionId) {
    return fail("no_label", "There is no label on this order to void.");
  }
  if (order.label_voided_at) {
    return {
      ok: true,
      data: {
        orderId: order.order_id,
        transactionId,
        refundPending: false,
        fulfillmentStatus: String(order.fulfillment_status ?? ""),
        alreadyVoided: true,
      },
    };
  }

  const result = await voidLabel(transactionId);
  if (!result.ok) {
    return fromShippoFailure(result);
  }

  const now = new Date().toISOString();
  const transition = applyTransition({
    orderId: order.order_id,
    from: order.fulfillment_status,
    to: "packed",
    source: "system",
    actor,
  });

  const update: Record<string, unknown> = {
    label_voided_at: now,
    // A voided label must never print again — the carrier has been told this
    // parcel is not coming, and using it anyway is a shipping violation.
    label_url: null,
    tracking_number: null,
    postage_cost_cents: null,
    // Free the claim so a corrected label can be bought.
    label_purchase_claimed_at: null,
    updated_at: now,
  };
  if (transition.ok) {
    update.fulfillment_status = transition.next;
    // The parcel never moved, so any shipping timestamp is now untrue.
    update.shipped_at = null;
  }

  const { error } = await supabaseAdmin.from("orders").update(update).eq("order_id", order.order_id);
  if (error) {
    console.error("Voided a Shippo label but could not update the order", order.order_id, error);
    await recordSystemAlert({
      type: "shippo_void_unsaved",
      severity: "critical",
      message: `Label for order ${order.order_id} was voided at Shippo but the order row still shows it as live.`,
      context: { orderId: order.order_id, transactionId },
    });
    return fail("db_error", "The label was voided at Shippo but the order could not be updated.");
  }

  await reverseRecordedShippingCost(order.order_id, actor);

  if (transition.ok) {
    await recordStatusHistory(transition.history);
    await upsertShipment({
      orderId: order.order_id,
      carrier: null,
      trackingNumber: null,
      status: transition.next,
    });
  }

  return {
    ok: true,
    data: {
      orderId: order.order_id,
      transactionId,
      refundPending: result.data.pending,
      fulfillmentStatus: transition.ok ? transition.next : String(order.fulfillment_status ?? ""),
      alreadyVoided: false,
    },
  };
}

/**
 * Take a refunded postage charge back out of profit.
 *
 * A direct write rather than a call to recordActualShippingCost, because that
 * function cannot express "unknown": it clamps to >= 0 and sets
 * profit_finalized, so passing 0 would assert that this order's shipping
 * genuinely cost nothing. The ESTIMATE is left untouched, so profit falls back
 * to it exactly as it did before the label was ever bought.
 */
async function reverseRecordedShippingCost(orderId: string, actor?: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("orders")
    .update({
      actual_shipping_cost_cents: null,
      shipping_cost_source: null,
      shipping_cost_updated_at: now,
      profit_finalized: false,
      updated_at: now,
    })
    .eq("order_id", orderId);
  if (error) {
    console.error("Unable to reverse the recorded shipping cost", orderId, error);
    return;
  }

  // Best-effort audit row, so the reversal sits next to the charge it undoes
  // rather than the exact cost simply vanishing from the trail.
  await supabaseAdmin
    .from("order_shipping_cost_audit")
    .insert({
      order_id: orderId,
      exact_cost_cents: null,
      difference_cents: null,
      source: "manual",
      changed_by: actor ?? null,
      created_at: now,
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

// --------------------------------------------------------------- tracking ---

export interface TrackingUpdateOutcome {
  /** An order was found and the event was evaluated. */
  handled: boolean;
  /** This exact event has been seen before; nothing ran again. */
  duplicate: boolean;
  orderId: string | null;
  from: FulfillmentStatus | null;
  to: FulfillmentStatus | null;
  statusChanged: boolean;
  emailed: boolean;
  /** Why nothing changed, when nothing changed. */
  reason?: string;
}

function ignored(reason: string): ServiceResult<TrackingUpdateOutcome> {
  return {
    ok: true,
    data: {
      handled: false,
      duplicate: false,
      orderId: null,
      from: null,
      to: null,
      statusChanged: false,
      emailed: false,
      reason,
    },
  };
}

/**
 * A stable identity for one tracking event.
 *
 * Shippo delivers at least once and retries on any non-2xx, so the same scan
 * arrives repeatedly. Keying on (parcel, status, status_date) makes a
 * redelivery collide on the primary key of shippo_webhook_events and be dropped
 * before it can re-send a customer email, while a genuinely new scan (later
 * date, or a different status) still gets through.
 *
 * The transaction id is preferred over the tracking number because it is ours
 * and unique; carriers do eventually recycle tracking numbers.
 */
export function buildTrackingEventKey(payload: ShippoWebhookPayload): string | null {
  const data = payload?.data;
  const parcel = text(data?.transaction) ?? text(data?.tracking_number);
  const status = text(data?.tracking_status?.status);
  if (!parcel || !status) return null;

  const statusDate = text(data?.tracking_status?.status_date) ?? "";
  return `${parcel}:${status}:${statusDate}`.slice(0, 250);
}

async function recordStatusHistory(record: OrderStatusHistoryRecord): Promise<void> {
  const { error } = await supabaseAdmin
    .from("order_status_history")
    .insert({ ...record, created_at: new Date().toISOString() });
  if (error) {
    // The status write already landed; losing its audit row must not undo it.
    console.error("Unable to write order status history", record.order_id, error);
  }
}

async function upsertShipment(input: {
  orderId: string;
  carrier: string | null;
  trackingNumber: string | null;
  status: string;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("order_shipments").upsert(
    {
      order_id: input.orderId,
      carrier: input.carrier,
      tracking_number: input.trackingNumber,
      shipping_status: input.status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );
  if (error) {
    console.error("Unable to upsert the order shipment row", input.orderId, error);
  }
}

async function findOrderForTracking(
  transactionId: string | null,
  trackingNumber: string | null,
): Promise<OrderShippingRow | null> {
  // Both values are untrusted webhook text. They are only ever used as equality
  // filters (supabase-js encodes them), but they are still length-capped so a
  // megabyte-long "tracking number" cannot be turned into a query.
  const transaction = transactionId ? transactionId.slice(0, 120) : null;
  const tracking = trackingNumber ? trackingNumber.slice(0, 120) : null;

  if (transaction) {
    const { data } = await supabaseAdmin
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("shippo_transaction_id", transaction)
      .maybeSingle();
    if (data) return data as unknown as OrderShippingRow;
  }

  if (tracking) {
    const { data } = await supabaseAdmin
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("tracking_number", tracking)
      .maybeSingle();
    if (data) return data as unknown as OrderShippingRow;
  }

  return null;
}

/**
 * The statuses worth an email.
 *
 * `label_purchased` is deliberately absent: a printed label is not a shipped
 * parcel, and "your order is on its way" while it still sits on the packing
 * bench is the message customers write in about. The first email goes out when
 * the carrier has actually scanned it.
 */
const EMAILED_STATUSES = new Set<FulfillmentStatus>(["shipped", "in_transit", "out_for_delivery", "delivered"]);

async function notifyCustomer(
  order: OrderShippingRow,
  next: FulfillmentStatus,
  trackingNumber: string | null,
): Promise<boolean> {
  const to = text(order.customer_email);
  if (!to || !EMAILED_STATUSES.has(next)) return false;

  const displayOrderId = text(order.order_number) ?? order.order_id;

  try {
    if (next === "delivered") {
      await sendEmail({
        to,
        ...deliveryConfirmationTemplate({
          customerName: text(order.customer_name) ?? "",
          orderId: displayOrderId,
        }),
      });
      return true;
    }

    // The Track Package link goes to the CARRIER's own page, resolved through
    // the carrier allow-list — never a fulfilment provider's branded storefront,
    // and never echoing a carrier name we did not recognise. An unrecognised
    // carrier keeps the customer on Vanta Labs with no carrier named at all.
    const resolved = resolveCarrier(order.shipping_carrier, trackingNumber);
    await sendEmail({
      to,
      ...shippingUpdateTemplate({
        customerName: text(order.customer_name) ?? "",
        orderId: displayOrderId,
        status: FULFILLMENT_STATUS_LABELS[next],
        carrier: resolved?.name,
        trackingNumber: trackingNumber ?? undefined,
        trackingUrl: resolved?.trackingUrl ?? `${getSiteUrl()}/account/orders`,
      }),
    });
    return true;
  } catch (error) {
    // The status change already persisted; a failed notification must not undo
    // it or make Shippo retry the event.
    console.error("Unable to send the shipping notification", order.order_id, error);
    return false;
  }
}

/**
 * Apply one Shippo tracking webhook.
 *
 * Idempotent twice over: the event key stops a redelivered scan from running at
 * all, and the pipeline's terminal + no-regression rules stop an out-of-order
 * scan from moving a delivered order backwards. A customer only hears from us
 * when the status genuinely changed.
 *
 * Returns ok for everything it deliberately ignores, so the route can answer
 * 200 and stop Shippo retrying an event we are never going to want. Only a
 * database failure returns ok:false — that one IS worth a retry.
 */
export async function applyTrackingUpdate(payload: ShippoWebhookPayload): Promise<ServiceResult<TrackingUpdateOutcome>> {
  if (!payload || typeof payload !== "object") {
    return ignored("malformed_payload");
  }
  if (String(payload.event ?? "") !== SHIPPO_TRACK_UPDATED_EVENT) {
    return ignored("unsupported_event");
  }

  const data = payload.data ?? {};
  const rawStatus = data.tracking_status?.status;
  if (!isShippoTrackingStatus(rawStatus)) {
    // An unknown scan state is dropped rather than coerced onto the nearest
    // status: webhook bodies are untrusted, and a wrong guess writes a lie into
    // the order.
    return ignored("unknown_tracking_status");
  }

  const eventKey = buildTrackingEventKey(payload);
  if (!eventKey) {
    return ignored("unidentifiable_event");
  }

  const transactionId = text(data.transaction);
  const trackingNumber = text(data.tracking_number);

  // --- idempotency claim -------------------------------------------------
  const { error: claimError } = await supabaseAdmin
    .from("shippo_webhook_events")
    .insert({ event_key: eventKey, received_at: new Date().toISOString() });

  if (claimError) {
    if (String((claimError as { code?: string }).code ?? "") === "23505") {
      return {
        ok: true,
        data: {
          handled: false,
          duplicate: true,
          orderId: null,
          from: null,
          to: null,
          statusChanged: false,
          emailed: false,
          reason: "duplicate_event",
        },
      };
    }
    console.error("Unable to claim a Shippo webhook event", eventKey, claimError);
    return fail("db_error", "Could not record this tracking event.");
  }

  const order = await findOrderForTracking(transactionId, trackingNumber);
  if (!order) {
    // Release the claim. A scan can legitimately beat our own write of the
    // transaction id by a moment, and keeping the key would turn Shippo's retry
    // into a permanent no-op for an order that is about to exist.
    await releaseWebhookClaim(eventKey);
    return ignored("order_not_found");
  }

  const transition = applyPipelineTrackingUpdate({
    orderId: order.order_id,
    from: order.fulfillment_status,
    trackingStatus: rawStatus,
    actor: "shippo",
  });

  if (!transition.ok) {
    // "unchanged", "terminal" and "regression" are all normal for an
    // at-least-once, out-of-order feed. The event is marked processed so it is
    // never reconsidered, and nothing else happens — in particular, no email.
    await markEventProcessed(eventKey);
    return {
      ok: true,
      data: {
        handled: true,
        duplicate: false,
        orderId: order.order_id,
        from: transition.from,
        to: transition.to,
        statusChanged: false,
        emailed: false,
        reason: transition.reason,
      },
    };
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { fulfillment_status: transition.next, updated_at: now };

  if (trackingNumber && trackingNumber !== text(order.tracking_number)) {
    update.tracking_number = trackingNumber;
  }
  // Only fill a carrier we do not already have. The purchased rate's provider
  // ("USPS") is better data than the webhook's free text ("usps").
  if (!text(order.shipping_carrier) && text(data.carrier)) {
    update.shipping_carrier = text(data.carrier);
  }
  // The parcel is demonstrably in the carrier's hands from the first movement
  // scan onwards, so shipped_at is stamped once and never moved.
  if (!order.shipped_at && transition.next !== "returned") {
    update.shipped_at = now;
  }
  if (transition.next === "delivered") {
    update.delivered_at = now;
  }

  const { error: updateError } = await supabaseAdmin.from("orders").update(update).eq("order_id", order.order_id);
  if (updateError) {
    console.error("Unable to apply a tracking update", order.order_id, updateError);
    // Leave the event unprocessed AND release the key, so Shippo's retry can
    // genuinely re-run it.
    await releaseWebhookClaim(eventKey);
    return fail("db_error", "Could not apply this tracking update to the order.");
  }

  await recordStatusHistory(transition.history);

  const effectiveTracking = trackingNumber ?? text(order.tracking_number);
  await upsertShipment({
    orderId: order.order_id,
    carrier: text(order.shipping_carrier) ?? text(data.carrier),
    trackingNumber: effectiveTracking,
    status: transition.next,
  });

  const emailed = await notifyCustomer(order, transition.next, effectiveTracking);

  await markEventProcessed(eventKey);

  return {
    ok: true,
    data: {
      handled: true,
      duplicate: false,
      orderId: order.order_id,
      from: transition.from,
      to: transition.next,
      statusChanged: true,
      emailed,
    },
  };
}

async function releaseWebhookClaim(eventKey: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("shippo_webhook_events")
    .delete()
    .eq("event_key", eventKey)
    .is("processed_at", null);
  if (error) {
    console.error("Unable to release a Shippo webhook claim", eventKey, error);
  }
}

async function markEventProcessed(eventKey: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("shippo_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("event_key", eventKey);
  if (error) {
    // The row still exists and still blocks a duplicate, which is the part that
    // matters; only the "did it finish" signal is lost.
    console.error("Unable to mark a Shippo webhook event processed", eventKey, error);
  }
}

/**
 * Record a status change a human made, under the same rules the webhook path
 * obeys. Kept here so every write to fulfillment_status in the shipping flow
 * goes through one transition function and one history table.
 */
export async function setOrderFulfillmentStatus(input: {
  orderId: string;
  to: FulfillmentStatus | string;
  source?: TransitionSource;
  actor?: string | null;
}): Promise<ServiceResult<{ from: FulfillmentStatus; to: FulfillmentStatus }>> {
  const loaded = await loadOrder(input.orderId);
  if (!loaded.ok) return loaded;

  const order = loaded.data;
  const transition = applyTransition({
    orderId: order.order_id,
    from: order.fulfillment_status,
    to: input.to,
    source: input.source ?? "admin",
    actor: input.actor ?? null,
  });
  if (!transition.ok) {
    return fail("invalid_request", transition.message);
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { fulfillment_status: transition.next, updated_at: now };
  if (transition.next === "packed" && !order.packed_at) update.packed_at = now;
  if (transition.next === "shipped" && !order.shipped_at) update.shipped_at = now;

  const { error } = await supabaseAdmin.from("orders").update(update).eq("order_id", order.order_id);
  if (error) {
    console.error("Unable to set the fulfillment status", order.order_id, error);
    return fail("db_error", "Could not update this order's status.");
  }

  await recordStatusHistory(transition.history);
  return { ok: true, data: { from: transition.from, to: transition.next } };
}
