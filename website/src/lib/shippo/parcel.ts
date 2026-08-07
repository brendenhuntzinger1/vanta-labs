import type { ShippoParcel } from "@/lib/shippo/types";

// -------------------------------------------------------------------------
// Parcel math: how much a Vanta Labs order weighs and what box it goes in.
//
// PURE on purpose — no DB, no network, no `server-only`. Everything it needs is
// passed in, so the one calculation that decides what postage we buy can be
// exhaustively unit-tested (parcel.test.ts) instead of only being exercised by
// spending money at Shippo. The caller loads the rows; this decides the numbers.
//
// The stakes are asymmetric and that shapes every fallback below: an
// OVER-declared parcel costs a few cents extra, while an UNDER-declared one is
// postage due, a returned package, and a customer waiting. Wherever the data is
// missing or nonsense, this errs heavy.
// -------------------------------------------------------------------------

/**
 * Packaged weight of one unit when neither the dose nor the product declares
 * one — matches the `products.shipping_weight_oz` column default so a product
 * row that predates the column behaves identically to one that has it.
 *
 * MUST STAY IN SYNC with the SQL default in
 * src/lib/sql/self-fulfillment-shippo.sql. If the two disagree, a product
 * inserted before the column existed rates differently from an identical one
 * inserted after — a discrepancy that only shows up as postage that quietly
 * does not match the catalog.
 *
 * 0.18 oz is the owner's figure for a 3ml peptide vial: 5 g, rounded UP from
 * 0.1764 so the declared weight never lands under the real one.
 *
 * NOT VERIFIED ON A SCALE. An empty 3ml glass vial with stopper and crimp is
 * commonly 8-12 g, so this may run light by roughly half. It is left as given
 * because at this magnitude even a five-vial order plus mailer stays inside
 * USPS Ground Advantage's first weight tier, where the price is identical
 * either way. Replace it with a measured value once stock arrives; the error
 * only starts costing money on larger orders.
 *
 * This is the ONE fallback that does not err heavy, deliberately: it is
 * MULTIPLIED by quantity, so padding it pushes multi-vial orders across a tier
 * boundary and overcharges every shipment. Per-parcel padding belongs on the
 * package preset's tare, which is added once — not here, where it compounds.
 */
export const DEFAULT_UNIT_WEIGHT_OZ = 0.18;

/**
 * Shippo rejects a parcel weighing zero or less with a validation error, which
 * would block the label entirely. A tenth of an ounce is the smallest weight
 * every carrier accepts.
 */
export const MIN_PARCEL_WEIGHT_OZ = 0.1;

export interface PackagePreset {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  emptyWeightOz: number;
}

/**
 * The seeded 'Standard Vanta Mailer' (9 × 6 × 3 in, 1.5 oz empty).
 *
 * Used when an order names no preset and no default row comes back. A missing
 * seed row must not be able to block a label — the owner packs everything in
 * this mailer anyway, so the honest fallback is its real dimensions rather than
 * a refusal or a zero-size parcel Shippo would reject.
 */
export const FALLBACK_PACKAGE_PRESET: PackagePreset = {
  lengthIn: 9,
  widthIn: 6,
  heightIn: 3,
  emptyWeightOz: 1.5,
};

/**
 * Numeric columns arrive from PostgREST as numbers, but a `numeric` can also
 * come back as a string depending on the driver and the client, and admin form
 * input is a string too. Accepting both here beats every call site remembering
 * to coerce — a forgotten `Number()` turns into string concatenation and a
 * 60-ounce parcel.
 */
export type NumericLike = number | string | null | undefined;

/**
 * A `shipping_package_presets` row, accepted in either casing so a raw Supabase
 * row can be handed straight over without a mapping layer to drift out of sync.
 */
export interface PackagePresetLike {
  lengthIn?: NumericLike;
  length_in?: NumericLike;
  widthIn?: NumericLike;
  width_in?: NumericLike;
  heightIn?: NumericLike;
  height_in?: NumericLike;
  emptyWeightOz?: NumericLike;
  empty_weight_oz?: NumericLike;
}

/**
 * One order line's shipping facts.
 *
 * `doseWeightOz` is the dose/variant's own packaged weight and wins when set;
 * null means "inherit the parent product", which is exactly what a null
 * `product_doses.shipping_weight_oz` means in the schema.
 */
export interface ParcelLine {
  quantity?: NumericLike;
  doseWeightOz?: NumericLike;
  productWeightOz?: NumericLike;
  /** snake_case aliases, so a joined row can be passed through unmapped. */
  dose_shipping_weight_oz?: NumericLike;
  product_shipping_weight_oz?: NumericLike;
}

export interface ParcelInput {
  /** The order's package_preset_id row, or the is_default row. */
  preset?: PackagePresetLike | null;
  items?: ParcelLine[] | null;
  /** `orders.parcel_weight_oz_override` — replaces the computed total entirely. */
  overrideOz?: NumericLike;
}

function toFiniteNumber(value: NumericLike): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A weight or dimension is only usable when it is a real positive number.
 *
 * Zero and negatives are treated as MISSING rather than honoured: a 0 in
 * `shipping_weight_oz` is a mis-typed row or an unfilled import, never a real
 * weightless vial, and honouring it would silently under-declare the parcel.
 */
function toPositiveNumber(value: NumericLike): number | null {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * Round to hundredths of an ounce — finer than any carrier's granularity, and
 * enough to keep binary float noise (1.5 + 2.1 + 2.1 = 5.699999999999999) out of
 * the payload and out of the admin UI. The epsilon nudge stops a value that is
 * one ULP below the midpoint from rounding the wrong way.
 */
function roundHundredths(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Wire format: a plain decimal with no trailing zeros ("9", "7.5", "0.1"). */
function formatDecimal(value: number): string {
  return String(roundHundredths(value));
}

/**
 * Quantities are whole units. A fractional, negative, missing or unparseable
 * quantity contributes nothing rather than throwing — matching
 * planInventoryAdjustments() in inventory-fulfillment.ts, so a line that moves
 * no stock also adds no weight.
 */
function normalizedQuantity(line: ParcelLine | null | undefined): number {
  const parsed = toFiniteNumber(line?.quantity);
  if (parsed === null) return 0;
  const whole = Math.trunc(parsed);
  return whole > 0 ? whole : 0;
}

/**
 * Resolve the box. Each field falls back independently to the standard mailer,
 * so a half-populated preset row (a dimension left null by an admin) still
 * produces a parcel Shippo will price instead of a 400.
 *
 * `emptyWeightOz` is the one field where 0 is legitimate — a preset can weigh
 * nothing worth counting — so it only falls back when the value is absent or
 * negative.
 */
export function resolvePackagePreset(preset?: PackagePresetLike | null): PackagePreset {
  const emptyWeight = toFiniteNumber(preset?.emptyWeightOz ?? preset?.empty_weight_oz);
  return {
    lengthIn: toPositiveNumber(preset?.lengthIn ?? preset?.length_in) ?? FALLBACK_PACKAGE_PRESET.lengthIn,
    widthIn: toPositiveNumber(preset?.widthIn ?? preset?.width_in) ?? FALLBACK_PACKAGE_PRESET.widthIn,
    heightIn: toPositiveNumber(preset?.heightIn ?? preset?.height_in) ?? FALLBACK_PACKAGE_PRESET.heightIn,
    emptyWeightOz:
      emptyWeight !== null && emptyWeight >= 0 ? emptyWeight : FALLBACK_PACKAGE_PRESET.emptyWeightOz,
  };
}

/**
 * Packaged weight of ONE unit of a line — dose weight, else product weight, else
 * the default. Multiply by the quantity to get the line's contribution; this
 * deliberately does not, so the per-unit figure can be shown in the admin UI
 * next to each item.
 */
export function lineWeightOz(line: ParcelLine | null | undefined): number {
  const dose = toPositiveNumber(line?.doseWeightOz ?? line?.dose_shipping_weight_oz);
  if (dose !== null) return dose;

  const product = toPositiveNumber(line?.productWeightOz ?? line?.product_shipping_weight_oz);
  if (product !== null) return product;

  return DEFAULT_UNIT_WEIGHT_OZ;
}

/**
 * Total declared weight in ounces: the empty package plus every unit in the box.
 *
 * The order-level override replaces the whole total — packaging included —
 * because it exists for the case where the owner put the order on a scale and
 * knows better than any computation. An override that is zero, negative or
 * unparseable is not an override, it is bad input, and falls back to the
 * computed weight rather than declaring a 0.1 oz parcel for a real shipment.
 */
export function computeParcelWeightOz(input: ParcelInput): number {
  const override = toPositiveNumber(input?.overrideOz);
  if (override !== null) {
    return Math.max(MIN_PARCEL_WEIGHT_OZ, roundHundredths(override));
  }

  const preset = resolvePackagePreset(input?.preset);
  // Packaging is added once for the parcel, never once per line — the order goes
  // in a single mailer.
  let total = preset.emptyWeightOz;
  for (const line of input?.items ?? []) {
    total += lineWeightOz(line) * normalizedQuantity(line);
  }

  return Math.max(MIN_PARCEL_WEIGHT_OZ, roundHundredths(total));
}

/**
 * The parcel exactly as Shippo wants it: preset dimensions in inches, computed
 * weight in ounces, everything as decimal strings.
 */
export function buildParcel(input: ParcelInput): ShippoParcel {
  const preset = resolvePackagePreset(input?.preset);
  return {
    length: formatDecimal(preset.lengthIn),
    width: formatDecimal(preset.widthIn),
    height: formatDecimal(preset.heightIn),
    distance_unit: "in",
    weight: formatDecimal(computeParcelWeightOz(input)),
    mass_unit: "oz",
  };
}
