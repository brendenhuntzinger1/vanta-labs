import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
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
  type FulfillmentStatus,
  type OrderStatusHistoryRecord,
  type TransitionSource,
} from "@/lib/order-pipeline";
import { createShipmentWithRates, purchaseLabel, voidLabel, type ShippoFailure } from "@/lib/shippo/client";
import {
  buildParcel,
  computeParcelWeightOz,
  hasStoredWeight as hasStoredWeightForLine,
  lineWeightOz,
  type ParcelLine,
} from "@/lib/shippo/parcel";
import { getDefaultPackagePreset, getPackagePresetById, listPackagePresets, type PackagePresetRecord } from "@/lib/shippo/packages";
import { getPackageRules, selectPresetForUnits } from "@/lib/shippo/package-rules";
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

export interface ShippoServiceFailure {
  ok: false;
  code: ShippoServiceErrorCode;
  /** One sentence, safe to show an admin. Never contains the API token. */
  message: string;
  detail?: string;
  /**
   * THE LABEL EXISTS AND WAS PAID FOR, even though this call failed.
   *
   * Set only by the two post-purchase failures (`db_error` after the buy,
   * `cost_unrecorded`). Its presence is the signal that money was spent: the
   * caller must audit the spend and must NOT retry.
   */
  label?: OrderLabel;
}

export type ServiceResult<T> = { ok: true; data: T } | ShippoServiceFailure;

// Deliberately no HTTP status here. The service says WHAT went wrong; how an
// HTTP client should read that is the route layer's business, and it owns the
// mapping (src/app/api/admin/orders/[orderId]/shipping/error-status.ts).
function fail(
  code: ShippoServiceErrorCode,
  message: string,
  extra: Partial<Omit<ShippoServiceFailure, "ok" | "code">> = {},
): ShippoServiceFailure {
  return { ok: false, code, message, ...extra };
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
  "shipping_address_2",
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

export interface OrderShippingRow {
  order_id: string;
  order_number: string | null;
  order_type: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_address: string | null;
  shipping_address_2: string | null;
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
export function orderDestinationAddress(order: OrderShippingRow): ShippoAddress {
  const country = toCountryCode(order.country);
  const rawState = String(order.state ?? "").trim();
  // "Texas" and "tx" both have to become "TX" — checkout offers a code list,
  // but browser autofill and imported orders do not.
  const state = country === "US" ? (normalizeUsState(rawState) ?? "") : rawState.toUpperCase().slice(0, 2);

  return {
    name: text(order.customer_name) ?? "",
    street1: text(order.shipping_address) ?? "",
    // Omitted when blank -- Shippo rejects an empty street2 rather than
    // treating it as absent.
    ...(text(order.shipping_address_2) ? { street2: String(order.shipping_address_2).trim() } : {}),
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

/**
 * Which box this order ships in.
 *
 * Precedence, most specific first:
 *   1. the package chosen ON THE ORDER -- a packer looking at the actual items
 *      is a better judge than any rule
 *   2. the unit-count rule (1-4 small, 5-10 medium, 11+ box, all editable)
 *   3. the account default
 *
 * Falling through to the default when a rule does not match is deliberate and
 * visible: the admin shows which package was chosen, so a 20-vial order about
 * to go in a small mailer is obvious before the label is bought.
 */
async function resolvePresetForOrder(
  order: OrderShippingRow,
  unitCount?: number,
): Promise<PackagePresetRecord | null> {
  if (order.package_preset_id) {
    const named = await getPackagePresetById(order.package_preset_id);
    if (named) return named;
  }

  if (typeof unitCount === "number" && unitCount > 0) {
    try {
      const [rules, presets] = await Promise.all([getPackageRules(), listPackagePresets()]);
      const byRule = selectPresetForUnits(unitCount, rules, presets);
      if (byRule) return byRule;
    } catch (error) {
      // A rule lookup failure must not block the shipment; the default still
      // produces a shippable parcel.
      console.error("Package rule lookup failed for order", order.order_id, error);
    }
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
  /** Merchandise only — sum(unit weight x quantity), excluding the box. */
  merchandiseOz: number;
  /** The box's tare, counted ONCE per parcel and never per line. */
  packagingOz: number;
  /**
   * At least one line fell back to the catalog default instead of a weight
   * stored against that SKU.
   *
   * Surfaced rather than silently accepted: the total is then a guess, and a
   * guess that buys real postage should be visible before the label is bought,
   * not discovered when a carrier bills an adjustment.
   */
  weightReviewRequired: boolean;
}

export interface OrderParcelLine {
  productId: string;
  name: string;
  quantity: number;
  unitWeightOz: number;
  lineWeightOz: number;
  /** False when this line used the catalog default instead of a stored weight. */
  hasStoredWeight: boolean;
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
  // `label` is selected alongside the weight so an UNWEIGHED liquid can be told
  // apart from an unweighed dry vial before the fallback is chosen. It is read
  // only when no weight is stored; a stored weight always wins.
  const doseLabels = new Map<string, string | null>();
  if (doseIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("product_doses")
      .select("id, shipping_weight_oz, label")
      .in("id", doseIds);
    if (error) {
      console.error("Unable to load dose shipping weights", error);
    }
    for (const row of data ?? []) {
      doseWeights.set(String(row.id), row.shipping_weight_oz == null ? null : Number(row.shipping_weight_oz));
      doseLabels.set(String(row.id), row.label == null ? null : String(row.label));
    }
  }

  const lines: ParcelLine[] = [];
  const detail: OrderParcelLine[] = [];
  for (const ref of refs) {
    const line: ParcelLine = {
      quantity: ref.quantity,
      doseWeightOz: ref.variantId ? doseWeights.get(ref.variantId) ?? null : null,
      productWeightOz: productWeights.get(ref.slug) ?? null,
      doseLabel: ref.variantId ? doseLabels.get(ref.variantId) ?? null : null,
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
      // A weight stored against the SKU (or inherited from its parent product)
      // is a real figure. Neither present means the line fell back to an
      // estimate, which makes the parcel total a guess.
      //
      // Uses the shared predicate rather than a null check: a stored 0 or a
      // negative is treated as MISSING by lineWeightOz(), so counting it as
      // "stored" here would report a fallback line as a real measurement.
      hasStoredWeight: hasStoredWeightForLine(line),
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

  // Unit count first: the packaging rule keys off how many units are in the
  // box, so the preset cannot be resolved until the items are known.
  const unitCount = ((items ?? []) as OrderItemRow[]).reduce(
    (total, item) => total + Math.max(0, Math.trunc(Number(item.quantity ?? 0))),
    0,
  );

  const [preset, weights] = await Promise.all([
    resolvePresetForOrder(order, unitCount),
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

  // Broken out so the admin can see WHICH half a surprising total came from.
  // A single number cannot distinguish "the vials are heavier than recorded"
  // from "the mailer tare is wrong", and those have different fixes.
  const merchandiseOz =
    Math.round(weights.detail.reduce((total, line) => total + line.lineWeightOz, 0) * 100) / 100;

  return {
    ok: true,
    data: {
      parcel: buildParcel(input),
      weightOz: computeParcelWeightOz(input),
      preset,
      lines: weights.detail,
      overridden: Number.isFinite(overrideValue) && overrideValue > 0,
      merchandiseOz,
      packagingOz: preset?.emptyWeightOz ?? 0,
      // Any line without a weight of its own makes the whole total an estimate.
      weightReviewRequired: weights.detail.some((line) => !line.hasStoredWeight),
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


/** Exposed for tests and for an admin "start over" action. */
export function clearQuotedRateCache(): void {
  quotedRates.clear();
}

async function quoteShipment(order: OrderShippingRow): Promise<ServiceResult<OrderRateQuote>> {
  const notShippable = assertShippable(order);
  if (notShippable) return notShippable;

  const addresses = await getShippingAddresses();
  if (!addresses.canRequestRates) {
    // The reason now comes from the resolver, because there are two of them:
    // an unusable ship-from address, and a missing customer-facing return
    // address. Reporting the second as "ship-from incomplete" sent the owner
    // to correct a field that was already right.
    return fail("origin_incomplete", addresses.blockedReason ?? "Shipping addresses are not configured.");
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
    // THE FIELD WHOSE ABSENCE PRINTS THE ORIGIN ON EVERY PARCEL.
    //
    // Omitting address_return does not mean "no return address" — Shippo
    // defaults it to address_from, and the rate bought from this shipment
    // carries that onto the physical label. order-sync.ts passed it; this
    // path, the one that actually buys the label, did not. So the ship-from
    // address was printed on every parcel a customer opens, which for a home
    // origin is the owner's residential address in a stranger's hands.
    addressReturn: toShippoAddress(addresses.returnAddress),
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
  /**
   * True when this call changed nothing — the label already existed (or was
   * already voided). A caller auditing a SPEND must skip these, or one purchase
   * shows up in the audit log as several.
   */
  reused: boolean;
}

function labelFromOrder(order: OrderShippingRow, reused: boolean): OrderLabel | null {
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
    reused,
  };
}

// --- the exactly-once claim ------------------------------------------------
//
// Identical in shape to claimInventoryRestock() in inventory-fulfillment.ts and
// the paid_side_effects_at claim in payment-webhook.ts, for the same reason:
// Postgres serializes two concurrent UPDATEs on one row, so with
// `where label_purchase_claimed_at is null` exactly one of them can match and
// return a row. Everyone else loses and must not call Shippo.



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



export interface PurchaseLabelRequest {
  orderId: string;
  selection: RateSelection;
  overrides?: ParcelOverrides;
  actor?: string | null;
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
/**
 * Turn "what the admin clicked" into the full rate object a purchase needs.
 *
 * The cached id is the fast path. A miss re-quotes and matches on
 * carrier + service token, which survives the quote expiring. Nothing here
 * spends money, so an unresolvable selection is a clean `rate_expired` with no
 * claim held and no charge.
 */
async function resolveSelectedRate(
  order: OrderShippingRow,
  selection: RateSelection,
): Promise<ServiceResult<ShippoRate>> {
  const wantedId = text(selection?.rateId);
  if (wantedId) {
    const cached = quotedRates.get(wantedId);
    // The orderId check is load bearing: a rate quoted for one order must never
    // be purchasable against another, or a cheap parcel buys a heavy one's
    // postage.
    if (cached && cached.orderId === order.order_id && cached.expiresAt > Date.now()) {
      return { ok: true, data: cached.rate };
    }
  }

  const quote = await quoteShipment(order);
  if (!quote.ok) return quote;

  const rates = quote.data.rates;
  if (wantedId) {
    const exact = rates.find((rate) => rate.object_id === wantedId);
    if (exact) return { ok: true, data: exact };
  }

  const wantedCarrier = text(selection?.carrier)?.toLowerCase();
  const wantedService = text(selection?.serviceToken)?.toLowerCase();
  if (wantedCarrier || wantedService) {
    const matched = rates.find(
      (rate) =>
        (!wantedCarrier || String(rate.provider ?? "").toLowerCase() === wantedCarrier) &&
        (!wantedService || String(rate.servicelevel?.token ?? "").toLowerCase() === wantedService),
    );
    if (matched) return { ok: true, data: matched };
  }

  // `cheapest` is honoured only when asked for explicitly — never as a silent
  // fallback, because quietly buying a different service than the one clicked
  // is how a customer paying for overnight gets ground.
  if (selection?.cheapest) {
    const cheapest = rates[0];
    if (cheapest) return { ok: true, data: cheapest };
  }

  return fail("rate_expired", "That shipping rate is no longer available. Re-quote and choose again.");
}

/**
 * The atomic claim. Exactly one caller per order gets through.
 *
 * Postgres serializes two concurrent UPDATEs on one row, so with
 * `where label_purchase_claimed_at is null` exactly one of them matches and
 * returns a row. Everyone else loses and must not call Shippo. Same shape as
 * claimInventoryRestock() and the paid_side_effects_at claim.
 */
async function claimLabelPurchase(orderId: string): Promise<"won" | "lost" | "error"> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ label_purchase_claimed_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("label_purchase_claimed_at", null)
    .select("order_id")
    .maybeSingle<{ order_id: string }>();

  if (error) {
    console.error("Unable to claim the label purchase for order", orderId, error);
    return "error";
  }
  return data ? "won" : "lost";
}

/**
 * Buy the postage for an order. THIS SPENDS MONEY, AT MOST ONCE.
 *
 * The order of operations is the whole design:
 *
 *   1. SHORT-CIRCUIT. A label already bought and not voided comes straight
 *      back with `reused: true`. This is what makes a refresh, a back-button
 *      re-submit and an HTTP retry free.
 *   2. RESOLVE THE RATE FIRST, before claiming. Resolution can fail, and
 *      failing while holding the claim would strand the order for no reason.
 *   3. CLAIM. One atomic UPDATE decides who may talk to Shippo.
 *   4. BUY, then persist, advance the status, record the exact postage.
 *   5. RELEASE ONLY ON A KNOWN-SAFE FAILURE. `safeToRetry` is Shippo's own
 *      statement that nothing was created. ANYTHING ELSE KEEPS THE CLAIM and
 *      raises an exception, so a human verifies before another cent is spent.
 *
 * NEVER call this from a webhook, a render, a queue entry or an automatic
 * retry. It is reachable only from an authenticated admin action.
 */
export async function purchaseLabelForOrder(
  request: PurchaseLabelRequest,
): Promise<ServiceResult<OrderLabel>> {
  const { orderId, selection, overrides, actor = null } = request;

  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;

  // 1. ALREADY BOUGHT.
  const existing = labelFromOrder(loaded.data, true);
  if (existing) return { ok: true, data: existing };

  const notShippable = assertShippable(loaded.data);
  if (notShippable) return notShippable;

  const applied = await applyParcelOverrides(loaded.data, overrides);
  if (!applied.ok) return applied;
  const order = applied.data.order;

  // A claim already held means a previous purchase's outcome is unknown. Never
  // buy over the top of that.
  if (text(order.label_purchase_claimed_at)) {
    return fail(
      "purchase_in_progress",
      "A label purchase for this order was started and its outcome is unconfirmed. Verify it before buying again.",
    );
  }

  // 2. RESOLVE THE RATE BEFORE CLAIMING.
  const resolved = await resolveSelectedRate(order, selection);
  if (!resolved.ok) return resolved;
  const rate = resolved.data;

  // 3. CLAIM.
  const claim = await claimLabelPurchase(order.order_id);
  if (claim === "error") {
    return fail("db_error", "Could not reserve this order for purchase. Nothing was bought.");
  }
  if (claim === "lost") {
    return fail("purchase_in_progress", "Another purchase for this order is already in progress.");
  }

  // 4. BUY.
  const bought = await purchaseLabel({
    rate,
    metadata: order.order_id,
    // Keyed on the ORDER, so a defeated local claim still cannot produce a
    // second transaction at Shippo.
    idempotencyKey: `vanta-label-${order.order_id}`,
  });

  if (!bought.ok) {
    if (bought.safeToRetry) {
      // 5a. Shippo says nothing was created. Safe to hand the claim back.
      await releaseLabelClaim(order.order_id);
      return fromShippoFailure(bought);
    }

    // 5b. AMBIGUOUS OR CHARGED. The claim STAYS. This order stops being normal
    // work and becomes an exception a human resolves — the alternative is
    // gambling a second postage charge on a guess.
    await recordSystemAlert({
      type: "shippo_label_unconfirmed",
      severity: "critical",
      message: `Label purchase for order ${order.order_id} did not confirm. Postage may have been charged.`,
      context: {
        orderId: order.order_id,
        actor,
        reason: bought.message,
        transactionId: "transactionId" in bought ? bought.transactionId ?? null : null,
      },
    });
    return fromShippoFailure(bought);
  }

  const label = bought.data;
  const now = new Date().toISOString();
  const transition = applyTransition({
    orderId: order.order_id,
    from: order.fulfillment_status,
    to: "label_purchased",
    source: "shippo",
  });

  const update: Record<string, unknown> = {
    shippo_transaction_id: label.transactionId,
    shippo_rate_id: label.rateId,
    shipping_carrier: label.carrier,
    shipping_service: label.service,
    tracking_number: label.trackingNumber || null,
    label_url: label.labelUrl || null,
    postage_cost_cents: label.postageCostCents,
    label_purchased_at: now,
    label_voided_at: null,
    updated_at: now,
  };
  // Monotonic, exactly as the webhook path is: a label bought for an order the
  // carrier has already scanned must not drag it backwards.
  if (transition.ok) update.fulfillment_status = transition.next;

  const { error } = await supabaseAdmin.from("orders").update(update).eq("order_id", order.order_id);
  if (error) {
    // POSTAGE WAS CHARGED and we could not record it. The label still travels
    // back so it can be printed; nothing about this invites a retry.
    console.error("Bought a Shippo label but could not update the order", order.order_id, error);
    await recordSystemAlert({
      type: "shippo_label_unsaved",
      severity: "critical",
      message: `Label for order ${order.order_id} was purchased at Shippo but not recorded on the order.`,
      context: { orderId: order.order_id, transactionId: label.transactionId },
    });
    return fail("db_error", "The label was purchased but the order could not be updated.", {
      label: {
        orderId: order.order_id,
        orderNumber: text(order.order_number) ?? order.order_id,
        transactionId: label.transactionId,
        rateId: label.rateId,
        carrier: label.carrier,
        service: label.service,
        trackingNumber: label.trackingNumber || null,
        trackingUrl: resolveCarrier(label.carrier, label.trackingNumber)?.trackingUrl ?? null,
        labelUrl: label.labelUrl || null,
        postageCostCents: label.postageCostCents,
        purchasedAt: now,
        fulfillmentStatus: String(order.fulfillment_status ?? ""),
        reused: false,
      } satisfies OrderLabel,
    });
  }

  if (transition.ok) {
    await recordStatusHistory(transition.history);
    await upsertShipment({
      orderId: order.order_id,
      carrier: label.carrier,
      trackingNumber: label.trackingNumber || null,
      status: transition.next,
    });
  }
  await recordActualShippingCost({
    orderId: order.order_id,
    amountCents: label.postageCostCents,
    source: "shippo",
  });

  return {
    ok: true,
    data: {
      orderId: order.order_id,
      orderNumber: text(order.order_number) ?? order.order_id,
      transactionId: label.transactionId,
      rateId: label.rateId,
      carrier: label.carrier,
      service: label.service,
      trackingNumber: label.trackingNumber || null,
      trackingUrl: resolveCarrier(label.carrier, label.trackingNumber)?.trackingUrl ?? null,
      labelUrl: label.labelUrl || null,
      postageCostCents: label.postageCostCents,
      purchasedAt: now,
      fulfillmentStatus: transition.ok ? transition.next : String(order.fulfillment_status ?? ""),
      reused: false,
    },
  };
}

/**
 * Reprint. Returns the SAME stored label and never touches Shippo — reprinting
 * is a printing problem, and a second call to /transactions/ is a second
 * charge. On success `labelUrl` is always a real URL; the no-file case is
 * reported as `no_label` rather than handing back a null to dereference.
 */
export async function getLabelUrlForOrder(orderId: string): Promise<ServiceResult<OrderLabel>> {
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
    // Deliberately NOT `{ label }` — that field means "postage was just spent
    // on this call", and this order's label was bought long ago.
    return fail("no_label", "This order has a Shippo transaction but no stored label file.");
  }
  return { ok: true, data: label };
}

/** Alias for call sites that read as "get the label", not "get its URL". */
export async function getLabelForOrder(orderId: string): Promise<ServiceResult<OrderLabel>> {
  return getLabelUrlForOrder(orderId);
}

export interface VoidedLabel extends OrderLabel {
  /**
   * The carrier accepted the refund but has not settled it — the normal case
   * for USPS. The charge WILL be reversed, so the recorded cost is cleared now
   * rather than later; waiting would leave profit carrying a charge that no
   * longer exists.
   */
  refundPending: boolean;
  /**
   * The label was already void when this call arrived: a double-click, not a
   * second void. Same value as the inherited `reused` — named for what it means
   * here, so an audit row reads honestly.
   */
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
): Promise<ServiceResult<VoidedLabel>> {
  const orderId = typeof orderIdOrRequest === "string" ? orderIdOrRequest : orderIdOrRequest.orderId;
  const actor = typeof orderIdOrRequest === "string" ? actorArg ?? null : orderIdOrRequest.actor ?? null;

  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;

  const order = loaded.data;
  const transactionId = text(order.shippo_transaction_id);
  if (!transactionId) {
    return fail("no_label", "There is no label on this order to void.");
  }

  /** The shape a voided label reports: no file, no tracking, no cost. */
  const voidedLabel = (refundPending: boolean, reused: boolean, fulfillmentStatus: string): VoidedLabel => ({
    orderId: order.order_id,
    orderNumber: text(order.order_number) ?? order.order_id,
    transactionId,
    rateId: text(order.shippo_rate_id),
    carrier: text(order.shipping_carrier),
    service: text(order.shipping_service),
    trackingNumber: null,
    trackingUrl: null,
    labelUrl: null,
    postageCostCents: null,
    purchasedAt: text(order.label_purchased_at),
    fulfillmentStatus,
    reused,
    refundPending,
    alreadyVoided: reused,
  });

  if (order.label_voided_at) {
    // Voiding twice is a double-click, not an error.
    return { ok: true, data: voidedLabel(false, true, String(order.fulfillment_status ?? "")) };
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
    data: voidedLabel(
      result.data.pending,
      false,
      transition.ok ? transition.next : String(order.fulfillment_status ?? ""),
    ),
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
 * Statuses that all mean the same thing to a customer: the carrier has it.
 *
 * `label_purchased` is deliberately absent: a printed label is not a shipped
 * parcel, and "your order is on its way" while it still sits on the packing
 * bench is the message customers write in about. The first email goes out when
 * the carrier has actually scanned it.
 */
const IN_CARRIER_NETWORK = new Set<FulfillmentStatus>(["shipped", "in_transit", "out_for_delivery"]);

export type ShippingNotification = "shipped" | "delivered";

/**
 * Which email, if any, a transition earns.
 *
 * Keyed on the MOVE, not the destination. Every status above used to earn its
 * own email, so an ordinary delivery sent four — "shipped", then "in transit",
 * then "out for delivery", then "delivered". The webhook dedupe cannot catch
 * that: those are four genuinely different scans, each legitimately processed
 * once. The customer just experiences it as spam.
 *
 * Entering the carrier network is one event no matter how many scans describe
 * it, so the shipping email fires on the transition INTO that set and never
 * again while the parcel moves through it. Delivery is its own, separate,
 * single message.
 *
 * A parcel that goes straight from label to delivered gets only the delivery
 * email, which is correct — being told it shipped after it arrived helps
 * nobody.
 */
export function notificationFor(
  from: FulfillmentStatus | string | null,
  to: FulfillmentStatus,
): ShippingNotification | null {
  if (to === "delivered") return "delivered";
  const wasInNetwork = IN_CARRIER_NETWORK.has(String(from ?? "") as FulfillmentStatus);
  if (IN_CARRIER_NETWORK.has(to) && !wasInNetwork) return "shipped";
  return null;
}

/**
 * A send that failed is queued, not lost.
 *
 * The order confirmation has always done this; the shipping and delivery
 * notices did not, so a transient provider outage silently cost the customer
 * their tracking email for good — the status had already advanced, so no later
 * scan would produce another one. Logging alone is not a retry.
 */
async function queueForRetry(
  to: string,
  template: { subject: string; html: string; text: string },
  error?: string,
): Promise<void> {
  console.error("Shipping notification not sent; queued for retry", to, error);
  await enqueueFailedEmail({ to, subject: template.subject, html: template.html, text: template.text }, error);
}

async function notifyCustomer(
  order: OrderShippingRow,
  from: FulfillmentStatus | string | null,
  next: FulfillmentStatus,
  trackingNumber: string | null,
): Promise<boolean> {
  const to = text(order.customer_email);
  const kind = notificationFor(from, next);
  if (!to || !kind) return false;

  const displayOrderId = text(order.order_number) ?? order.order_id;

  try {
    if (kind === "delivered") {
      const template = deliveryConfirmationTemplate({
        customerName: text(order.customer_name) ?? "",
        orderId: displayOrderId,
      });
      const result = await sendEmail({ to, ...template });
      if (!result.success) await queueForRetry(to, template, result.error);
      return true;
    }

    // The Track Package link goes to the CARRIER's own page, resolved through
    // the carrier allow-list — never a fulfilment provider's branded storefront,
    // and never echoing a carrier name we did not recognise. An unrecognised
    // carrier keeps the customer on Vanta Labs with no carrier named at all.
    const resolved = resolveCarrier(order.shipping_carrier, trackingNumber);
    const template = shippingUpdateTemplate({
      customerName: text(order.customer_name) ?? "",
      orderId: displayOrderId,
      status: FULFILLMENT_STATUS_LABELS[next],
      carrier: resolved?.name,
      trackingNumber: trackingNumber ?? undefined,
      trackingUrl: resolved?.trackingUrl ?? `${getSiteUrl()}/account/orders`,
    });
    const result = await sendEmail({ to, ...template });
    if (!result.success) await queueForRetry(to, template, result.error);
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

  const emailed = await notifyCustomer(order, transition.from, transition.next, effectiveTracking);

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
